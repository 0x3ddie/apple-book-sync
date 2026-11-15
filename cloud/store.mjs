import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => value == null ? null : new Date(value).toISOString();
const transferReady = (row, now) => !row.revoked_at && row.transfer_seen_at != null
  && new Date(row.transfer_seen_at).getTime() > now.getTime() - 30_000;
export function syncState(apple, web, sourceDeviceId) {
  if (!web) return apple ? 'apple' : 'empty';
  const current = (marker) => marker && (!sourceDeviceId || marker.deviceId === sourceDeviceId);
  const applied = current(web.applied) ? web.applied : null;
  const delivered = current(web.delivered) ? web.delivered : null;
  const marker = applied ?? delivered;
  if (!marker) return 'pending';
  // An older snapshot can arrive after acknowledgement. Only subsequent Apple
  // reading takes over once this exact web revision has been applied.
  const baseline = marker.applePosition;
  return apple && baseline && apple.cfi !== baseline.cfi
    && Date.parse(apple.updatedAt) > Date.parse(baseline.updatedAt) ? 'apple' : applied ? 'synced' : 'sent';
}

function detail(row) {
  if (!row) throw new HttpError(404, 'Book not found.');
  const book = row.metadata;
  const web = row.web_position ?? null;
  const apple = book.applePosition;
  const state = syncState(apple, web, row.source_device_id);
  const resume = state === 'apple' ? apple : web ?? apple;
  return {
    id: row.book_id, title: book.title, author: book.author,
    progress: state === 'apple' ? book.progress : web?.percentage ?? book.progress,
    lastReadAt: [book.lastReadAt, web?.savedAt].filter(Boolean).sort().at(-1) ?? null,
    readable: false, availableOnMac: book.availableOnMac,
    unavailableReason: 'Save this book on this device before reading. EPUB files stay on your own devices.',
    coverUrl: null, epubUrl: null,
    appleBooksUrl: `ibooks://assetid/${encodeURIComponent(row.book_id)}`,
    applePosition: apple, webPosition: web,
    resume: { cfi: resume?.cfi ?? null, source: state === 'apple' ? 'apple' : web ? 'web' : apple ? 'apple' : 'start' },
    syncState: state, annotations: book.annotations,
    importedAt: iso(row.imported_at), sourceDeviceId: row.source_device_id,
  };
}

function device(row, now = new Date()) {
  return {
    id: row.id, name: row.name, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at), transferReady: transferReady(row, now),
  };
}

export class PostgresStore {
  constructor(pool, { now = () => new Date(), pairingCode = () => randomInt(1_000_000).toString().padStart(6, '0') } = {}) {
    this.pool = pool; this.now = now; this.pairingCode = pairingCode;
  }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async rows(owner, bookId, client = this.pool, lock = false) {
    const result = await client.query(`SELECT b.*, p.position AS web_position FROM books_library b
      LEFT JOIN books_positions p ON p.owner_id=b.owner_id AND p.book_id=b.book_id
      WHERE b.owner_id=$1 ${bookId === undefined ? '' : 'AND b.book_id=$2'} ${lock ? 'FOR UPDATE OF b' : ''}`,
    bookId === undefined ? [owner] : [owner, bookId]);
    return result.rows;
  }

  async library(owner) {
    const books = (await this.rows(owner)).map(detail).map((book) => {
      const { annotations, applePosition, webPosition, resume, epubUrl, appleBooksUrl, ...summary } = book;
      return summary;
    });
    books.sort((a, b) => (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '') || a.title.localeCompare(b.title));
    const devices = await this.pool.query('SELECT id,transfer_seen_at,revoked_at,covers_supported FROM books_devices WHERE owner_id=$1 AND revoked_at IS NULL', [owner]);
    const coverDevice = devices.rows.find((row) => row.covers_supported && transferReady(row, this.now()));
    return { books, refreshedAt: this.now().toISOString(), bridge: 'cloud',
      transferReady: devices.rows.some((row) => transferReady(row, this.now())),
      coversReady: !!coverDevice, coverDeviceId: coverDevice?.id ?? null };
  }

  async book(owner, bookId) { return detail((await this.rows(owner, bookId))[0]); }

