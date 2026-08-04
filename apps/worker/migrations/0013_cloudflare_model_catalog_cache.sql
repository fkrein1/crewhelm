CREATE TABLE "cloudflare_model_catalog_cache" (
  "id" integer PRIMARY KEY NOT NULL CHECK ("id" = 1),
  "source_commit" text NOT NULL CHECK (length("source_commit") = 40),
  "refreshed_at" integer NOT NULL CHECK ("refreshed_at" > 0),
  "model_count" integer NOT NULL CHECK ("model_count" > 0 AND "model_count" <= 500),
  "catalog" text NOT NULL,
  "catalog_bytes" integer NOT NULL CHECK ("catalog_bytes" > 0 AND "catalog_bytes" <= 1048576)
);
