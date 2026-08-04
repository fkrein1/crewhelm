import {
  registryPublishBundleSchema,
  registryPublishResultSchema,
  recipeRegistryProjectionSchema,
  registryRecipeSearchResponseSchema,
  registrySkillProjectionSchema,
  type RecipeRegistryProjection,
  type RegistryArtifactVersionEnvelope,
  type RegistryPublishBundle,
  type RegistryPublishResult,
  type RegistryRecipeSearchResponse,
  type RegistryRecipeSearchResult,
  type RegistrySkillProjection,
} from "@crewhelm/contracts";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import type { RegistryEnv } from "./env.js";
import {
  canonicalPackage,
  inspectPublicSkill,
  inspectPublicText,
  packageObjectKey,
  projectRecipe,
  projectSkill,
  recipeSearchDocument,
  sha256Hex,
} from "./packages.js";
import {
  artifactDependencies,
  artifactVersions,
  publishMutations,
  publisherDailyUsage,
  publishUploadArtifacts,
  publishUploadIntents,
  recipeSearchDocuments,
  registryDatabase,
  type RegistryDatabase,
} from "./schema.js";

export class RegistryConflictError extends Error {
  override readonly name = "RegistryConflictError";
}

export class RegistryDeniedError extends Error {
  override readonly name = "RegistryDeniedError";
}

type Publisher = {
  displayName: string;
  githubUserId: number;
  namespace: string;
  profileUrl?: string;
};

type PreparedArtifact = {
  bytes: Uint8Array;
  envelope: RegistryArtifactVersionEnvelope;
  key: string;
  projection: RecipeRegistryProjection | RegistrySkillProjection;
  searchDocument: string | null;
};

type PendingPublication = {
  requestDigest: string;
  result: RegistryPublishResult;
};

const PUBLISH_UPLOAD_INTENT_TTL_SECONDS = 60 * 60;
const MAXIMUM_UPLOAD_INTENT_CLEANUPS = 25;

export type RegistrySearchEnv = {
  AI: {
    run(model: string, input: { text: string[] }): Promise<unknown>;
  };
  RECIPE_SEARCH_INDEX: {
    query(
      vector: number[],
      options: { returnMetadata: "indexed"; topK: number },
    ): Promise<{
      matches: Array<{
        metadata?: Record<string, unknown>;
        score: number;
      }>;
    }>;
    upsert(
      vectors: Array<{
        id: string;
        metadata: Record<string, string | number>;
        values: number[];
      }>,
    ): Promise<unknown>;
  };
  REGISTRY_DB: D1Database;
};

function parseRecipeProjection(value: string): RecipeRegistryProjection {
  const parsed: unknown = JSON.parse(value);
  return recipeRegistryProjectionSchema.parse(parsed);
}

function parseArtifactProjection(
  kind: "recipe" | "skill",
  value: string,
): RecipeRegistryProjection | RegistrySkillProjection {
  const parsed: unknown = JSON.parse(value);
  return kind === "recipe"
    ? recipeRegistryProjectionSchema.parse(parsed)
    : registrySkillProjectionSchema.parse(parsed);
}

function publisherProjection(publisher: Publisher): RecipeRegistryProjection["publisher"] {
  return {
    displayName: publisher.displayName,
    namespace: publisher.namespace,
    ...(publisher.profileUrl === undefined ? {} : { profileUrl: publisher.profileUrl }),
  };
}

