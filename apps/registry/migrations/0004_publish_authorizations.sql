CREATE TABLE publish_authorizations (
  authorization_id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL CHECK (length(challenge) = 64),
  idempotency_key TEXT NOT NULL,
  installation_label TEXT NOT NULL,
  github_user_id INTEGER REFERENCES publishers(github_user_id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER
) STRICT;

CREATE UNIQUE INDEX publish_authorizations_challenge_idempotency_unique
  ON publish_authorizations(challenge, idempotency_key);
CREATE INDEX publish_authorizations_expiry_idx ON publish_authorizations(expires_at);
