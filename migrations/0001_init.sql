CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_folders_name ON folders(owner_id, COALESCE(parent_id, ''), name);

CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id       TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('text','image')),
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  is_locked       INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
  locked_by_admin INTEGER NOT NULL DEFAULT 0 CHECK (locked_by_admin IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_files_name ON files(owner_id, COALESCE(folder_id, ''), name);
CREATE INDEX ix_files_owner_folder ON files(owner_id, folder_id);