async function prepareArtifacts(
  bundle: RegistryPublishBundle,
  publisher: Publisher,
  publishedAt: string,
  publisherValue: RecipeRegistryProjection["publisher"] = publisherProjection(publisher),
): Promise<{ artifacts: PreparedArtifact[]; result: RegistryPublishResult }> {
  const skillArtifacts: PreparedArtifact[] = [];

  for (const skill of bundle.skills) {
    const bytes = canonicalPackage(skill.package);
    const digest = await sha256Hex(bytes);
    const warnings = inspectPublicSkill(skill.package);
    if (warnings.suspectedSecrets > 0 || warnings.suspectedPrivateIdentifiers > 0) {
      throw new RegistryDeniedError("sensitive_content");
    }
    const projection = projectSkill({
      descriptor: { digest, sizeBytes: bytes.byteLength },
      namespace: publisher.namespace,
      package: skill.package,
      publishedAt,
      publisher: publisherValue,
      version: skill.version,
    });
    const envelope: RegistryArtifactVersionEnvelope = {
      contentTrust: "untrusted",
      coordinate: projection.artifact,
      kind: "skill",
      lifecycle: "published",
      package: projection.package,
      publishedAt,
      publisher: publisherValue,
      review: "unreviewed",
    };
    skillArtifacts.push({
      bytes,
      envelope,
      key: packageObjectKey(envelope),
      projection,
      searchDocument: null,
    });
  }

  const recipeBytes = canonicalPackage(bundle.recipe.package);
  const recipeWarnings = inspectPublicText(bundle.recipe.package);
  if (recipeWarnings.suspectedSecrets || recipeWarnings.suspectedPrivateIdentifiers) {
    throw new RegistryDeniedError("sensitive_content");
  }
  const recipeDigest = await sha256Hex(recipeBytes);
  const recipeProjection = projectRecipe({
    descriptor: { digest: recipeDigest, sizeBytes: recipeBytes.byteLength },
    namespace: publisher.namespace,
    package: bundle.recipe.package,
    publishedAt,
    publisher: publisherValue,
    version: bundle.recipe.version,
  });
  const recipeEnvelope: RegistryArtifactVersionEnvelope = {
    contentTrust: "untrusted",
    coordinate: recipeProjection.artifact,
    kind: "recipe",
    lifecycle: "published",
    package: recipeProjection.package,
    publishedAt,
    publisher: publisherValue,
    review: "unreviewed",
  };
  const recipeArtifact: PreparedArtifact = {
    bytes: recipeBytes,
    envelope: recipeEnvelope,
    key: packageObjectKey(recipeEnvelope),
    projection: recipeProjection,
    searchDocument: recipeSearchDocument(bundle.recipe.package),
  };
  const artifacts = [...skillArtifacts, recipeArtifact];
  return {
    artifacts,
    result: {
      artifacts: artifacts.map(({ envelope }) => envelope),
      recipe: recipeProjection,
      semanticIndex: "pending",
    },
  };
}

function publicationTimestamp(now = Date.now()): string {
  return new Date(Math.floor(now / 1_000) * 1_000).toISOString();
}

function resultPublishedAt(result: RegistryPublishResult): string {
  const publishedAt = result.artifacts[0]?.publishedAt;
  if (!publishedAt || result.artifacts.some((artifact) => artifact.publishedAt !== publishedAt)) {
    throw new RegistryConflictError("publish_intent_invalid");
  }
  return publishedAt;
}

async function successfulPublication(
  env: RegistryEnv,
  githubUserId: number,
  idempotencyKey: string,
  requestDigest: string,
): Promise<RegistryPublishResult | null> {
  const [previous] = await registryDatabase(env.REGISTRY_DB)
    .select({
      requestDigest: publishMutations.requestDigest,
      responseJson: publishMutations.responseJson,
    })
    .from(publishMutations)
    .where(
      and(
        eq(publishMutations.githubUserId, githubUserId),
        eq(publishMutations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!previous) return null;
  if (previous.requestDigest !== requestDigest) {
    throw new RegistryConflictError("idempotency_conflict");
  }
  const previousResponse: unknown = JSON.parse(previous.responseJson);
  return registryPublishResultSchema.parse(previousResponse);
}

async function touchPendingPublication(
  env: RegistryEnv,
  githubUserId: number,
  idempotencyKey: string,
  requestDigest: string,
  now: number,
): Promise<PendingPublication | null> {
  const [pending] = await registryDatabase(env.REGISTRY_DB)
    .update(publishUploadIntents)
    .set({ touchedAt: now })
    .where(
      and(
        eq(publishUploadIntents.githubUserId, githubUserId),
        eq(publishUploadIntents.idempotencyKey, idempotencyKey),
        eq(publishUploadIntents.requestDigest, requestDigest),
        inArray(publishUploadIntents.phase, ["uploading", "finalizing"]),
      ),
    )
    .returning({
      requestDigest: publishUploadIntents.requestDigest,
      responseJson: publishUploadIntents.responseJson,
    });
  if (!pending) return null;
  const response: unknown = JSON.parse(pending.responseJson);
  return {
    requestDigest: pending.requestDigest,
    result: registryPublishResultSchema.parse(response),
  };
}

function assertPendingPublication(
  pending: PendingPublication,
  requestDigest: string,
  result: RegistryPublishResult,
): void {
  if (
    pending.requestDigest !== requestDigest ||
    JSON.stringify(pending.result) !== JSON.stringify(result)
  ) {
    throw new RegistryConflictError("idempotency_conflict");
  }
}

async function assertVersions(env: RegistryEnv, artifacts: readonly PreparedArtifact[]) {
  for (const { envelope } of artifacts) {
    const { kind, namespace, name, version } = envelope.coordinate;
    const [latest] = await registryDatabase(env.REGISTRY_DB)
      .select({ version: sql<number | null>`max(${artifactVersions.version})` })
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.kind, kind),
          eq(artifactVersions.namespace, namespace),
          eq(artifactVersions.name, name),
        ),
      );
    const expected = (latest?.version ?? 0) + 1;
    if (version !== expected) throw new RegistryConflictError("version_not_next");
  }
}