  async savePosition(owner, bookId, value) {
    return this.transaction(async (client) => {
      const book = detail((await this.rows(owner, bookId, client, true))[0]);
      const previous = book.webPosition;
      if (previous?.clientId === value.clientId && value.sequence <= previous.sequence) {
        return { ok: true, position: previous, syncState: book.syncState, ignored: true };
      }
      if ((!previous || previous.clientId !== value.clientId) && value.baseRevision !== (previous?.revision ?? 0)) {
        throw new HttpError(409, 'Another reader saved a newer position. Choose where to continue.', { book });
      }
      const position = {
        cfi: value.cfi, savedAt: this.now().toISOString(), revision: (previous?.revision ?? 0) + 1,
        clientId: value.clientId, sequence: value.sequence, appleRevision: book.applePosition?.revision ?? null,
        href: value.href, percentage: value.percentage,
      };
      await client.query(`INSERT INTO books_positions (owner_id, book_id, position) VALUES ($1,$2,$3::jsonb)
        ON CONFLICT (owner_id, book_id) DO UPDATE SET position=EXCLUDED.position`, [owner, bookId, JSON.stringify(position)]);
      return { ok: true, position, syncState: 'pending' };
    });
  }

  async pairingLimit(key, maximum, windowMs) {
    const now = this.now();
    // This statement commits independently: a failed code claim must still count.
    await this.pool.query('DELETE FROM books_pairing_limits WHERE expires_at<=$1', [now]);
    const { rows } = await this.pool.query(`INSERT INTO books_pairing_limits (key_hash,attempts,expires_at)
      VALUES ($1,1,$2) ON CONFLICT (key_hash) DO UPDATE SET
      attempts=CASE WHEN books_pairing_limits.expires_at<=$3 THEN 1 ELSE LEAST(books_pairing_limits.attempts+1,$4) END,
      expires_at=CASE WHEN books_pairing_limits.expires_at<=$3 THEN EXCLUDED.expires_at ELSE books_pairing_limits.expires_at END
      RETURNING attempts,expires_at`, [hash(key), new Date(now.getTime() + windowMs), now, maximum + 1]);
    if (rows[0].attempts > maximum) {
      throw new HttpError(429, 'Too many pairing attempts. Wait a few minutes and try again.',
        { retryAfter: Math.max(1, Math.ceil((new Date(rows[0].expires_at).getTime() - now.getTime()) / 1000)) });
    }
  }

