CREATE TABLE IF NOT EXISTS books_devices (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  snapshot_sequence bigint NOT NULL DEFAULT -1,
  UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS books_devices_owner ON books_devices(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS books_devices_active_owner ON books_devices(owner_id) WHERE revoked_at IS NULL;
ALTER TABLE books_devices ADD COLUMN IF NOT EXISTS transfer_seen_at timestamptz;

CREATE TABLE IF NOT EXISTS books_pairings (
  token_hash text PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS books_pairings_expiry ON books_pairings(expires_at);

CREATE TABLE IF NOT EXISTS books_library (
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  book_id text NOT NULL,
  source_device_id text NOT NULL,
  metadata jsonb NOT NULL,
  imported_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, book_id),
  FOREIGN KEY (owner_id, source_device_id) REFERENCES books_devices(owner_id, id)
);

CREATE TABLE IF NOT EXISTS books_positions (
  owner_id text NOT NULL,
  book_id text NOT NULL,
  position jsonb NOT NULL,
  PRIMARY KEY (owner_id, book_id),
  FOREIGN KEY (owner_id, book_id) REFERENCES books_library(owner_id, book_id) ON DELETE CASCADE
);

-- Short-lived WebRTC connection descriptions only. Book bytes never enter this table.
CREATE TABLE IF NOT EXISTS books_transfers (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  book_id text NOT NULL,
  device_id text NOT NULL,
  offer jsonb NOT NULL,
  answer jsonb,
  error text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (owner_id, book_id) REFERENCES books_library(owner_id, book_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, device_id) REFERENCES books_devices(owner_id, id) ON DELETE CASCADE,
  CHECK (answer IS NULL OR error IS NULL)
);
CREATE INDEX IF NOT EXISTS books_transfers_expiry ON books_transfers(expires_at);
CREATE INDEX IF NOT EXISTS books_transfers_device ON books_transfers(owner_id, device_id);