async function assertDependencies(
  env: RegistryEnv,
  bundle: RegistryPublishBundle,
  artifacts: readonly PreparedArtifact[],
) {
  const bundledSkills = new Map(
    artifacts
      .filter(({ envelope }) => envelope.kind === "skill")
      .map(({ envelope }) => [
        `${envelope.coordinate.namespace}/${envelope.coordinate.name}/${envelope.coordinate.version}`,
        envelope,
      ]),
  );
  for (const dependency of bundle.recipe.package.skills) {
    const key = `${dependency.namespace}/${dependency.name}/${dependency.version}`;
    const bundled = bundledSkills.get(key);
    if (bundled) {
      if (
        dependency.registry !== env.PUBLIC_ORIGIN ||
        dependency.digest !== bundled.package.digest
      ) {
        throw new RegistryDeniedError("dependency_mismatch");
      }
      continue;
    }
    const [existing] = await registryDatabase(env.REGISTRY_DB)
      .select({ digest: artifactVersions.digest })
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.kind, "skill"),
          eq(artifactVersions.namespace, dependency.namespace),
          eq(artifactVersions.name, dependency.name),
          eq(artifactVersions.version, dependency.version),
          eq(artifactVersions.lifecycle, "published"),
        ),
      )
      .limit(1);
    if (
      dependency.registry !== env.PUBLIC_ORIGIN ||
      !existing ||
      existing.digest !== dependency.digest
    ) {
      throw new RegistryDeniedError("dependency_unavailable");
    }
  }
}

async function reservePublication(
  env: RegistryEnv,
  publisher: Publisher,
  bundle: RegistryPublishBundle,
  requestDigest: string,
  prepared: { artifacts: PreparedArtifact[]; result: RegistryPublishResult },
  usageDay: string,
  byteCount: number,
  now: number,
): Promise<PendingPublication | null> {
  const database = registryDatabase(env.REGISTRY_DB);
  const usage = database
    .insert(publisherDailyUsage)
    .values({
      artifactCount: prepared.artifacts.length,
      byteCount,
      githubUserId: publisher.githubUserId,
      usageDay,
    })
    .onConflictDoUpdate({
      set: {
        artifactCount: sql`${publisherDailyUsage.artifactCount} + ${prepared.artifacts.length}`,
        byteCount: sql`${publisherDailyUsage.byteCount} + ${byteCount}`,
      },
      target: [publisherDailyUsage.githubUserId, publisherDailyUsage.usageDay],
    });
  const intent = database.insert(publishUploadIntents).values({
    artifactCount: prepared.artifacts.length,
    byteCount,
    githubUserId: publisher.githubUserId,
    idempotencyKey: bundle.idempotencyKey,
    leaseStartedAt: null,
    phase: "uploading",
    requestDigest,
    responseJson: JSON.stringify(prepared.result),
    touchedAt: now,
    usageDay,
  });
  const artifacts = prepared.artifacts.map(({ envelope, key }) =>
    database.insert(publishUploadArtifacts).values({
      digest: envelope.package.digest,
      githubUserId: publisher.githubUserId,
      idempotencyKey: bundle.idempotencyKey,
      kind: envelope.kind,
      name: envelope.coordinate.name,
      namespace: envelope.coordinate.namespace,
      objectKey: key,
      version: envelope.coordinate.version,
    }),
  );
  try {
    await database.batch([usage, intent, ...artifacts]);
    return null;
  } catch {
    const pending = await touchPendingPublication(
      env,
      publisher.githubUserId,
      bundle.idempotencyKey,
      requestDigest,
      now,
    );
    if (pending) return pending;
    throw new RegistryConflictError("publish_reservation_conflict");
  }
}

