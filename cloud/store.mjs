import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => value == null ? null : new Date(value).toISOString();
const transferReady = (row, now) => !row.revoked_at && row.transfer_seen_at != null
  && new Date(row.transfer_seen_at).getTime() > now.getTime() - 30_000;
export function syncState(apple, web) {
  return web ? (web.appleRevision === (apple?.revision ?? null) ? 'pending' : 'conflict') : apple ? 'apple' : 'empty';
}

function detail(row) {
  if (!row) throw new HttpError(404, 'Book not found.');
  const book = row.metadata;
  const web = row.web_position ?? null;
  const apple = book.applePosition;
  return {
    id: row.book_id, title: book.title, author: book.author,
    progress: web?.percentage ?? book.progress,
    lastReadAt: [book.lastReadAt, web?.savedAt].filter(Boolean).sort().at(-1) ?? null,
    readable: false, availableOnMac: book.availableOnMac,
    unavailableReason: 'Save this book on this device before reading. EPUB files stay on your own devices.',
    coverUrl: null, epubUrl: null,
    appleBooksUrl: `ibooks://assetid/${encodeURIComponent(row.book_id)}`,
    applePosition: apple, webPosition: web,
    resume: { cfi: web?.cfi ?? apple?.cfi ?? null, source: web ? 'web' : apple ? 'apple' : 'start' },
    syncState: syncState(apple, web), annotations: book.annotations,
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
  constructor(pool, { now = () => new Date() } = {}) { this.pool = pool; this.now = now; }

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
    const devices = await this.pool.query('SELECT transfer_seen_at,revoked_at FROM books_devices WHERE owner_id=$1 AND revoked_at IS NULL', [owner]);
    return { books, refreshedAt: this.now().toISOString(), bridge: 'cloud', transferReady: devices.rows.some((row) => transferReady(row, this.now())) };
  }

  async book(owner, bookId) { return detail((await this.rows(owner, bookId))[0]); }

  async savePosition(owner, bookId, value) {
    return this.transaction(async (client) => {
      const book = detail((await this.rows(owner, bookId, client, true))[0]);
      const previous = book.webPosition;
      if (previous?.clientId === value.clientId && value.sequence <= previous.sequence) {
        return { ok: true, position: previous, syncState: book.syncState, ignored: true };
      }
      if (value.appleRevision !== (book.applePosition?.revision ?? null)) {
        throw new HttpError(409, 'Apple Books has a newer position. Choose where to continue.', { book });
      }
      if ((!previous || previous.clientId !== value.clientId) && value.baseRevision !== (previous?.revision ?? 0)) {
        throw new HttpError(409, 'Another reader saved a newer position. Choose where to continue.', { book });
      }
      const position = {
        cfi: value.cfi, savedAt: this.now().toISOString(), revision: (previous?.revision ?? 0) + 1,
        clientId: value.clientId, sequence: value.sequence, appleRevision: value.appleRevision,
        href: value.href, percentage: value.percentage,
      };
      await client.query(`INSERT INTO books_positions (owner_id, book_id, position) VALUES ($1,$2,$3::jsonb)
        ON CONFLICT (owner_id, book_id) DO UPDATE SET position=EXCLUDED.position`, [owner, bookId, JSON.stringify(position)]);
      return { ok: true, position, syncState: 'pending' };
    });
  }

  async createPairing(owner) {
    const token = `pair_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(this.now().getTime() + 600_000);
    await this.transaction(async (client) => {
      // A new code replaces this account's unclaimed code.
      await client.query('DELETE FROM books_pairings WHERE expires_at<=$1', [this.now()]);
      await client.query(`INSERT INTO books_pairings (token_hash,owner_id,expires_at) VALUES ($1,$2,$3)
        ON CONFLICT (owner_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`, [hash(token), owner, expiresAt]);
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async claimPairing(token, name) {
    const credential = `device_${randomBytes(32).toString('base64url')}`;
    return this.transaction(async (client) => {
      const pairing = await client.query('SELECT owner_id FROM books_pairings WHERE token_hash=$1 AND expires_at>$2', [hash(token), this.now()]);
      if (!pairing.rows.length) throw new HttpError(401, 'Pairing code is invalid, expired, or already used.');
      // Serialize replacement on the account before consuming the one-use code.
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [pairing.rows[0].owner_id]);
      const result = await client.query('DELETE FROM books_pairings WHERE token_hash=$1 AND expires_at>$2 RETURNING owner_id', [hash(token), this.now()]);
      if (!result.rows.length) throw new HttpError(401, 'Pairing code is invalid, expired, or already used.');
      await client.query('UPDATE books_devices SET revoked_at=$2 WHERE owner_id=$1 AND revoked_at IS NULL', [result.rows[0].owner_id, this.now()]);
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1', [result.rows[0].owner_id]);
      const { rows } = await client.query(`INSERT INTO books_devices (id,owner_id,name,credential_hash,created_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [randomUUID(), result.rows[0].owner_id, name, hash(credential), this.now()]);
      return { device: device(rows[0], this.now()), credential };
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
      if (!book.metadata.availableOnMac) throw new HttpError(409, 'Download this EPUB in Apple Books on your Mac first, then sync the library.');
      const source = (await client.query('SELECT id,transfer_seen_at,revoked_at FROM books_devices WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE', [owner, book.source_device_id])).rows[0];
      if (!source || !transferReady(source, this.now())) throw new HttpError(503, 'Start transfers on your Mac, keep it awake, and connect both devices to the same Wi-Fi.');
      const count = await client.query('SELECT count(*)::int AS count FROM books_transfers WHERE owner_id=$1 AND error IS NULL', [owner]);
      if (count.rows[0].count >= 3) throw new HttpError(429, 'Finish or cancel another book download before starting this one.');
      const id = randomUUID(), expiresAt = new Date(this.now().getTime() + 180_000);
      await client.query(`INSERT INTO books_transfers (id,owner_id,book_id,device_id,offer,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, [id, owner, value.bookId, source.id, JSON.stringify(value.offer), this.now(), expiresAt]);
      return { id, expiresAt: iso(expiresAt) };
    });
  }

  async transfer(owner, id) {
    const { rows } = await this.pool.query(`SELECT t.* FROM books_transfers t JOIN books_devices d ON d.owner_id=t.owner_id AND d.id=t.device_id
      WHERE t.owner_id=$1 AND t.id=$2 AND t.expires_at>$3 AND d.revoked_at IS NULL`, [owner, id, this.now()]);
    if (!rows.length) throw new HttpError(404, 'This transfer expired or was closed. Save the book again.');
    const row = rows[0];
    return { id: row.id, bookId: row.book_id, status: row.error ? 'failed' : row.answer ? 'answered' : 'waiting', answer: row.answer, error: row.error, expiresAt: iso(row.expires_at) };
  }

  async closeTransfer(owner, id) {
    // Deletion is safe after expiry/revocation too, and never reveals another account's row.
    await this.pool.query('DELETE FROM books_transfers WHERE owner_id=$1 AND id=$2', [owner, id]);
    return { ok: true };
  }

  async pendingTransfers(identity) {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [identity.owner]);
      const device = await client.query(`UPDATE books_devices SET transfer_seen_at=$3
        WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [identity.owner, identity.id, this.now()]);
      if (!device.rows.length) throw new HttpError(401, 'Companion has been revoked.');
      await client.query('DELETE FROM books_transfers WHERE owner_id=$1 AND expires_at<=$2', [identity.owner, this.now()]);
      const { rows } = await client.query(`SELECT id,book_id,offer,expires_at FROM books_transfers
        WHERE owner_id=$1 AND device_id=$2 AND answer IS NULL AND error IS NULL ORDER BY created_at LIMIT 3`, [identity.owner, identity.id]);
      return { transfers: rows.map((row) => ({ id: row.id, bookId: row.book_id, offer: row.offer, expiresAt: iso(row.expires_at) })) };
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
      }
      await client.query('UPDATE books_devices SET snapshot_sequence=$3,last_seen_at=$4 WHERE owner_id=$1 AND id=$2', [identity.owner, identity.id, value.sequence, this.now()]);
      return { ok: true, imported: value.books.length, sequence: value.sequence };
    });
  }

  async positions(identity) {
    // Pulling a pending position does not claim it has been applied in Apple Books.
    const positions = (await this.rows(identity.owner)).filter((row) => row.web_position).map((row) => ({
      bookId: row.book_id, position: row.web_position, applePosition: row.metadata.applePosition,
      syncState: syncState(row.metadata.applePosition, row.web_position),
    }));
    return { positions, refreshedAt: this.now().toISOString() };
  }
}
