ALTER TABLE artifact_versions ADD COLUMN primary_model TEXT;
ALTER TABLE artifact_versions ADD COLUMN fallback_models_json TEXT;

CREATE INDEX artifact_versions_primary_model_idx
  ON artifact_versions(kind, primary_model);