async function storeObjects(env: RegistryEnv, artifacts: readonly PreparedArtifact[]) {
  for (const artifact of artifacts) {
    const stored = await env.REGISTRY_PACKAGES.put(artifact.key, artifact.bytes, {
      customMetadata: { digest: artifact.envelope.package.digest },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: artifact.envelope.package.digest,
    });
    if (stored !== null) continue;
    const existing = await env.REGISTRY_PACKAGES.head(artifact.key);
    if (existing?.customMetadata?.digest !== artifact.envelope.package.digest) {
      throw new RegistryConflictError("package_storage_conflict");
    }
  }
}

async function claimPublicationFinalization(
  env: RegistryEnv,
  githubUserId: number,
  idempotencyKey: string,
  requestDigest: string,
  now: number,
): Promise<boolean> {
  const [claimed] = await registryDatabase(env.REGISTRY_DB)
    .update(publishUploadIntents)
    .set({ leaseStartedAt: null, phase: "finalizing", touchedAt: now })
    .where(
      and(
        eq(publishUploadIntents.githubUserId, githubUserId),
        eq(publishUploadIntents.idempotencyKey, idempotencyKey),
        eq(publishUploadIntents.requestDigest, requestDigest),
        inArray(publishUploadIntents.phase, ["uploading", "finalizing"]),
      ),
    )
    .returning({ githubUserId: publishUploadIntents.githubUserId });
  return claimed !== undefined;
}

function artifactInsert(database: RegistryDatabase, artifact: PreparedArtifact) {
  const { envelope } = artifact;
  const inference = "inference" in artifact.projection ? artifact.projection.inference : null;
  return database.insert(artifactVersions).values({
    digest: envelope.package.digest,
    fallbackModelsJson: inference === null ? null : JSON.stringify(inference.fallbackModels),
    kind: envelope.kind,
    lifecycle: envelope.lifecycle,
    name: envelope.coordinate.name,
    namespace: envelope.coordinate.namespace,
    primaryModel: inference?.primaryModel ?? null,
    projectionJson: JSON.stringify(artifact.projection),
    publishedAt: Math.floor(new Date(envelope.publishedAt).getTime() / 1_000),
    review: envelope.review,
    searchDocument: artifact.searchDocument,
    semanticState: envelope.kind === "recipe" ? "pending" : null,
    sizeBytes: envelope.package.sizeBytes,
    version: envelope.coordinate.version,
  });
}

