PRAGMA foreign_keys = ON;

CREATE TABLE publish_upload_intents (
  github_user_id INTEGER NOT NULL REFERENCES publishers(github_user_id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response_json TEXT NOT NULL,
  artifact_count INTEGER NOT NULL CHECK (artifact_count BETWEEN 1 AND 9),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 10485760),
  usage_day TEXT NOT NULL CHECK (length(usage_day) = 10),
  touched_at INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'uploading'
    CHECK (phase IN ('uploading', 'finalizing', 'quarantine', 'cleanup')),
  lease_started_at INTEGER,
  PRIMARY KEY (github_user_id, idempotency_key)
) STRICT;
CREATE INDEX publish_upload_intents_cleanup_idx
  ON publish_upload_intents(phase, touched_at, lease_started_at);

CREATE TABLE publish_upload_artifacts (
  github_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recipe', 'skill')),
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  PRIMARY KEY (kind, namespace, name, version),
  FOREIGN KEY (github_user_id, idempotency_key)
    REFERENCES publish_upload_intents(github_user_id, idempotency_key)
    ON DELETE CASCADE
) STRICT;
