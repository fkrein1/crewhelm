import {
  inspectPublicSkill,
  recipePackageSchema,
  recipePublicationCandidateSchema,
  recipePublicationPlanSchema,
  recipePublicationToolInputSchema,
  recipePublicationToolResultSchema,
  registryPublishBundleSchema,
  registrySkillPackageSchema,
  SKILLS_CAPABILITY_ID,
  type ExternalToolCapabilityGrant,
  type OwnerAuthority,
  type RecipePublicationCandidate,
  type RecipePublicationPlan,
  type RecipePublicationToolResult,
  type RegistryPublishBundle,
  type RegistrySkillPackage,
  type SkillPackage,
} from "@crewhelm/contracts";
import { and, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { AgentRegistry } from "../agents/index.js";
import type { Briefs } from "../briefs/index.js";
import type { AgentEventTriggers } from "../event-triggers/index.js";
import {
  capabilityGrants,
  remoteMcpConnections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import type { AgentSchedules } from "../schedules/index.js";
import type { Skills } from "../skills/index.js";
import { RecipeRegistryClientError } from "./registry-client.js";
import type { RecipeRegistryClient } from "./registry-client.js";

type FailureCode = Extract<RecipePublicationToolResult, { ok: false }>["error"]["code"];
type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;

const encoder = new TextEncoder();
const PUBLIC_EXCLUSIONS = [
  "briefs",
  "connection_credentials",
  "grants",
  "history",
  "owner_local_ids",
  "runtime_telemetry",
] as const;

function denied(code: FailureCode): RecipePublicationToolResult {
  return recipePublicationToolResultSchema.parse({
    error: { code, message: "Recipe publication request denied." },
    ok: false,
  });
}

export function deniedRecipePublication(code: FailureCode): RecipePublicationToolResult {
  return denied(code);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonical(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function publicationVerifier(
  secret: string,
  authority: OwnerAuthority,
  idempotencyKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify([
        "crewhelm.recipe-publication.v1",
        authority.ownerKey,
        authority.clientId,
        idempotencyKey,
      ]),
    ),
  );
  return base64Url(new Uint8Array(signature));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function portableName(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replaceAll(/-+$/gu, "");
  return /^[a-z]/u.test(normalized) ? normalized : fallback;
}

function uniquePortableName(
  value: string,
  fallback: string,
  used: Set<string>,
  maximumCharacters = 80,
): string {
  const base = portableName(value, fallback).slice(0, maximumCharacters).replace(/-+$/u, "");
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const ending = `-${suffix}`;
    candidate = `${base.slice(0, maximumCharacters - ending.length).replace(/-+$/u, "")}${ending}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function narrowestLimits(grants: ExternalToolCapabilityGrant[]) {
  const values = grants.map(({ limits }) => limits);
  const minimum = (key: keyof (typeof values)[number]) =>
    Math.min(...values.map((limits) => limits[key]));
  return {
    maxCallsPerRun: minimum("maxCallsPerRun"),
    maxConcurrency: minimum("maxConcurrency"),
    maxCostMicrousdPerCall: minimum("maxCostMicrousdPerCall"),
    maxDurationMs: minimum("maxDurationMs"),
    maxOutputBytes: minimum("maxOutputBytes"),
  };
}

function portableExpiry(grants: ExternalToolCapabilityGrant[], preparedAt: number): number | null {
  const expirations = grants.flatMap(({ expiresAt }) =>
    expiresAt === null ? [] : [Date.parse(expiresAt)],
  );
  if (expirations.length === 0) return null;
  const remaining = Math.floor((Math.min(...expirations) - preparedAt) / 1_000);
  return Math.max(60, Math.min(365 * 24 * 60 * 60, remaining));
}

function localSkillPackage(value: {
  description: string;
  files: SkillPackage["files"];
  name: string;
  provenance: SkillPackage["provenance"];
}): SkillPackage {
  return {
    description: value.description,
    files: value.files,
    name: value.name,
    provenance: value.provenance,
  };
}

function renderedAgentMatches(
  candidate: RecipePublicationCandidate["recipe"],
  agent: { capabilities: unknown; executionLimits: unknown; instructions: string; name: string },
): boolean {
  const values = new Map<string, string | number | boolean>();
  for (const parameter of candidate.setupParameters) {
    if (parameter.default === undefined) return false;
    values.set(parameter.name, parameter.default);
  }
  const render = (value: string) =>
    value.replace(/\{\{([a-z][a-z0-9-]{0,39})\}\}/gu, (token, name: string) =>
      values.has(name) ? String(values.get(name)) : token,
    );
  return (
    render(candidate.agent.suggestedName) === agent.name &&
    render(candidate.agent.instructions) === agent.instructions &&
    sameCanonical(candidate.agent.capabilities, agent.capabilities) &&
    sameCanonical(candidate.agent.executionLimits, agent.executionLimits)
  );
}

function registryError(error: unknown): RecipePublicationToolResult {
  if (error instanceof RecipeRegistryClientError) {
    switch (error.code) {
      case "authorization_pending":
      case "registry_conflict":
      case "registry_unavailable":
        return denied(error.code);
      case "artifact_not_found":
      case "artifact_restricted":
        return denied("registry_unavailable");
    }
  }
  return denied("registry_unavailable");
}

export class RecipePublications {
  readonly #agents: AgentRegistry;
  readonly #briefs: Briefs;
  readonly #database: Database;
  readonly #eventTriggers: AgentEventTriggers;
  readonly #registry: RecipeRegistryClient;
  readonly #schedules: AgentSchedules;
  readonly #signingSecret: string;
  readonly #skills: Skills;

  constructor(
    database: Database,
    registry: RecipeRegistryClient,
    agents: AgentRegistry,
    skills: Skills,
    briefs: Briefs,
    schedules: AgentSchedules,
    eventTriggers: AgentEventTriggers,
    signingSecret: string,
  ) {
    this.#agents = agents;
    this.#briefs = briefs;
    this.#database = database;
    this.#eventTriggers = eventTriggers;
    this.#registry = registry;
    this.#schedules = schedules;
    this.#skills = skills;
    this.#signingSecret = signingSecret;
  }

  async handle(authority: OwnerAuthority, input: unknown): Promise<RecipePublicationToolResult> {
    const request = recipePublicationToolInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    if (request.data.action === "prepare_publish") {
      return this.#prepareCandidate(request.data);
    }
    const verifier = await publicationVerifier(
      this.#signingSecret,
      authority,
      request.data.idempotencyKey,
    );

    try {
      if (request.data.action === "authorize_publish") {
        const challenge = await sha256(encoder.encode(verifier));
        return recipePublicationToolResultSchema.parse({
          action: "authorize_publish",
          authorization: await this.#registry.createPublishAuthorization({
            challenge,
            idempotencyKey: request.data.idempotencyKey,
            installationLabel: request.data.installationLabel,
          }),
          ok: true,
        });
      }

      const authorization = await this.#registry.resolvePublishAuthorization(
        request.data.authorizationId,
        verifier,
      );
      const built = await this.#buildPlan(
        request.data.candidate,
        authorization,
        request.data.idempotencyKey,
      );
      if (!built.ok) return built.result;
      if (request.data.action === "preview_publish") {
        return recipePublicationToolResultSchema.parse({
          action: "preview_publish",
          ok: true,
          plan: built.plan,
        });
      }
      if (request.data.expectedConfirmationDigest !== built.plan.confirmationDigest) {
        return denied("stale_preview");
      }
      if (!built.plan.ready) return denied("public_package_invalid");
      return recipePublicationToolResultSchema.parse({
        action: "publish",
        ok: true,
        publication: await this.#registry.publish(built.bundle, {
          id: request.data.authorizationId,
          verifier,
        }),
      });
    } catch (error) {
      return registryError(error);
    }
  }

  async #prepareCandidate(
    input: Extract<
      ReturnType<typeof recipePublicationToolInputSchema.parse>,
      { action: "prepare_publish" }
    >,
  ): Promise<RecipePublicationToolResult> {
    const localAgent = this.#agents.getRevision(input.agent);
    if (!localAgent.ok) return denied("agent_not_found");
    const resolved = this.#agents.resolveDefinition(localAgent.agent);
    if (!resolved.ok) return denied("public_package_invalid");

    const listedSchedules = this.#schedules.list({ agentId: input.agent.id });
    if (!listedSchedules.ok) return denied("agent_not_found");
    const schedules = input.scheduleIds
      .toSorted()
      .map((id) => listedSchedules.schedules.find((schedule) => schedule.id === id));
    const listedEventTriggers = this.#eventTriggers.list(input.agent.id);
    const eventTriggers = input.eventTriggerIds
      .toSorted()
      .map((id) => listedEventTriggers.find((eventTrigger) => eventTrigger.id === id));
    if (
      schedules.some(
        (schedule) =>
          schedule === undefined ||
          schedule.agentRevision !== input.agent.revision ||
          schedule.configuration === null,
      ) ||
      eventTriggers.some(
        (eventTrigger) =>
          eventTrigger === undefined || eventTrigger.agentRevision !== input.agent.revision,
      )
    ) {
      return denied("public_package_invalid");
    }
    const selectedSchedules = schedules.flatMap((schedule) =>
      schedule === undefined || schedule.configuration === null ? [] : [schedule],
    );
    const selectedEventTriggers = eventTriggers.flatMap((eventTrigger) =>
      eventTrigger === undefined ? [] : [eventTrigger],
    );

    const usedInputNames = new Set<string>();
    const briefInputByReference = new Map<string, string>();
    const inputs: RecipePublicationCandidate["recipe"]["inputs"] = [];
    const allBriefs = [
      ...selectedSchedules.flatMap(({ configuration }) =>
        configuration !== null && "briefs" in configuration ? (configuration.briefs ?? []) : [],
      ),
      ...selectedEventTriggers.flatMap(({ definition }) => definition.briefs ?? []),
    ];
    for (const reference of allBriefs) {
      const key = `${reference.id}:${reference.revision}`;
      if (briefInputByReference.has(key)) continue;
      const inspected = this.#briefs.inspect(reference);
      if (!inspected.ok) return denied("public_package_invalid");
      const name = uniquePortableName(inspected.brief.name, "brief", usedInputNames, 40);
      briefInputByReference.set(key, name);
      inputs.push({
        description: `Owner-provided ${inspected.brief.name} context.`,
        kind: "brief",
        name,
        required: true,
      });
    }
    inputs.sort((left, right) => left.name.localeCompare(right.name));
    const briefInputNames = (references: typeof allBriefs) =>
      references
        .map((reference) => briefInputByReference.get(`${reference.id}:${reference.revision}`))
        .flatMap((name) => (name === undefined ? [] : [name]))
        .toSorted();

    const usedConnectionSlots = new Set<string>();
    const connectionSlotById = new Map<string, string>();
    const preparedAt = Date.now();
    const grantRows = this.#database
      .select({ connectionId: capabilityGrants.connectionId, grant: capabilityGrants.grant })
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.agentId, input.agent.id),
          eq(capabilityGrants.agentRevision, input.agent.revision),
          eq(capabilityGrants.status, "active"),
        ),
      )
      .all()
      .filter(
        ({ grant }) =>
          grant.expiresAt === null || Date.parse(grant.expiresAt) - preparedAt >= 60_000,
      );
    const grantsByConnection = Map.groupBy(grantRows, ({ connectionId }) => connectionId);
    const connectionIds = new Set([
      ...grantsByConnection.keys(),
      ...selectedEventTriggers.map(({ definition }) => definition.source.connectionId),
    ]);
    const connections: RecipePublicationCandidate["recipe"]["connections"] = [];
    for (const connectionId of connectionIds) {
      const grants = (grantsByConnection.get(connectionId) ?? []).map(({ grant }) => grant);
      const composioGrants = grants.filter(
        (grant) => grant.capabilityId === "composio.tool.execute",
      );
      const event = selectedEventTriggers.find(
        ({ definition }) => definition.source.connectionId === connectionId,
      );
      if (composioGrants.length > 0 || event !== undefined) {
        const integration =
          composioGrants[0]?.integrationSlug ?? event?.definition.source.integrationSlug;
        if (integration === undefined) return denied("public_package_invalid");
        const slot = uniquePortableName(integration, "connection", usedConnectionSlots, 40);
        connectionSlotById.set(connectionId, slot);
        connections.push({
          description: `Connect the owner's ${integration} account.`,
          expiresAfterSeconds:
            composioGrants.length === 0 ? null : portableExpiry(composioGrants, preparedAt),
          integration,
          kind: "composio",
          limits:
            composioGrants.length === 0
              ? {
                  maxCallsPerRun: 1,
                  maxConcurrency: 1,
                  maxCostMicrousdPerCall: 0,
                  maxDurationMs: 30_000,
                  maxOutputBytes: 16_384,
                }
              : narrowestLimits(composioGrants),
          slot,
          tools: composioGrants
            .map((grant) => ({
              authorization: grant.authorization,
              effect: grant.effect,
              slug: grant.toolSlug,
              version: grant.toolkitVersion,
            }))
            .toSorted((left, right) =>
              `${left.slug}:${left.version}`.localeCompare(`${right.slug}:${right.version}`),
            ),
        });
        continue;
      }

      const remoteGrants = grants.filter(
        (grant) => grant.capabilityId === "remote_mcp.tool.execute",
      );
      if (remoteGrants.length === 0) continue;
      const remote = this.#database
        .select()
        .from(remoteMcpConnections)
        .where(eq(remoteMcpConnections.connectionId, connectionId))
        .get();
      if (remote === undefined) return denied("public_package_invalid");
      const slot = uniquePortableName(remote.serverName, "remote-mcp", usedConnectionSlots, 40);
      connectionSlotById.set(connectionId, slot);
      connections.push({
        apiKeyHeaderName: remote.apiKeyHeaderName ?? undefined,
        authKind: remote.authKind,
        authorization: remoteGrants.some(
          ({ authorization }) => authorization === "approval_required",
        )
          ? "approval_required"
          : "standing",
        description: `Connect the reviewed ${remote.serverName} MCP server.`,
        endpoint: remote.endpoint,
        expiresAfterSeconds: portableExpiry(remoteGrants, preparedAt),
        kind: "remote_mcp",
        limits: narrowestLimits(remoteGrants),
        oauthScopes: remote.oauthScopes,
        requiredTools: remoteGrants
          .map(({ effect, toolName }) => ({
            effect: effect === "destructive" ? ("destructive" as const) : ("write" as const),
            name: toolName,
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name)),
        reviewedSnapshotDigest: remote.snapshotDigest,
        reviewedToolCount: remote.catalog.length,
        slot,
      });
    }
    connections.sort((left, right) => left.slot.localeCompare(right.slot));

    const usedOperationNames = new Set(["run"]);
    const operations = {
      eventTriggers: selectedEventTriggers
        .map(({ definition }) => {
          const connectionSlot = connectionSlotById.get(definition.source.connectionId);
          if (connectionSlot === undefined) return null;
          return {
            briefInputNames: briefInputNames(definition.briefs ?? []),
            connectionSlot,
            delivery: definition.source.delivery,
            eventSlug: definition.source.sourceSlug,
            eventVersion: definition.source.sourceVersion,
            filters: definition.source.configuration,
            instruction: definition.instruction,
            integration: definition.source.integrationSlug,
            name: uniquePortableName(definition.name, "event-trigger", usedOperationNames),
            outputContract: definition.outputContract ?? { kind: "markdown" as const },
          };
        })
        .flatMap((operation) => (operation === null ? [] : [operation]))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      primary: {
        inputNames: [],
        kind: "run" as const,
        name: "run",
        outputContract: { kind: "markdown" as const },
        prompt: "Complete the Agent's responsibility and return the most useful bounded result.",
      },
      schedules: selectedSchedules
        .map(({ configuration, name }) => {
          if (configuration === null) throw new Error("Selected Schedule lost its definition.");
          return {
            briefInputNames: briefInputNames(
              "briefs" in configuration ? (configuration.briefs ?? []) : [],
            ),
            instruction: configuration.prompt,
            name: uniquePortableName(name, "schedule", usedOperationNames),
            outputContract:
              "outputContract" in configuration
                ? (configuration.outputContract ?? { kind: "markdown" as const })
                : { kind: "markdown" as const },
            trigger:
              "trigger" in configuration
                ? configuration.trigger.type === "calendar"
                  ? { ...configuration.trigger, timeZone: "owner-selected" as const }
                  : configuration.trigger
                : { intervalSeconds: configuration.intervalSeconds, type: "interval" as const },
          };
        })
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    };
    const publicCapabilities = resolved.agent.capabilities.filter(
      ({ id }) => id !== SKILLS_CAPABILITY_ID,
    );
    const trimmedInstructions = resolved.agent.instructions.trim();
    const portableInstructions = trimmedInstructions || resolved.agent.name;
    const summary = portableInstructions.replaceAll(/\s+/gu, " ").slice(0, 320);
    const outcome = portableInstructions.slice(0, 2_048);
    const skills = resolved.skills.map(({ id, version }) => ({
      decision: "publish" as const,
      license: input.license,
      local: { id, version },
      requirement: "required" as const,
    }));
    const candidate = recipePublicationCandidateSchema.safeParse({
      agent: input.agent,
      recipe: {
        agent: {
          capabilities: publicCapabilities,
          executionLimits: resolved.agent.executionLimits,
          instructions: resolved.agent.instructions,
          suggestedName: resolved.agent.name,
        },
        connections,
        discovery: {
          description: summary,
          license: input.license,
          provenance: { kind: "authored" },
          tags: [],
        },
        inputs,
        name: portableName(resolved.agent.name, "agent-recipe"),
        operations,
        responsibility: {
          boundaries: ["Use only the authority the owner explicitly grants."],
          outcome,
          summary,
          title: resolved.agent.name,
        },
        sampleDeliverable: {
          content: "A bounded result produced from the configured responsibility.",
          kind: "markdown",
        },
        schemaVersion: 1,
        setupParameters: [],
      },
      skills,
    });
    if (!candidate.success) return denied("public_package_invalid");
    if (!recipePackageSchema.safeParse({ ...candidate.data.recipe, skills: [] }).success) {
      return denied("public_package_invalid");
    }
    return recipePublicationToolResultSchema.parse({
      action: "prepare_publish",
      candidate: candidate.data,
      nextAction: "preview_publish",
      ok: true,
      review: {
        connections: "Review portable requirements and requested authority.",
        publicCopy: "Review the title, summary, outcome, boundaries, tags, and sample.",
        skills: "Choose publish, reference, or remove for every local Skill.",
      },
    });
  }

  async #buildPlan(
    candidate: RecipePublicationCandidate,
    authorization: RecipePublicationPlan["authorization"],
    idempotencyKey: string,
  ): Promise<
    | { bundle: RegistryPublishBundle; ok: true; plan: RecipePublicationPlan }
    | { ok: false; result: RecipePublicationToolResult }
  > {
    const localAgent = this.#agents.getRevision(candidate.agent);
    if (!localAgent.ok) return { ok: false, result: denied("agent_not_found") };
    const resolved = this.#agents.resolveDefinition(localAgent.agent);
    if (!resolved.ok) return { ok: false, result: denied("public_package_invalid") };
    const publicCapabilities = resolved.agent.capabilities.filter(
      ({ id }) => id !== SKILLS_CAPABILITY_ID,
    );
    if (
      !renderedAgentMatches(candidate.recipe, {
        capabilities: publicCapabilities,
        executionLimits: resolved.agent.executionLimits,
        instructions: resolved.agent.instructions,
        name: resolved.agent.name,
      })
    ) {
      return { ok: false, result: denied("public_package_invalid") };
    }

    const expectedSkills = resolved.skills.map(({ id, version }) => `${id}:${version}`).toSorted();
    const decidedSkills = candidate.skills
      .map(({ local }) => `${local.id}:${local.version}`)
      .toSorted();
    if (!sameCanonical(expectedSkills, decidedSkills)) {
      return { ok: false, result: denied("skill_decisions_incomplete") };
    }

    const publishedPackages: RegistrySkillPackage[] = [];
    const dependencies: RecipePublicationPlan["recipe"]["package"]["skills"] = [];
    const skillPreview: RecipePublicationPlan["skills"] = [];
    for (const decision of candidate.skills) {
      const local = await this.#skills.get({
        target: { ...decision.local, kind: "skill-package" },
      });
      if (!local.ok) return { ok: false, result: denied("skill_not_found") };
      const source = localSkillPackage(local.version);
      if (decision.decision === "remove") {
        skillPreview.push(decision);
        continue;
      }
      if (decision.decision === "reference") {
        if (decision.target.registry !== this.#registry.origin) {
          return { ok: false, result: denied("skill_mismatch") };
        }
        const publicSkill = await this.#registry.skill({ ...decision.target, kind: "skill" });
        const comparable = localSkillPackage(publicSkill.package);
        if (!sameCanonical(source, comparable)) {
          return { ok: false, result: denied("skill_mismatch") };
        }
        dependencies.push({ ...decision.target, requirement: decision.requirement });
        skillPreview.push(decision);
        continue;
      }

      const publicPackage = registrySkillPackageSchema.safeParse({
        ...source,
        license: decision.license,
        schemaVersion: 1,
      });
      if (!publicPackage.success) {
        return { ok: false, result: denied("public_package_invalid") };
      }
      const warnings = inspectPublicSkill(publicPackage.data);
      if (warnings.suspectedSecrets > 0 || warnings.suspectedPrivateIdentifiers > 0) {
        return { ok: false, result: denied("public_package_invalid") };
      }
      const bytes = canonicalBytes(publicPackage.data);
      const digest = await sha256(bytes);
      const latest = await this.#registry.latestSkill(
        authorization.publisher.namespace,
        publicPackage.data.name,
      );
      if (latest?.package.digest === digest) {
        return { ok: false, result: denied("skill_mismatch") };
      }
      const version = (latest?.artifact.version ?? 0) + 1;
      publishedPackages.push(publicPackage.data);
      dependencies.push({
        digest,
        name: publicPackage.data.name,
        namespace: authorization.publisher.namespace,
        registry: this.#registry.origin,
        requirement: decision.requirement,
        version,
      });
      skillPreview.push({
        decision: "publish",
        digest,
        filePaths: publicPackage.data.files.map(({ path }) => path),
        license: decision.license,
        local: decision.local,
        name: publicPackage.data.name,
        provenance: publicPackage.data.provenance,
        requirement: decision.requirement,
        sizeBytes: bytes.byteLength,
        version,
        warnings,
      });
    }

    const recipe = recipePackageSchema.safeParse({
      ...candidate.recipe,
      skills: dependencies.toSorted((left, right) =>
        `${left.registry}:${left.namespace}:${left.name}`.localeCompare(
          `${right.registry}:${right.namespace}:${right.name}`,
        ),
      ),
    });
    if (!recipe.success) return { ok: false, result: denied("public_package_invalid") };
    const latestRecipe = await this.#registry.latestRecipe(
      authorization.publisher.namespace,
      recipe.data.name,
    );
    if (latestRecipe?.package.digest === (await sha256(canonicalBytes(recipe.data)))) {
      return { ok: false, result: denied("no_changes") };
    }
    const recipeVersion = (latestRecipe?.artifact.version ?? 0) + 1;
    const publishedByName = new Map(publishedPackages.map((skill) => [skill.name, skill]));
    const bundle = registryPublishBundleSchema.parse({
      idempotencyKey,
      namespace: authorization.publisher.namespace,
      recipe: { package: recipe.data, version: recipeVersion },
      skills: skillPreview.flatMap((preview) => {
        if (preview.decision !== "publish") return [];
        const skill = publishedByName.get(preview.name);
        return skill ? [{ package: skill, version: preview.version }] : [];
      }),
    });
    const planWithoutDigest = {
      authorization,
      blockingReasons: [],
      exclusions: PUBLIC_EXCLUSIONS,
      ready: true,
      recipe: bundle.recipe,
      registry: this.#registry.origin,
      skills: skillPreview,
      source: candidate.agent,
    };
    const plan = recipePublicationPlanSchema.parse({
      ...planWithoutDigest,
      confirmationDigest: await sha256(canonicalBytes({ bundle, ...planWithoutDigest })),
    });
    return { bundle, ok: true, plan };
  }
}