export async function publishBundle(
  env: RegistryEnv,
  publisher: Publisher,
  rawBundle: unknown,
): Promise<RegistryPublishResult> {
  const bundle = registryPublishBundleSchema.parse(rawBundle);
  if (bundle.namespace !== publisher.namespace) throw new RegistryDeniedError("namespace_mismatch");
  const requestDigest = await sha256Hex(canonicalPackage(bundle));
  const previous = await successfulPublication(
    env,
    publisher.githubUserId,
    bundle.idempotencyKey,
    requestDigest,
  );
  if (previous) return previous;
  const now = Math.floor(Date.now() / 1_000);
  let pending = await touchPendingPublication(
    env,
    publisher.githubUserId,
    bundle.idempotencyKey,
    requestDigest,
    now,
  );
  if (pending && pending.requestDigest !== requestDigest) {
    throw new RegistryConflictError("idempotency_conflict");
  }
  let prepared = await prepareArtifacts(
    bundle,
    publisher,
    pending ? resultPublishedAt(pending.result) : publicationTimestamp(now * 1_000),
    pending?.result.recipe.publisher,
  );
  if (pending) assertPendingPublication(pending, requestDigest, prepared.result);
  await assertVersions(env, prepared.artifacts);
  await assertDependencies(env, bundle, prepared.artifacts);
  const byteCount = prepared.artifacts.reduce(
    (total, artifact) => total + artifact.envelope.package.sizeBytes,
    0,
  );
  const usageDay = publicationTimestamp(now * 1_000).slice(0, 10);
  if (!pending) {
    const [currentUsage] = await registryDatabase(env.REGISTRY_DB)
      .select({
        artifactCount: publisherDailyUsage.artifactCount,
        byteCount: publisherDailyUsage.byteCount,
      })
      .from(publisherDailyUsage)
      .where(
        and(
          eq(publisherDailyUsage.githubUserId, publisher.githubUserId),
          eq(publisherDailyUsage.usageDay, usageDay),
        ),
      )
      .limit(1);
    if (
      (currentUsage?.artifactCount ?? 0) + prepared.artifacts.length > 50 ||
      (currentUsage?.byteCount ?? 0) + byteCount > 10 * 1_024 * 1_024
    ) {
      throw new RegistryDeniedError("publisher_quota_exceeded");
    }
    pending = await reservePublication(
      env,
      publisher,
      bundle,
      requestDigest,
      prepared,
      usageDay,
      byteCount,
      now,
    );
    if (pending) {
      if (pending.requestDigest !== requestDigest) {
        throw new RegistryConflictError("idempotency_conflict");
      }
      prepared = await prepareArtifacts(
        bundle,
        publisher,
        resultPublishedAt(pending.result),
        pending.result.recipe.publisher,
      );
      assertPendingPublication(pending, requestDigest, prepared.result);
    }
  }
  await storeObjects(env, prepared.artifacts);
  if (
    !(await claimPublicationFinalization(
      env,
      publisher.githubUserId,
      bundle.idempotencyKey,
      requestDigest,
      Math.floor(Date.now() / 1_000),
    ))
  ) {
    const completed = await successfulPublication(
      env,
      publisher.githubUserId,
      bundle.idempotencyKey,
      requestDigest,
    );
    if (completed) return completed;
    throw new RegistryConflictError("publish_finalization_conflict");
  }
  const database = registryDatabase(env.REGISTRY_DB);
  const firstArtifact = prepared.artifacts[0];
  if (!firstArtifact) throw new RegistryConflictError("publish_bundle_empty");
  const firstArtifactInsert = artifactInsert(database, firstArtifact);
  const remainingArtifactInserts = prepared.artifacts
    .slice(1)
    .map((artifact) => artifactInsert(database, artifact));
  const dependencyInserts = bundle.recipe.package.skills.map((dependency) =>
    database.insert(artifactDependencies).values({
      recipeKind: "recipe",
      recipeName: bundle.recipe.package.name,
      recipeNamespace: publisher.namespace,
      recipeVersion: bundle.recipe.version,
      requirement: dependency.requirement,
      skillDigest: dependency.digest,
      skillName: dependency.name,
      skillNamespace: dependency.namespace,
      skillRegistry: dependency.registry,
      skillVersion: dependency.version,
    }),
  );
  const identity = `${publisher.namespace}/${bundle.recipe.package.name}`;
  const searchDocument = {
    description: bundle.recipe.package.discovery.description,
    identity,
    outcome: bundle.recipe.package.responsibility.outcome,
    requirements: prepared.result.recipe.requirements.capabilityIds
      .concat(prepared.result.recipe.requirements.integrations)
      .join(" "),
    summary: bundle.recipe.package.responsibility.summary,
    tags: bundle.recipe.package.discovery.tags.join(" "),
    title: bundle.recipe.package.responsibility.title,
  };
  const searchUpsert = database
    .insert(recipeSearchDocuments)
    .values(searchDocument)
    .onConflictDoUpdate({
      set: searchDocument,
      target: recipeSearchDocuments.identity,
    });
  const mutationInsert = database.insert(publishMutations).values({
    createdAt: now,
    githubUserId: publisher.githubUserId,
    idempotencyKey: bundle.idempotencyKey,
    requestDigest,
    responseJson: JSON.stringify(prepared.result),
  });
  const intentDelete = database
    .delete(publishUploadIntents)
    .where(
      and(
        eq(publishUploadIntents.githubUserId, publisher.githubUserId),
        eq(publishUploadIntents.idempotencyKey, bundle.idempotencyKey),
        eq(publishUploadIntents.phase, "finalizing"),
      ),
    );
  try {
    await database.batch([
      firstArtifactInsert,
      ...remainingArtifactInserts,
      ...dependencyInserts,
      searchUpsert,
      mutationInsert,
      intentDelete,
    ]);
  } catch (error) {
    const completed = await successfulPublication(
      env,
      publisher.githubUserId,
      bundle.idempotencyKey,
      requestDigest,
    );
    if (completed) return completed;
    throw new RegistryConflictError(error instanceof Error ? error.message : "publish_conflict");
  }
  return prepared.result;
}

