import { sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const publishers = sqliteTable("publishers", {
  githubUserId: integer("github_user_id").primaryKey(),
  githubLogin: text("github_login").notNull(),
  namespace: text("namespace").notNull().unique(),
  displayName: text("display_name").notNull(),
  profileUrl: text("profile_url"),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  verifier: text("verifier").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const publisherSessions = sqliteTable(
  "publisher_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    githubUserId: integer("github_user_id")
      .notNull()
      .references(() => publishers.githubUserId),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("publisher_sessions_expiry_idx").on(table.expiresAt)],
);

export const publishAuthorizations = sqliteTable(
  "publish_authorizations",
  {
    authorizationId: text("authorization_id").primaryKey(),
    challenge: text("challenge").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    installationLabel: text("installation_label").notNull(),
    githubUserId: integer("github_user_id").references(() => publishers.githubUserId),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    authorizedAt: integer("authorized_at"),
  },
  (table) => [
    unique("publish_authorizations_challenge_idempotency_unique").on(
      table.challenge,
      table.idempotencyKey,
    ),
    index("publish_authorizations_expiry_idx").on(table.expiresAt),
  ],
);

export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    kind: text("kind", { enum: ["recipe", "skill"] }).notNull(),
    namespace: text("namespace")
      .notNull()
      .references(() => publishers.namespace),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    lifecycle: text("lifecycle", { enum: ["published", "restricted", "retired"] })
      .notNull()
      .default("published"),
    review: text("review", { enum: ["featured", "reviewed", "unreviewed"] })
      .notNull()
      .default("unreviewed"),
    projectionJson: text("projection_json").notNull(),
    searchDocument: text("search_document"),
    semanticState: text("semantic_state", { enum: ["indexed", "pending"] }),
    publishedAt: integer("published_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.namespace, table.name, table.version] }),
    unique("artifact_versions_digest_unique").on(
      table.kind,
      table.namespace,
      table.name,
      table.digest,
    ),
    index("artifact_versions_identity_idx").on(
      table.kind,
      table.namespace,
      table.name,
      sql`${table.version} DESC`,
    ),
    index("artifact_versions_semantic_pending_idx").on(
      table.semanticState,
      table.kind,
      table.publishedAt,
    ),
  ],
);

export const artifactDependencies = sqliteTable(
  "artifact_dependencies",
  {
    recipeKind: text("recipe_kind", { enum: ["recipe"] })
      .notNull()
      .default("recipe"),
    recipeNamespace: text("recipe_namespace").notNull(),
    recipeName: text("recipe_name").notNull(),
    recipeVersion: integer("recipe_version").notNull(),
    skillRegistry: text("skill_registry").notNull(),
    skillNamespace: text("skill_namespace").notNull(),
    skillName: text("skill_name").notNull(),
    skillVersion: integer("skill_version").notNull(),
    skillDigest: text("skill_digest").notNull(),
    requirement: text("requirement", { enum: ["optional", "required"] }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.recipeNamespace,
        table.recipeName,
        table.recipeVersion,
        table.skillRegistry,
        table.skillNamespace,
        table.skillName,
      ],
    }),
    foreignKey({
      columns: [table.recipeKind, table.recipeNamespace, table.recipeName, table.recipeVersion],
      foreignColumns: [
        artifactVersions.kind,
        artifactVersions.namespace,
        artifactVersions.name,
        artifactVersions.version,
      ],
    }),
  ],
);

export const publishMutations = sqliteTable(
  "publish_mutations",
  {
    githubUserId: integer("github_user_id")
      .notNull()
      .references(() => publishers.githubUserId),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.githubUserId, table.idempotencyKey] })],
);

export const publisherDailyUsage = sqliteTable(
  "publisher_daily_usage",
  {
    githubUserId: integer("github_user_id")
      .notNull()
      .references(() => publishers.githubUserId),
    usageDay: text("usage_day").notNull(),
    artifactCount: integer("artifact_count").notNull(),
    byteCount: integer("byte_count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.githubUserId, table.usageDay] })],
);

export const publishUploadIntents = sqliteTable(
  "publish_upload_intents",
  {
    githubUserId: integer("github_user_id")
      .notNull()
      .references(() => publishers.githubUserId),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    responseJson: text("response_json").notNull(),
    artifactCount: integer("artifact_count").notNull(),
    byteCount: integer("byte_count").notNull(),
    usageDay: text("usage_day").notNull(),
    touchedAt: integer("touched_at").notNull(),
    phase: text("phase", { enum: ["uploading", "finalizing", "quarantine", "cleanup"] })
      .notNull()
      .default("uploading"),
    leaseStartedAt: integer("lease_started_at"),
  },
  (table) => [
    primaryKey({ columns: [table.githubUserId, table.idempotencyKey] }),
    index("publish_upload_intents_cleanup_idx").on(
      table.phase,
      table.touchedAt,
      table.leaseStartedAt,
    ),
  ],
);

export const publishUploadArtifacts = sqliteTable(
  "publish_upload_artifacts",
  {
    githubUserId: integer("github_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind", { enum: ["recipe", "skill"] }).notNull(),
    namespace: text("namespace").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    digest: text("digest").notNull(),
    objectKey: text("object_key").notNull().unique(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.namespace, table.name, table.version] }),
    foreignKey({
      columns: [table.githubUserId, table.idempotencyKey],
      foreignColumns: [publishUploadIntents.githubUserId, publishUploadIntents.idempotencyKey],
    }).onDelete("cascade"),
  ],
);

export const recipeSearchDocuments = sqliteTable("recipe_search_documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  identity: text("identity").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  outcome: text("outcome").notNull(),
  description: text("description").notNull(),
  tags: text("tags").notNull(),
  requirements: text("requirements").notNull(),
});

export const registrySchema = {
  artifactDependencies,
  artifactVersions,
  oauthStates,
  publishAuthorizations,
  publishMutations,
  publisherDailyUsage,
  publishers,
  publisherSessions,
  publishUploadArtifacts,
  publishUploadIntents,
  recipeSearchDocuments,
};

export type RegistryDatabase = DrizzleD1Database<typeof registrySchema>;

export function registryDatabase(database: D1Database): RegistryDatabase {
  return drizzle(database, { schema: registrySchema });
}
