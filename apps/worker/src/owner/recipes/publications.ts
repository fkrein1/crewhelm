import {
  inspectPublicSkill,
  recipePackageSchema,
  recipePublicationPlanSchema,
  recipePublicationToolInputSchema,
  recipePublicationToolResultSchema,
  registryPublishBundleSchema,
  registrySkillPackageSchema,
  SKILLS_CAPABILITY_ID,
  type OwnerAuthority,
  type RecipePublicationCandidate,
  type RecipePublicationPlan,
  type RecipePublicationToolResult,
  type RegistryPublishBundle,
  type RegistrySkillPackage,
  type SkillPackage,
} from "@crewhelm/contracts";

import type { AgentRegistry } from "../agents/index.js";
import type { Skills } from "../skills/index.js";
import { RecipeRegistryClientError } from "./registry-client.js";
import type { RecipeRegistryClient } from "./registry-client.js";

type FailureCode = Extract<RecipePublicationToolResult, { ok: false }>["error"]["code"];

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
  readonly #registry: RecipeRegistryClient;
  readonly #signingSecret: string;
  readonly #skills: Skills;

  constructor(
    registry: RecipeRegistryClient,
    agents: AgentRegistry,
    skills: Skills,
    signingSecret: string,
  ) {
    this.#agents = agents;
    this.#registry = registry;
    this.#skills = skills;
    this.#signingSecret = signingSecret;
  }

  async handle(authority: OwnerAuthority, input: unknown): Promise<RecipePublicationToolResult> {
    const request = recipePublicationToolInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
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
      if (!built.plan.ready) return denied("rehearsal_required");
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
      blockingReasons: skillPreview.some(({ decision }) => decision === "remove")
        ? (["skill_removal_rehearsal_required"] as const)
        : [],
      exclusions: PUBLIC_EXCLUSIONS,
      ready: !skillPreview.some(({ decision }) => decision === "remove"),
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