export async function cleanupExpiredPublishIntents(
  env: Pick<RegistryEnv, "REGISTRY_DB" | "REGISTRY_PACKAGES">,
  now = Math.floor(Date.now() / 1_000),
  maximum = MAXIMUM_UPLOAD_INTENT_CLEANUPS,
): Promise<number> {
  const boundedMaximum = Math.max(1, Math.min(MAXIMUM_UPLOAD_INTENT_CLEANUPS, maximum));
  const cutoff = now - PUBLISH_UPLOAD_INTENT_TTL_SECONDS;
  const database = registryDatabase(env.REGISTRY_DB);
  const staleUpload = and(
    inArray(publishUploadIntents.phase, ["uploading", "finalizing"]),
    lt(publishUploadIntents.touchedAt, cutoff),
  );
  const expiredQuarantine = and(
    eq(publishUploadIntents.phase, "quarantine"),
    lt(publishUploadIntents.leaseStartedAt, cutoff),
  );
  const expiredCleanupLease = and(
    eq(publishUploadIntents.phase, "cleanup"),
    lt(publishUploadIntents.leaseStartedAt, cutoff),
  );
  const candidates = await database
    .select({
      githubUserId: publishUploadIntents.githubUserId,
      idempotencyKey: publishUploadIntents.idempotencyKey,
      phase: publishUploadIntents.phase,
    })
    .from(publishUploadIntents)
    .where(or(staleUpload, expiredQuarantine, expiredCleanupLease))
    .orderBy(asc(publishUploadIntents.touchedAt))
    .limit(boundedMaximum);
  let cleaned = 0;
  for (const candidate of candidates) {
    const identity = and(
      eq(publishUploadIntents.githubUserId, candidate.githubUserId),
      eq(publishUploadIntents.idempotencyKey, candidate.idempotencyKey),
    );
    if (candidate.phase === "uploading" || candidate.phase === "finalizing") {
      await database
        .update(publishUploadIntents)
        .set({ leaseStartedAt: now, phase: "quarantine" })
        .where(and(identity, staleUpload));
      continue;
    }
    const [claimed] = await database
      .update(publishUploadIntents)
      .set({ leaseStartedAt: now, phase: "cleanup" })
      .where(and(identity, or(expiredQuarantine, expiredCleanupLease)))
      .returning({ githubUserId: publishUploadIntents.githubUserId });
    if (!claimed) continue;
    try {
      const artifacts = await database
        .select({ objectKey: publishUploadArtifacts.objectKey })
        .from(publishUploadArtifacts)
        .where(
          and(
            eq(publishUploadArtifacts.githubUserId, candidate.githubUserId),
            eq(publishUploadArtifacts.idempotencyKey, candidate.idempotencyKey),
          ),
        )
        .orderBy(asc(publishUploadArtifacts.objectKey));
      for (const artifact of artifacts) {
        await env.REGISTRY_PACKAGES.delete(artifact.objectKey);
      }
      await database
        .delete(publishUploadIntents)
        .where(
          and(
            identity,
            eq(publishUploadIntents.phase, "cleanup"),
            eq(publishUploadIntents.leaseStartedAt, now),
          ),
        );
      cleaned += 1;
    } catch {
      // The retained claim becomes retryable after the bounded cleanup lease expires.
    }
  }
  return cleaned;
}

async function embeddings(env: RegistrySearchEnv, texts: readonly string[]): Promise<number[][]> {
  const output = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: texts.map((text) => text.slice(0, 8_192)),
  });
  if (
    typeof output !== "object" ||
    output === null ||
    !("data" in output) ||
    !Array.isArray(output.data)
  ) {
    throw new Error("Embedding unavailable");
  }
  const values = output.data.map((candidate) =>
    Array.isArray(candidate)
      ? candidate.filter((value): value is number => typeof value === "number")
      : [],
  );
  if (values.length !== texts.length || values.some((value) => value.length !== 384)) {
    throw new Error("Embedding unavailable");
  }
  return values;
}

async function embedding(env: RegistrySearchEnv, text: string): Promise<number[]> {
  const values = (await embeddings(env, [text]))[0];
  if (!values) throw new Error("Embedding unavailable");
  return values;
}

