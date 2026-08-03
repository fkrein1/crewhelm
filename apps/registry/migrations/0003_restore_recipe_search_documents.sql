PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recipe_search_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  requirements TEXT NOT NULL
) STRICT;

-- An older 0001 migration was changed after deployment. D1 recorded it as applied even though
-- these external-content rows no longer existed. Clear any orphaned FTS rowids before backfill.
INSERT INTO recipe_search(recipe_search) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS recipe_search_documents_insert
AFTER INSERT ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES (new.id, new.identity, new.title, new.summary, new.outcome, new.description, new.tags, new.requirements);
END;

CREATE TRIGGER IF NOT EXISTS recipe_search_documents_delete
AFTER DELETE ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(recipe_search, rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES ('delete', old.id, old.identity, old.title, old.summary, old.outcome, old.description, old.tags, old.requirements);
END;

CREATE TRIGGER IF NOT EXISTS recipe_search_documents_update
AFTER UPDATE ON recipe_search_documents BEGIN
  INSERT INTO recipe_search(recipe_search, rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES ('delete', old.id, old.identity, old.title, old.summary, old.outcome, old.description, old.tags, old.requirements);
  INSERT INTO recipe_search(rowid, identity, title, summary, outcome, description, tags, requirements)
  VALUES (new.id, new.identity, new.title, new.summary, new.outcome, new.description, new.tags, new.requirements);
END;

INSERT INTO recipe_search_documents (
  identity,
  title,
  summary,
  outcome,
  description,
  tags,
  requirements
)
SELECT
  artifact.namespace || '/' || artifact.name,
  json_extract(artifact.projection_json, '$.title'),
  json_extract(artifact.projection_json, '$.summary'),
  json_extract(artifact.projection_json, '$.outcome'),
  json_extract(artifact.projection_json, '$.description'),
  coalesce(
    (SELECT group_concat(value, ' ') FROM json_each(artifact.projection_json, '$.tags')),
    ''
  ),
  trim(
    coalesce(
      (
        SELECT group_concat(value, ' ')
        FROM json_each(artifact.projection_json, '$.requirements.capabilityIds')
      ),
      ''
    ) || ' ' ||
    coalesce(
      (
        SELECT group_concat(value, ' ')
        FROM json_each(artifact.projection_json, '$.requirements.integrations')
      ),
      ''
    )
  )
FROM artifact_versions AS artifact
WHERE
  artifact.kind = 'recipe' AND
  artifact.lifecycle = 'published' AND
  artifact.version = (
    SELECT max(candidate.version)
    FROM artifact_versions AS candidate
    WHERE
      candidate.kind = 'recipe' AND
      candidate.lifecycle = 'published' AND
      candidate.namespace = artifact.namespace AND
      candidate.name = artifact.name
  )
ON CONFLICT(identity) DO UPDATE SET
  title = excluded.title,
  summary = excluded.summary,
  outcome = excluded.outcome,
  description = excluded.description,
  tags = excluded.tags,
  requirements = excluded.requirements;

-- Rebuild from the canonical external-content table so pre-existing and backfilled rows agree.
INSERT INTO recipe_search(recipe_search) VALUES ('rebuild');
