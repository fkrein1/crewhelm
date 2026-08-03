import {
  agentCapabilityConfigurationsSchema,
  agentInstructionsSchema,
  agentNameSchema,
  MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS,
  recipeInstallationPlanSchema,
  recipeInstallationReceiptSchema,
  recipePreviewRequestSchema,
  recipeToolInputSchema,
  recipeToolResultSchema,
  registrySkillPackageSchema,
  registrySearchQuerySchema,
  type OwnerAuthority,
  type RecipePackage,
  type RecipeInstallationPlan,
  type RecipePreviewRequest,
  type RecipeToolResult,
  type RegistrySkillPackage,
  type SkillPackage,
} from "@crewhelm/contracts";
import { and, count, desc, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { skillsCapabilityConfiguration } from "../../agent-capabilities/skills.js";
import type { AgentRegistry } from "../agents/index.js";
import {
  auditEvents,
  connections,
  integrationEnablementRequests,
  recipeInstallations,
  remoteMcpConnections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import type { Skills } from "../skills/index.js";
import { localSkillPackageDigest, RecipeRegistryClientError } from "./registry-client.js";
import type { RecipeRegistryClient } from "./registry-client.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type FailureCode = Extract<RecipeToolResult, { ok: false }>["error"]["code"];

const parameterToken = /\{\{([a-z][a-z0-9-]{0,39})\}\}/g;
const encoder = new TextEncoder();

function denied(code: FailureCode, installationId?: string): RecipeToolResult {
  return recipeToolResultSchema.parse({
    error: {
      code,
      message: "Recipe request denied.",
      ...(installationId === undefined ? {} : { recovery: { installationId, retry: "recover" } }),
    },
    ok: false,
  });
}

export function deniedRecipe(code: FailureCode): RecipeToolResult {
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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: unknown): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(canonical(value)));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function validParameterValue(
  parameter: RecipePackage["setupParameters"][number],
  value: unknown,
): value is string | number | boolean {
  switch (parameter.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        (parameter.minimum === undefined || value >= parameter.minimum) &&
        (parameter.maximum === undefined || value <= parameter.maximum)
      );
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function importedSkillName(namespace: string, name: string, sourceDigest: string): string {
  const suffix = `-${sourceDigest.slice(0, 8)}`;
  return `recipe-${namespace}-${name}`.slice(0, 80 - suffix.length).replace(/-+$/u, "") + suffix;
}

function localSkillPackage(
  namespace: string,
  sourceDigest: string,
  skillPackage: RegistrySkillPackage,
): SkillPackage {
  return {
    description: skillPackage.description,
    files: skillPackage.files,
    name: importedSkillName(namespace, skillPackage.name, sourceDigest),
    provenance: skillPackage.provenance,
  };
}

function registryFailure(error: unknown): RecipeToolResult {
  return denied(error instanceof RecipeRegistryClientError ? error.code : "registry_unavailable");
}

export class Recipes {
  readonly #agents: AgentRegistry;
  readonly #database: Database;
  readonly #registry: RecipeRegistryClient;
  readonly #skills: Skills;

  constructor(
    database: Database,
    registry: RecipeRegistryClient,
    agents: AgentRegistry,
    skills: Skills,
  ) {
    this.#agents = agents;
    this.#database = database;
    this.#registry = registry;
    this.#skills = skills;
  }

  async handle(authority: OwnerAuthority, input: unknown): Promise<RecipeToolResult> {
    const request = recipeToolInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");

    try {
      switch (request.data.action) {
        case "search": {
          const query = registrySearchQuerySchema.parse({
            limit: request.data.limit,
            query: request.data.query,
          });
          return recipeToolResultSchema.parse({
            action: "search",
            ok: true,
            registry: this.#registry.origin,
            response: await this.#registry.search(query.query, query.limit),
          });
        }
        case "inspect": {
          if (request.data.target.registry !== this.#registry.origin)
            return denied("invalid_request");
          const artifact = await this.#registry.recipe(request.data.target);
          return recipeToolResultSchema.parse({
            action: "inspect",
            ok: true,
            package: artifact.package,
            recipe: artifact.projection,
          });
        }
        case "read_skill": {
          if (request.data.target.registry !== this.#registry.origin)
            return denied("invalid_request");
          const artifact = await this.#registry.skill(request.data.target);
          const requestedPath = request.data.path;
          const file = artifact.package.files.find(({ path }) => path === requestedPath);
          if (file === undefined) return denied("artifact_not_found");
          return recipeToolResultSchema.parse({
            action: "read_skill",
            content: file.content,
            ok: true,
            path: file.path,
            skill: artifact.projection,
          });
        }
        case "preview": {
          const resolved = await this.#preview(request.data.request);
          return resolved.ok
            ? recipeToolResultSchema.parse({ action: "preview", ok: true, plan: resolved.plan })
            : resolved.result;
        }
        case "install":
          return await this.#install(authority, request.data);
        case "recover":
          return await this.#recover(authority, request.data.installationId, "recover");
      }
      return denied("invalid_request");
    } catch (error) {
      return registryFailure(error);
    }
  }

  async #preview(
    input: RecipePreviewRequest,
  ): Promise<
    | { ok: true; packages: RegistrySkillPackage[]; plan: RecipeInstallationPlan }
    | { ok: false; result: RecipeToolResult }
  > {
    const request = recipePreviewRequestSchema.parse(input);
    if (request.target.registry !== this.#registry.origin) {
      return { ok: false, result: denied("invalid_request") };
    }
    const artifact = await this.#registry.recipe(request.target);
    const recipe = artifact.package;
    const optionalSelections = new Set(
      request.optionalSkills.map(({ name, namespace }) => `${namespace}/${name}`),
    );
    if (
      optionalSelections.size !== request.optionalSkills.length ||
      [...optionalSelections].some(
        (identity) =>
          !recipe.skills.some(
            ({ name, namespace, requirement }) =>
              requirement === "optional" && `${namespace}/${name}` === identity,
          ),
      )
    ) {
      return { ok: false, result: denied("invalid_request") };
    }

    const values: Record<string, string | number | boolean> = {};
    if (
      Object.keys(request.parameters).some(
        (name) => !recipe.setupParameters.some((p) => p.name === name),
      )
    ) {
      return { ok: false, result: denied("invalid_request") };
    }
    for (const parameter of recipe.setupParameters) {
      const value = request.parameters[parameter.name] ?? parameter.default;
      if (!validParameterValue(parameter, value)) {
        return { ok: false, result: denied("invalid_request") };
      }
      values[parameter.name] = value;
    }
    const render = (value: string) =>
      value.replace(parameterToken, (_, name: string) => String(values[name]));
    const renderedName = agentNameSchema.safeParse(render(recipe.agent.suggestedName));
    const instructions = agentInstructionsSchema.safeParse(render(recipe.agent.instructions));
    if (!renderedName.success || !instructions.success) {
      return { ok: false, result: denied("invalid_request") };
    }

    if (recipe.skills.some(({ registry }) => registry !== this.#registry.origin)) {
      return { ok: false, result: denied("invalid_request") };
    }
    const resolvedSkills = await Promise.all(
      recipe.skills.map(async (dependency) => {
        const selected =
          dependency.requirement === "required" ||
          optionalSelections.has(`${dependency.namespace}/${dependency.name}`);
        const skill = await this.#registry.skill({ ...dependency, kind: "skill" });
        const localPackage = localSkillPackage(
          dependency.namespace,
          dependency.digest,
          skill.package,
        );
        return {
          package: skill.package,
          preview: {
            license: skill.projection.license,
            localPackageDigest: await localSkillPackageDigest(localPackage),
            name: dependency.name,
            requirement: dependency.requirement,
            selected,
            review: skill.projection.review,
            source: {
              digest: dependency.digest,
              namespace: dependency.namespace,
              version: dependency.version,
            },
            warnings: skill.projection.warnings,
          },
          selected,
        };
      }),
    );
    const selectedSkillPackages: RegistrySkillPackage[] = resolvedSkills
      .filter(({ selected }) => selected)
      .map(({ package: skillPackage }) => skillPackage);
    const previewSkills = resolvedSkills.map(({ preview }) => preview);
    if (selectedSkillPackages.length > 0) {
      const installCapabilities = [
        ...recipe.agent.capabilities,
        skillsCapabilityConfiguration(
          selectedSkillPackages.map((_, index) => ({
            id: `skill_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            version: 1,
          })),
        ),
      ].toSorted((left, right) => left.id.localeCompare(right.id));
      if (!agentCapabilityConfigurationsSchema.safeParse(installCapabilities).success) {
        return { ok: false, result: denied("plan_not_ready") };
      }
    }

    const bindings = new Map(
      request.connectionBindings.map((binding) => [binding.slot, binding.connectionId]),
    );
    if (bindings.size !== request.connectionBindings.length) {
      return { ok: false, result: denied("invalid_request") };
    }
    const previewConnections = recipe.connections.map((requirement) => {
      const connectionId = bindings.get(requirement.slot);
      const row =
        connectionId === undefined
          ? undefined
          : this.#database
              .select({
                authConfigId: connections.authConfigId,
                catalog: remoteMcpConnections.catalog,
                endpoint: remoteMcpConnections.endpoint,
                oauthScopes: remoteMcpConnections.oauthScopes,
                remoteAuthKind: remoteMcpConnections.authKind,
                snapshotDigest: remoteMcpConnections.snapshotDigest,
                provider: connections.provider,
                status: connections.status,
              })
              .from(connections)
              .leftJoin(
                remoteMcpConnections,
                eq(remoteMcpConnections.connectionId, connections.connectionId),
              )
              .where(eq(connections.connectionId, connectionId))
              .get();
      const providerMatches = row?.provider === requirement.kind;
      const integration =
        row?.authConfigId === null || row?.authConfigId === undefined
          ? null
          : (this.#database
              .select({ value: integrationEnablementRequests.integrationSlug })
              .from(integrationEnablementRequests)
              .where(
                and(
                  eq(integrationEnablementRequests.authConfigId, row.authConfigId),
                  eq(integrationEnablementRequests.status, "completed"),
                ),
              )
              .orderBy(desc(integrationEnablementRequests.completedAt))
              .limit(1)
              .get()?.value ?? null);
      const requirementMatches =
        row === undefined || !providerMatches
          ? false
          : requirement.kind === "composio"
            ? integration === requirement.integration
            : row.endpoint === requirement.endpoint &&
              row.remoteAuthKind === requirement.authKind &&
              row.snapshotDigest === requirement.reviewedSnapshotDigest &&
              row.catalog?.length === requirement.reviewedToolCount &&
              requirement.requiredTools.every(({ name: requiredToolName }) =>
                row.catalog?.some((tool) => tool.name === requiredToolName),
              ) &&
              JSON.stringify(row.oauthScopes) === JSON.stringify(requirement.oauthScopes);
      return {
        bound:
          row === undefined || connectionId === undefined
            ? null
            : {
                connectionId,
                endpoint: row.endpoint,
                integration,
                provider: row.provider,
                snapshotDigest: row.snapshotDigest,
                status: row.status,
                toolCount: row.catalog?.length ?? null,
              },
        kind: requirement.kind,
        requestedAuthorization:
          requirement.kind === "remote_mcp"
            ? requirement.authorization
            : requirement.tools.some(({ authorization }) => authorization === "standing")
              ? "standing"
              : "approval_required",
        requirement,
        slot: requirement.slot,
        state:
          row === undefined
            ? ("missing" as const)
            : !providerMatches
              ? ("provider_mismatch" as const)
              : !requirementMatches
                ? ("requirement_mismatch" as const)
                : row.status !== "active"
                  ? ("unavailable" as const)
                  : ("available" as const),
      };
    });
    if (
      [...bindings.keys()].some((slot) => !recipe.connections.some((item) => item.slot === slot))
    ) {
      return { ok: false, result: denied("invalid_request") };
    }

    const scheduleNames = new Set(request.operations.schedules);
    const eventNames = new Set(request.operations.eventTriggers);
    if (
      scheduleNames.size !== request.operations.schedules.length ||
      eventNames.size !== request.operations.eventTriggers.length ||
      [...scheduleNames].some(
        (value) =>
          !recipe.operations.schedules.some(({ name: scheduleName }) => scheduleName === value),
      ) ||
      [...eventNames].some(
        (value) =>
          !recipe.operations.eventTriggers.some(({ name: eventName }) => eventName === value),
      )
    ) {
      return { ok: false, result: denied("invalid_request") };
    }
    const selectedSchedules = recipe.operations.schedules
      .filter(({ name: scheduleName }) => scheduleNames.has(scheduleName))
      .map((schedule) => ({
        ...schedule,
        instruction: render(schedule.instruction),
      }));
    if (
      selectedSchedules.some(
        ({ trigger }) =>
          trigger.type === "calendar" &&
          (request.operations.timeZone === undefined ||
            !this.#validTimeZone(request.operations.timeZone)),
      )
    ) {
      return { ok: false, result: denied("invalid_request") };
    }
    const selectedEvents = recipe.operations.eventTriggers
      .filter(({ name: eventName }) => eventNames.has(eventName))
      .map((event) => ({
        ...event,
        filters: Object.fromEntries(
          Object.entries(event.filters).map(([key, value]) => [
            key,
            typeof value === "object" ? values[value.parameter] : value,
          ]),
        ),
        instruction: render(event.instruction),
      }));
    const primary =
      recipe.operations.primary.kind === "run"
        ? { ...recipe.operations.primary, prompt: render(recipe.operations.primary.prompt) }
        : {
            ...recipe.operations.primary,
            objective: render(recipe.operations.primary.objective),
            stages: recipe.operations.primary.stages.map((stage) => ({
              ...stage,
              prompt: render(stage.prompt),
            })),
          };

    const resolved = this.#agents.resolveDefinition({
      capabilities: recipe.agent.capabilities,
      executionLimits: recipe.agent.executionLimits,
      instructions: instructions.data,
      name: renderedName.data,
    });
    if (!resolved.ok) return { ok: false, result: denied("plan_not_ready") };
    const planWithoutDigest = {
      agent: resolved.agent,
      authority: {
        createsConnections: false as const,
        createsGrants: false as const,
        requested: artifact.projection.requestedAuthority,
        startsWork: false as const,
      },
      connections: previewConnections,
      operations: {
        eventTriggers: selectedEvents,
        primary,
        schedules: selectedSchedules,
        timeZone: request.operations.timeZone ?? null,
      },
      prerequisites: resolved.prerequisites,
      ready:
        resolved.prerequisites.every(({ state }) => state === "available") &&
        previewConnections.every(({ state }) => state === "available"),
      recipe: artifact.projection,
      skills: previewSkills,
      source: {
        digest: request.target.digest,
        registry: this.#registry.origin,
        review: artifact.projection.review,
        target: {
          kind: "recipe" as const,
          name: request.target.name,
          namespace: request.target.namespace,
          version: request.target.version,
        },
      },
    };
    const plan = recipeInstallationPlanSchema.parse({
      ...planWithoutDigest,
      confirmationDigest: await digest(planWithoutDigest),
    });
    return { ok: true, packages: selectedSkillPackages, plan };
  }

  async #install(
    authority: OwnerAuthority,
    input: Extract<ReturnType<typeof recipeToolInputSchema.parse>, { action: "install" }>,
  ): Promise<RecipeToolResult> {
    const requestDigest = await digest(input);
    const replay = this.#database
      .select()
      .from(recipeInstallations)
      .where(
        and(
          eq(recipeInstallations.clientId, authority.clientId),
          eq(recipeInstallations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    if (replay !== undefined) {
      if (replay.requestDigest !== requestDigest) return denied("idempotency_conflict");
      try {
        return await this.#continue(authority, replay.installationId, "install");
      } catch {
        return denied("installation_incomplete", replay.installationId);
      }
    }

    const incompleteCount =
      this.#database
        .select({ value: count() })
        .from(recipeInstallations)
        .where(eq(recipeInstallations.status, "installing"))
        .get()?.value ?? 0;
    if (incompleteCount >= MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS) {
      return denied("installation_limit_exceeded");
    }

    const resolved = await this.#preview(input.request);
    if (!resolved.ok) return resolved.result;
    if (resolved.plan.confirmationDigest !== input.expectedConfirmationDigest) {
      return denied("stale_preview");
    }
    if (!resolved.plan.ready) return denied("plan_not_ready");
    const installationId = `recipe_installation_${crypto.randomUUID()}`;
    const now = Date.now();
    const retainedConnections = resolved.plan.connections.flatMap(({ bound, slot }) =>
      bound === null ? [] : [{ connectionId: bound.connectionId, slot }],
    );
    if (retainedConnections.length !== resolved.plan.connections.length) {
      return denied("plan_not_ready");
    }
    const receipt = recipeInstallationReceiptSchema.parse({
      agent: null,
      connections: retainedConnections,
      createdAt: new Date(now).toISOString(),
      id: installationId,
      operationsRetained: {
        eventTriggers: resolved.plan.operations.eventTriggers.map(({ name }) => name),
        schedules: resolved.plan.operations.schedules.map(({ name }) => name),
      },
      planDigest: resolved.plan.confirmationDigest,
      skills: [],
      source: resolved.plan.source,
      status: "installing",
      updatedAt: new Date(now).toISOString(),
    });
    this.#database
      .insert(recipeInstallations)
      .values({
        clientId: authority.clientId,
        createdAt: now,
        idempotencyKey: input.idempotencyKey,
        installationId,
        plan: resolved.plan,
        planDigest: resolved.plan.confirmationDigest,
        receipt,
        requestDigest,
        skillPackages: resolved.packages,
        status: "installing",
        updatedAt: now,
      })
      .run();
    try {
      return await this.#continue(authority, installationId, "install");
    } catch {
      return denied("installation_incomplete", installationId);
    }
  }

  async #recover(
    authority: OwnerAuthority,
    installationId: string,
    action: "install" | "recover",
  ): Promise<RecipeToolResult> {
    const row = this.#database
      .select({ installationId: recipeInstallations.installationId })
      .from(recipeInstallations)
      .where(eq(recipeInstallations.installationId, installationId))
      .get();
    if (row === undefined) return denied("artifact_not_found");
    try {
      return await this.#continue(authority, installationId, action);
    } catch {
      return denied("installation_incomplete", installationId);
    }
  }

  async #continue(
    authority: OwnerAuthority,
    installationId: string,
    action: "install" | "recover",
  ): Promise<RecipeToolResult> {
    let row = this.#database
      .select()
      .from(recipeInstallations)
      .where(eq(recipeInstallations.installationId, installationId))
      .get();
    if (row === undefined) return denied("artifact_not_found");

    const parsedPlan = recipeInstallationPlanSchema.safeParse(row.plan);
    const parsedReceipt = recipeInstallationReceiptSchema.safeParse(row.receipt);
    const rawSkillPackages: unknown = row.skillPackages;
    const parsedSkillPackages = Array.isArray(rawSkillPackages)
      ? rawSkillPackages.map((skillPackage) => registrySkillPackageSchema.safeParse(skillPackage))
      : [];
    if (
      !parsedPlan.success ||
      !parsedReceipt.success ||
      !Array.isArray(rawSkillPackages) ||
      parsedSkillPackages.some((skillPackage) => !skillPackage.success)
    ) {
      return denied("installation_incomplete", installationId);
    }
    const plan = parsedPlan.data;
    const storedReceipt = parsedReceipt.data;
    const skillPackages = parsedSkillPackages.flatMap((skillPackage) =>
      skillPackage.success ? [skillPackage.data] : [],
    );
    const { confirmationDigest, ...confirmedIntent } = plan;
    const selectedSkills = plan.skills.filter(({ selected }) => selected);
    const retainedConnections = plan.connections.flatMap(({ bound, slot }) =>
      bound === null ? [] : [{ connectionId: bound.connectionId, slot }],
    );
    const agentInputFor = (receipt: typeof storedReceipt) => ({
      ...plan.agent,
      capabilities: [
        ...plan.agent.capabilities,
        ...(receipt.skills.length === 0
          ? []
          : [
              skillsCapabilityConfiguration(
                receipt.skills.map(({ id, version }) => ({ id, version })),
              ),
            ]),
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
      idempotencyKey: `${installationId}.agent`,
    });
    const retainedAgentCreation =
      storedReceipt.agent === null
        ? null
        : await this.#agents.findCreation(
            agentInputFor(storedReceipt),
            null,
            "disabled",
            row.clientId,
          );
    if (
      !plan.ready ||
      row.planDigest !== confirmationDigest ||
      storedReceipt.planDigest !== confirmationDigest ||
      (await digest(confirmedIntent)) !== confirmationDigest ||
      storedReceipt.id !== installationId ||
      storedReceipt.status !== row.status ||
      !sameCanonical(storedReceipt.source, plan.source) ||
      !sameCanonical(storedReceipt.connections, retainedConnections) ||
      skillPackages.length !== selectedSkills.length ||
      storedReceipt.skills.length > selectedSkills.length ||
      storedReceipt.skills.some(
        ({ sourceDigest }, index) => sourceDigest !== selectedSkills[index]?.source.digest,
      ) ||
      storedReceipt.skills.some(({ id, version }, index) => {
        const planned = selectedSkills[index];
        return (
          planned === undefined ||
          !this.#skills.matchesVersionDigest(id, version, planned.localPackageDigest)
        );
      }) ||
      (storedReceipt.agent !== null &&
        (storedReceipt.skills.length !== selectedSkills.length ||
          !sameCanonical(storedReceipt.agent, retainedAgentCreation))) ||
      (row.status === "installed" &&
        (storedReceipt.agent === null || storedReceipt.skills.length !== selectedSkills.length))
    ) {
      return denied("installation_incomplete", installationId);
    }
    row = { ...row, plan, receipt: storedReceipt, skillPackages };
    if (row.status === "installed") {
      return recipeToolResultSchema.parse({ action, ok: true, receipt: row.receipt });
    }

    for (let index = row.receipt.skills.length; index < selectedSkills.length; index += 1) {
      const planned = selectedSkills[index];
      const registryPackage = row.skillPackages[index];
      if (planned === undefined || registryPackage === undefined) {
        return denied("installation_incomplete", installationId);
      }
      const packageValue = localSkillPackage(
        planned.source.namespace,
        planned.source.digest,
        registryPackage,
      );
      if ((await localSkillPackageDigest(packageValue)) !== planned.localPackageDigest) {
        return denied("installation_incomplete", installationId);
      }
      const existing = this.#skills.findActiveVersionByDigest(planned.localPackageDigest);
      const published =
        existing ??
        (await this.#skills.publish(authority, {
          idempotencyKey: `${installationId}.skill.${index}`,
          mode: "apply",
          target: { kind: "skill-package", package: packageValue },
        }));
      let installed: { id: string; version: number };
      if ("id" in published) {
        installed = published;
      } else {
        if (!published.ok || published.skill === undefined) {
          return denied("installation_incomplete", installationId);
        }
        installed = { id: published.skill.id, version: published.version };
      }
      const updatedAt = Date.now();
      const receipt = recipeInstallationReceiptSchema.parse({
        ...row.receipt,
        skills: [
          ...row.receipt.skills,
          { id: installed.id, sourceDigest: planned.source.digest, version: installed.version },
        ],
        updatedAt: new Date(updatedAt).toISOString(),
      });
      this.#database
        .update(recipeInstallations)
        .set({ receipt, updatedAt })
        .where(eq(recipeInstallations.installationId, installationId))
        .run();
      row = { ...row, receipt, updatedAt };
    }

    if (row.receipt.agent === null) {
      const created = await this.#agents.create(
        authority,
        agentInputFor(row.receipt),
        null,
        "disabled",
        row.clientId,
      );
      if (!created.ok) return denied("installation_incomplete", installationId);
      const updatedAt = Date.now();
      const receipt = recipeInstallationReceiptSchema.parse({
        ...row.receipt,
        agent: { id: created.agent.id, revision: created.agent.revision },
        updatedAt: new Date(updatedAt).toISOString(),
      });
      this.#database
        .update(recipeInstallations)
        .set({ receipt, updatedAt })
        .where(eq(recipeInstallations.installationId, installationId))
        .run();
      row = { ...row, receipt, updatedAt };
    }

    const updatedAt = Date.now();
    const receipt = recipeInstallationReceiptSchema.parse({
      ...row.receipt,
      status: "installed",
      updatedAt: new Date(updatedAt).toISOString(),
    });
    this.#database.transaction((transaction) => {
      transaction
        .update(recipeInstallations)
        .set({ receipt, status: "installed", updatedAt })
        .where(eq(recipeInstallations.installationId, installationId))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "recipe.installed",
          clientId: authority.clientId,
          occurredAt: updatedAt,
          subjectId: installationId,
        })
        .run();
    });
    return recipeToolResultSchema.parse({ action, ok: true, receipt });
  }

  #validTimeZone(timeZone: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
      return true;
    } catch {
      return false;
    }
  }
}