export async function indexPendingRecipes(env: RegistrySearchEnv, maximum = 25): Promise<number> {
  const database = registryDatabase(env.REGISTRY_DB);
  const rows = await database
    .select({
      name: artifactVersions.name,
      namespace: artifactVersions.namespace,
      searchDocument: artifactVersions.searchDocument,
      version: artifactVersions.version,
    })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.kind, "recipe"),
        eq(artifactVersions.semanticState, "pending"),
        eq(artifactVersions.lifecycle, "published"),
      ),
    )
    .orderBy(asc(artifactVersions.publishedAt))
    .limit(maximum);
  if (rows.length === 0) return 0;
  try {
    const values = await embeddings(
      env,
      rows.map(({ searchDocument }) => {
        if (searchDocument === null) throw new Error("Search document unavailable");
        return searchDocument;
      }),
    );
    await env.RECIPE_SEARCH_INDEX.upsert(
      rows.map((row, index) => {
        const vector = values[index];
        if (!vector) throw new Error("Embedding unavailable");
        return {
          id: `recipe:${row.namespace}:${row.name}`,
          metadata: { name: row.name, namespace: row.namespace, version: row.version },
          values: vector,
        };
      }),
    );
    const updates = rows.map((row) =>
      database
        .update(artifactVersions)
        .set({ semanticState: "indexed" })
        .where(
          and(
            eq(artifactVersions.kind, "recipe"),
            eq(artifactVersions.namespace, row.namespace),
            eq(artifactVersions.name, row.name),
            eq(artifactVersions.version, row.version),
          ),
        ),
    );
    const first = updates[0];
    if (!first) return 0;
    await database.batch([first, ...updates.slice(1)]);
    return rows.length;
  } catch {
    // A later cron retries without preventing the immutable publication from succeeding.
    return 0;
  }
}

function projectionReasons(query: string, projection: RecipeRegistryProjection) {
  const normalized = query.toLowerCase();
  const reasons = new Set<RegistryRecipeSearchResult["matchReasons"][number]>();
  if (projection.title.toLowerCase().includes(normalized)) reasons.add("title");
  if (
    projection.outcome.toLowerCase().includes(normalized) ||
    projection.summary.toLowerCase().includes(normalized) ||
    projection.description.toLowerCase().includes(normalized)
  ) {
    reasons.add("outcome");
  }
  if (projection.tags.some((tag) => normalized.includes(tag) || tag.includes(normalized))) {
    reasons.add("tag");
  }
  if (projection.requirements.capabilityIds.some((id) => normalized.includes(id))) {
    reasons.add("capability");
  }
  if (projection.requirements.integrations.some((id) => normalized.includes(id))) {
    reasons.add("integration");
  }
  if (projection.deliverables.some((kind) => normalized.includes(kind))) reasons.add("deliverable");
  if (reasons.size === 0) reasons.add("outcome");
  return [...reasons];
}

async function projectionsByIdentities(
  env: Pick<RegistrySearchEnv, "REGISTRY_DB">,
  identities: readonly string[],
): Promise<Map<string, RecipeRegistryProjection>> {
  if (identities.length === 0) return new Map();
  const identity = sql<string>`${artifactVersions.namespace} || '/' || ${artifactVersions.name}`;
  const rows = await registryDatabase(env.REGISTRY_DB)
    .select({ identity, projectionJson: artifactVersions.projectionJson })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.kind, "recipe"),
        eq(artifactVersions.lifecycle, "published"),
        inArray(identity, identities),
      ),
    )
    .orderBy(desc(artifactVersions.version));
  const projections = new Map<string, RecipeRegistryProjection>();
  for (const row of rows) {
    if (!projections.has(row.identity)) {
      projections.set(row.identity, parseRecipeProjection(row.projectionJson));
    }
  }
  return projections;
}

async function semanticSearch(
  env: RegistrySearchEnv,
  query: string,
  limit: number,
): Promise<RegistryRecipeSearchResult[]> {
  const result = await env.RECIPE_SEARCH_INDEX.query(await embedding(env, query), {
    returnMetadata: "indexed",
    topK: Math.min(limit * 3, 50),
  });
  const candidates = result.matches.flatMap((match) => {
    const namespace = match.metadata?.namespace;
    const name = match.metadata?.name;
    return typeof namespace === "string" && typeof name === "string"
      ? [{ identity: `${namespace}/${name}`, score: Math.max(0, Math.min(1, match.score)) }]
      : [];
  });
  const projections = await projectionsByIdentities(
    env,
    candidates.map(({ identity }) => identity),
  );
  return candidates
    .flatMap(({ identity, score }) => {
      const recipe = projections.get(identity);
      return recipe ? [{ matchReasons: projectionReasons(query, recipe), recipe, score }] : [];
    })
    .slice(0, limit);
}

function ftsQuery(query: string): string {
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9.-]{1,39}/gu)
      ?.slice(0, 12)
      .map((token) => `"${token.replaceAll('"', '""')}"*`)
      .join(" OR ") ?? '"__no_match__"'
  );
}

