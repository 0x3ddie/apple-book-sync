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