  async startPairing(name, ip) {
    await this.pairingLimit(`start-ip:${ip}`, 10, 600_000);
    const secret = `pair_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(this.now().getTime() + 300_000);
    return this.transaction(async (client) => {
      await client.query('DELETE FROM books_device_pairings WHERE expires_at<=$1', [this.now()]);
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = this.pairingCode();
        const { rows } = await client.query(`INSERT INTO books_device_pairings (secret_hash,code_hash,device_id,name,expires_at)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code_hash) DO NOTHING RETURNING device_id`,
        [hash(secret), hash(code), randomUUID(), name, expiresAt]);
        if (rows.length) return { code, secret, expiresAt: iso(expiresAt), interval: 3 };
      }
      throw new HttpError(503, 'Could not create a pairing code. Try again shortly.');
    });
  }

  async claimPairing(owner, code, ip) {
    await this.pairingLimit(`claim-ip:${ip}`, 20, 300_000);
    await this.pairingLimit(`claim-owner:${owner}`, 5, 300_000);
    const { rows } = await this.pool.query(`UPDATE books_device_pairings SET owner_id=$1
      WHERE code_hash=$2 AND expires_at>$3 AND owner_id IS NULL RETURNING name,device_id,expires_at`,
    [owner, hash(code), this.now()]);
    if (!rows.length) throw new HttpError(400, 'Pairing code is invalid, expired, or already used.');
    return { name: rows[0].name, deviceId: rows[0].device_id, expiresAt: iso(rows[0].expires_at), status: 'awaiting_mac' };
  }

  async pollPairing(secret) {
    return this.transaction(async (client) => {
      const { rows } = await client.query(`SELECT p.*,u.email FROM books_device_pairings p LEFT JOIN "user" u ON u.id=p.owner_id
        WHERE p.secret_hash=$1 AND p.expires_at>$2 FOR UPDATE OF p`, [hash(secret), this.now()]);
      if (!rows.length) throw new HttpError(401, 'Pairing expired or was already completed. Start again on your Mac.');
      const row = rows[0], now = this.now();
      if (new Date(row.expires_at) <= now) throw new HttpError(401, 'Pairing expired. Start again on your Mac.');
      if (row.last_polled_at && new Date(row.last_polled_at).getTime() > now.getTime() - 3000) {
        throw new HttpError(429, 'Wait before checking pairing again.', { retryAfter: 3 });
      }
      await client.query('UPDATE books_device_pairings SET last_polled_at=$2 WHERE secret_hash=$1', [hash(secret), now]);
      return { status: row.owner_id ? 'claimed' : 'pending', expiresAt: iso(row.expires_at),
        ...(row.owner_id ? { account: { id: row.owner_id, email: row.email } } : {}) };
    });
  }

  async completePairing(secret, accountId, approve) {
    return this.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM books_device_pairings WHERE secret_hash=$1 FOR UPDATE', [hash(secret)]);
      const row = rows[0];
      if (!row || new Date(row.expires_at) <= this.now()) throw new HttpError(401, 'Pairing expired or was already completed. Start again on your Mac.');
      if (!row.owner_id || row.owner_id !== accountId) throw new HttpError(409, 'The pairing account does not match. Check the account on your Mac again.');
      // Serialize replacement with other devices and recheck expiry after waiting for the account lock.
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [row.owner_id]);
      if (new Date(row.expires_at) <= this.now()) throw new HttpError(401, 'Pairing expired. Start again on your Mac.');
      await client.query('DELETE FROM books_device_pairings WHERE secret_hash=$1', [hash(secret)]);
      if (!approve) return { ok: true };
      const credential = `device_${randomBytes(32).toString('base64url')}`;
      await client.query('UPDATE books_devices SET revoked_at=$2 WHERE owner_id=$1 AND revoked_at IS NULL', [row.owner_id, this.now()]);
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1', [row.owner_id]);
      const result = await client.query(`INSERT INTO books_devices (id,owner_id,name,credential_hash,created_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [row.device_id, row.owner_id, row.name, hash(credential), this.now()]);
      return { device: device(result.rows[0], this.now()), credential };
    });
  }

  async authenticateDevice(credential) {
    const { rows } = await this.pool.query(`UPDATE books_devices SET last_seen_at=$2
      WHERE credential_hash=$1 AND revoked_at IS NULL RETURNING id,owner_id`, [hash(credential), this.now()]);
    if (!rows.length) throw new HttpError(401, 'Companion is not linked or has been revoked.');
    return { id: rows[0].id, owner: rows[0].owner_id };
  }

  async devices(owner) {
    const { rows } = await this.pool.query('SELECT * FROM books_devices WHERE owner_id=$1 ORDER BY created_at DESC', [owner]);
    return { devices: rows.map((row) => device(row, this.now())) };
  }

  async revokeDevice(owner, id) {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [owner]);
      const { rows } = await client.query('UPDATE books_devices SET revoked_at=COALESCE(revoked_at,$3) WHERE owner_id=$1 AND id=$2 RETURNING id', [owner, id, this.now()]);
      if (!rows.length) throw new HttpError(404, 'Device not found.');
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1 AND device_id=$2', [owner, id]);
      return { ok: true };
    });
  }

  async createTransfer(owner, value) {
    return this.transaction(async (client) => {
      // Serialize the per-account limit with simultaneous requests and Mac replacements.
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [owner]);
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1 AND expires_at<=$2', [owner, this.now()]);
      const book = (await client.query('SELECT source_device_id,metadata FROM books_library WHERE owner_id=$1 AND book_id=$2', [owner, value.bookId])).rows[0];
      if (!book) throw new HttpError(404, 'Book not found.');
      if (value.kind === 'covers') {
        const batch = await client.query('SELECT book_id,source_device_id FROM books_library WHERE owner_id=$1 AND book_id=ANY($2::text[])', [owner, value.bookIds]);
        if (batch.rows.length !== value.bookIds.length) throw new HttpError(404, 'One or more books were not found in your library.');
        if (batch.rows.some((row) => row.source_device_id !== book.source_device_id)) {
          throw new HttpError(409, 'Sync these books from the same linked Mac before loading their covers.');
        }
      } else if (!book.metadata.availableOnMac) throw new HttpError(409, 'Download this EPUB in Apple Books on your Mac first, then sync the library.');
      const source = (await client.query('SELECT id,transfer_seen_at,revoked_at,covers_supported FROM books_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE', [owner, book.source_device_id])).rows[0];
      if (!source || !transferReady(source, this.now())) throw new HttpError(503, 'Start transfers on your Mac, keep it awake, and connect both devices to the same Wi-Fi.');
      if (value.kind === 'covers' && !source.covers_supported) throw new HttpError(409, 'Update and restart your Mac companion to load book covers.');
      const count = await client.query('SELECT count(*)::int AS count FROM books_transfers WHERE owner_id=$1 AND error IS NULL', [owner]);
      if (count.rows[0].count >= 3) throw new HttpError(429, 'Finish or cancel another book download before starting this one.');
      const id = randomUUID(), expiresAt = new Date(this.now().getTime() + 180_000);
      await client.query(`INSERT INTO books_transfers (id,owner_id,book_id,device_id,offer,created_at,expires_at,kind,book_ids)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb)`,
      [id, owner, value.bookId, source.id, JSON.stringify(value.offer), this.now(), expiresAt,
        value.kind === 'covers' ? 'covers' : 'epub', value.kind === 'covers' ? JSON.stringify(value.bookIds) : null]);
      return { id, expiresAt: iso(expiresAt) };
    });
  }

  async transfer(owner, id) {
    const { rows } = await this.pool.query(`SELECT t.* FROM books_transfers t JOIN books_devices d ON d.owner_id=t.owner_id AND d.id=t.device_id
      WHERE t.owner_id=$1 AND t.id=$2 AND t.expires_at>$3 AND d.revoked_at IS NULL`, [owner, id, this.now()]);
    if (!rows.length) throw new HttpError(404, 'This transfer expired or was closed. Save the book again.');
    const row = rows[0];
    return { id: row.id, bookId: row.book_id, ...(row.kind === 'covers' ? { kind: 'covers' } : {}),
      status: row.error ? 'failed' : row.answer ? 'answered' : 'waiting', answer: row.answer, error: row.error, expiresAt: iso(row.expires_at) };
  }

  async closeTransfer(owner, id) {
    // Deletion is safe after expiry/revocation too, and never reveals another account's row.
    await this.pool.query('DELETE FROM books_transfers WHERE owner_id=$1 AND id=$2', [owner, id]);
    return { ok: true };
  }

  async pendingTransfers(identity, coversSupported = false) {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.owner]);
      const device = await client.query(`UPDATE books_devices SET transfer_seen_at=$3,covers_supported=$4
        WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [identity.owner, identity.id, this.now(), coversSupported]);
      if (!device.rows.length) throw new HttpError(401, 'Companion has been revoked.');
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1 AND expires_at<=$2', [identity.owner, this.now()]);
      const { rows } = await client.query(`SELECT id,book_id,offer,expires_at,kind,book_ids FROM books_transfers
        WHERE owner_id=$1 AND device_id=$2 AND answer IS NULL AND error IS NULL
        AND (kind='epub' OR (kind='covers' AND $3::boolean)) ORDER BY created_at LIMIT 3`, [identity.owner, identity.id, coversSupported]);
      return { transfers: rows.map((row) => ({ id: row.id, bookId: row.book_id,
        ...(row.kind === 'covers' ? { kind: 'covers', bookIds: row.book_ids } : {}), offer: row.offer, expiresAt: iso(row.expires_at) })) };
    });
  }

  async answerTransfer(identity, id, value) {
    const { rows } = await this.pool.query(`UPDATE books_transfers t SET answer=$4::jsonb,error=$5
      WHERE t.owner_id=$1 AND t.device_id=$2 AND t.id=$3 AND t.expires_at>$6 AND t.answer IS NULL AND t.error IS NULL
      AND EXISTS (SELECT 1 FROM books_devices d WHERE d.owner_id=t.owner_id AND d.id=t.device_id AND d.revoked_at IS NULL)
      RETURNING t.id`, [identity.owner, identity.id, id, value.answer ? JSON.stringify(value.answer) : null, value.error, this.now()]);
    if (!rows.length) throw new HttpError(404, 'Transfer was closed, answered, or expired.');
    return { ok: true };
  }

  async importSnapshot(identity, value) {
    return this.transaction(async (client) => {
      const { rows } = await client.query('SELECT snapshot_sequence FROM books_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE', [identity.owner, identity.id]);
      if (!rows.length) throw new HttpError(401, 'Companion has been revoked.');
      if (value.sequence <= Number(rows[0].snapshot_sequence)) return { ok: true, ignored: true, sequence: Number(rows[0].snapshot_sequence) };
      for (const book of [...value.books].sort((a, b) => a.id.localeCompare(b.id))) {
        await client.query(`INSERT INTO books_library (owner_id,book_id,source_device_id,metadata,imported_at)
          VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (owner_id,book_id) DO UPDATE
          SET source_device_id=EXCLUDED.source_device_id, metadata=EXCLUDED.metadata, imported_at=EXCLUDED.imported_at`,
        [identity.owner, book.id, identity.id, JSON.stringify(book), this.now()]);
        // A URL handoff can succeed without a CFI being available yet. Its
        // first later Apple position becomes a baseline, not a resume change.
        if (book.applePosition) await client.query(`UPDATE books_positions
          SET position=jsonb_set(position,'{delivered,applePosition}',$3::jsonb)
          WHERE owner_id=$1 AND book_id=$2 AND position->'delivered'->>'deviceId'=$4
          AND position->'delivered'->'applePosition'='null'::jsonb`,
        [identity.owner, book.id, JSON.stringify(book.applePosition), identity.id]);
      }
      await client.query('UPDATE books_devices SET snapshot_sequence=$3,last_seen_at=$4 WHERE owner_id=$1 AND id=$2', [identity.owner, identity.id, value.sequence, this.now()]);
      return { ok: true, imported: value.books.length, sequence: value.sequence };
    });
  }

  async positions(identity) {
    // Pulling a pending position does not claim it has been applied in Apple Books.
    const { rows } = await this.pool.query(`SELECT b.*,p.position AS web_position FROM books_library b
      JOIN books_positions p ON p.owner_id=b.owner_id AND p.book_id=b.book_id
      JOIN books_devices d ON d.owner_id=b.owner_id AND d.id=b.source_device_id
      WHERE b.owner_id=$1 AND b.source_device_id=$2 AND d.revoked_at IS NULL`, [identity.owner, identity.id]);
    const positions = rows.filter((row) => syncState(row.metadata.applePosition, row.web_position, row.source_device_id) === 'pending').map((row) => ({
      bookId: row.book_id, position: row.web_position, applePosition: row.metadata.applePosition,
      syncState: 'pending',
    }));
    return { positions, refreshedAt: this.now().toISOString() };
  }

  async acknowledgePosition(identity, bookId, value, confirmed = true) {
    return this.transaction(async (client) => {
      const device = await client.query('SELECT id FROM books_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE', [identity.owner, identity.id]);
      if (!device.rows.length) throw new HttpError(401, 'Companion has been revoked.');
      const row = (await this.rows(identity.owner, bookId, client, true))[0];
      if (!row || row.source_device_id !== identity.id) throw new HttpError(404, 'Book not found on this linked Mac.');
      const position = row.web_position;
      if (!position || position.revision !== value.revision || position.cfi !== value.cfi) {
        throw new HttpError(409, 'A newer web position is waiting. Read the pending position again.');
      }
      if (position.applied?.deviceId === identity.id) return { ok: true, ignored: true, revision: position.revision };
      if (!confirmed && position.delivered?.deviceId === identity.id) return { ok: true, ignored: true, revision: position.revision };
      position[confirmed ? 'applied' : 'delivered'] = { deviceId: identity.id, at: this.now().toISOString(), applePosition: value.applePosition };
      await client.query('UPDATE books_positions SET position=$3::jsonb WHERE owner_id=$1 AND book_id=$2', [identity.owner, bookId, JSON.stringify(position)]);
      return { ok: true, revision: position.revision };
    });
  }
}
