import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => value == null ? null : new Date(value).toISOString();
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

function device(row) {
  return {
    id: row.id, name: row.name, createdAt: iso(row.created_at), lastSeenAt: iso(row.last_seen_at),
    revokedAt: iso(row.revoked_at),
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
    return { books, refreshedAt: this.now().toISOString(), bridge: 'cloud' };
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
      const { rows } = await client.query(`INSERT INTO books_devices (id,owner_id,name,credential_hash,created_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [randomUUID(), result.rows[0].owner_id, name, hash(credential), this.now()]);
      return { device: device(rows[0]), credential };
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
    return { devices: rows.map(device) };
  }

  async revokeDevice(owner, id) {
    const { rows } = await this.pool.query('UPDATE books_devices SET revoked_at=COALESCE(revoked_at,$3) WHERE owner_id=$1 AND id=$2 RETURNING id', [owner, id, this.now()]);
    if (!rows.length) throw new HttpError(404, 'Device not found.');
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