async function lexicalSearch(
  env: RegistrySearchEnv,
  query: string,
  limit: number,
): Promise<RegistryRecipeSearchResult[]> {
  const rows = await registryDatabase(env.REGISTRY_DB).all<{ identity: string }>(
    sql`SELECT identity FROM recipe_search
          WHERE recipe_search MATCH ${ftsQuery(query)}
          ORDER BY bm25(recipe_search) LIMIT ${limit}`,
  );
  const identities = rows.map(({ identity }) => identity);
  const projections = await projectionsByIdentities(env, identities);
  return identities.flatMap((identity, index) => {
    const recipe = projections.get(identity);
    return recipe
      ? [
          {
            matchReasons: projectionReasons(query, recipe),
            recipe,
            score: Math.max(0.5, 1 - index / Math.max(10, identities.length)),
          },
        ]
      : [];
  });
}

export async function searchRecipes(
  env: RegistrySearchEnv,
  query: string,
  limit: number,
): Promise<RegistryRecipeSearchResponse> {
  try {
    const results = await semanticSearch(env, query, limit);
    if (results.length > 0) {
      return registryRecipeSearchResponseSchema.parse({
        query,
        results,
        retrieval: "semantic",
        searchVersion: 1,
      });
    }
  } catch {
    // The bounded FTS projection keeps discovery available during AI or Vectorize outages.
  }
  return registryRecipeSearchResponseSchema.parse({
    query,
    results: await lexicalSearch(env, query, limit),
    retrieval: "lexical_fallback",
    searchVersion: 1,
  });
}

export async function latestRecipe(
  env: RegistryEnv,
  namespace: string,
  name: string,
): Promise<RecipeRegistryProjection | null> {
  const [row] = await registryDatabase(env.REGISTRY_DB)
    .select({ projectionJson: artifactVersions.projectionJson })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.kind, "recipe"),
        eq(artifactVersions.namespace, namespace),
        eq(artifactVersions.name, name),
        eq(artifactVersions.lifecycle, "published"),
      ),
    )
    .orderBy(desc(artifactVersions.version))
    .limit(1);
  return row ? parseRecipeProjection(row.projectionJson) : null;
}

export async function latestSkill(
  env: RegistryEnv,
  namespace: string,
  name: string,
): Promise<RegistrySkillProjection | null> {
  const [row] = await registryDatabase(env.REGISTRY_DB)
    .select({ projectionJson: artifactVersions.projectionJson })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.kind, "skill"),
        eq(artifactVersions.namespace, namespace),
        eq(artifactVersions.name, name),
        eq(artifactVersions.lifecycle, "published"),
      ),
    )
    .orderBy(desc(artifactVersions.version))
    .limit(1);
  return row
    ? registrySkillProjectionSchema.parse(JSON.parse(row.projectionJson) as unknown)
    : null;
}

export async function artifactVersion(
  env: RegistryEnv,
  kind: "recipe" | "skill",
  namespace: string,
  name: string,
  version: number,
): Promise<{ envelope: RegistryArtifactVersionEnvelope; key: string; projection: unknown } | null> {
  const [row] = await registryDatabase(env.REGISTRY_DB)
    .select({
      digest: artifactVersions.digest,
      lifecycle: artifactVersions.lifecycle,
      projectionJson: artifactVersions.projectionJson,
      publishedAt: artifactVersions.publishedAt,
      review: artifactVersions.review,
      sizeBytes: artifactVersions.sizeBytes,
    })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.kind, kind),
        eq(artifactVersions.namespace, namespace),
        eq(artifactVersions.name, name),
        eq(artifactVersions.version, version),
      ),
    )
    .limit(1);
  if (!row) return null;
  const projection = parseArtifactProjection(kind, row.projectionJson);
  const envelope: RegistryArtifactVersionEnvelope =
    kind === "recipe"
      ? {
          contentTrust: "untrusted",
          coordinate: { kind: "recipe", name, namespace, version },
          kind: "recipe",
          lifecycle: row.lifecycle,
          package: { digest: row.digest, sizeBytes: row.sizeBytes },
          publishedAt: new Date(row.publishedAt * 1_000).toISOString(),
          publisher: projection.publisher,
          review: row.review,
        }
      : {
          contentTrust: "untrusted",
          coordinate: { kind: "skill", name, namespace, version },
          kind: "skill",
          lifecycle: row.lifecycle,
          package: { digest: row.digest, sizeBytes: row.sizeBytes },
          publishedAt: new Date(row.publishedAt * 1_000).toISOString(),
          publisher: projection.publisher,
          review: row.review,
        };
  return { envelope, key: packageObjectKey(envelope), projection };
}
