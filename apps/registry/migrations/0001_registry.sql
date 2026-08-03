PRAGMA foreign_keys = ON;

CREATE TABLE publishers (
  github_user_id INTEGER PRIMARY KEY,
  github_login TEXT NOT NULL,
  namespace TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  profile_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE publisher_sessions (
  token_hash TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL REFERENCES publishers(github_user_id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX publisher_sessions_expiry_idx ON publisher_sessions(expires_at);

CREATE TABLE artifact_versions (
  kind TEXT NOT NULL CHECK (kind IN ('recipe', 'skill')),
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  lifecycle TEXT NOT NULL DEFAULT 'published' CHECK (lifecycle IN ('published', 'restricted', 'retired')),
  review TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review IN ('featured', 'reviewed', 'unreviewed')),
  projection_json TEXT NOT NULL,
  search_document TEXT,
  semantic_state TEXT CHECK (semantic_state IN ('indexed', 'pending')),
  published_at INTEGER NOT NULL,
  PRIMARY KEY (kind, namespace, name, version),
  UNIQUE (kind, namespace, name, digest),
  FOREIGN KEY (namespace) REFERENCES publishers(namespace)
) STRICT;
CREATE INDEX artifact_versions_identity_idx
  ON artifact_versions(kind, namespace, name, version DESC);
CREATE INDEX artifact_versions_semantic_pending_idx
  ON artifact_versions(semantic_state, kind, published_at);

CREATE TABLE artifact_dependencies (
  recipe_kind TEXT NOT NULL DEFAULT 'recipe' CHECK (recipe_kind = 'recipe'),
  recipe_namespace TEXT NOT NULL,
  recipe_name TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  skill_registry TEXT NOT NULL,
  skill_namespace TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_version INTEGER NOT NULL,
  skill_digest TEXT NOT NULL,
  requirement TEXT NOT NULL CHECK (requirement IN ('optional', 'required')),
  PRIMARY KEY (recipe_namespace, recipe_name, recipe_version, skill_registry, skill_namespace, skill_name),
  FOREIGN KEY (recipe_kind, recipe_namespace, recipe_name, recipe_version)
    REFERENCES artifact_versions(kind, namespace, name, version)
) STRICT;

CREATE TABLE publish_mutations (
  github_user_id INTEGER NOT NULL REFERENCES publishers(github_user_id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (github_user_id, idempotency_key)
) STRICT;

CREATE TABLE publisher_daily_usage (
  github_user_id INTEGER NOT NULL REFERENCES publishers(github_user_id),
  usage_day TEXT NOT NULL,
  artifact_count INTEGER NOT NULL CHECK (artifact_count BETWEEN 0 AND 50),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 0 AND 10485760),
  PRIMARY KEY (github_user_id, usage_day)
) STRICT;

CREATE TABLE recipe_search_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  requirements TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE recipe_search USING fts5(
  identity UNINDEXED,
  title,
  summary,
  outcome,
  description,
  tags,
  requirements,
  content = 'recipe_search_documents',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER recipe_search_documents_insert AFTER INSERT ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES (new.id, new.identity, new.title, new.summary, new.outcome, new.description, new.tags, new.requirements);
END;

CREATE TRIGGER recipe_search_documents_delete AFTER DELETE ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(recipe_search, rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES ('delete', old.id, old.identity, old.title, old.summary, old.outcome, old.description, old.tags, old.requirements);
END;

CREATE TRIGGER recipe_search_documents_update AFTER UPDATE ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(recipe_search, rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES ('delete', old.id, old.identity, old.title, old.summary, old.outcome, old.description, old.tags, old.requirements);
  INSERT INTO recipe_search(rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES (new.id, new.identity, new.title, new.summary, new.outcome, new.description, new.tags, new.requirements);
END;
