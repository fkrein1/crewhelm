import {
  AUTONOMY_WRITE_SCOPE,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_REVISIONS_PER_AGENT,
  agentRevisionSchema,
  agentRevisionSummarySchema,
  agentSchema,
  agentSummarySchema,
  createAgentInputSchema,
  createAgentResultSchema,
  getAgentInputSchema,
  getAgentRevisionInputSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsInputSchema,
  listAgentRevisionsResultSchema,
  listAgentsInputSchema,
  listAgentsResultSchema,
  updateAgentInputSchema,
  updateAgentResultSchema,
  classifyComposioToolEffect,
  composioToolCapabilityGrantSchema,
  completeAgentConnectionConfigurationInputSchema,
  configureAgentConnectionInputSchema,
  configureAgentConnectionResultSchema,
  lookupAgentConnectionConfigurationResultSchema,
  isCredentialBearingComposioTool,
  resolveConnectionForAttachmentInputSchema,
  resolvedConnectionForAttachmentSchema,
  type Agent,
  type AgentRevision,
  type AgentRevisionSummary,
  type AgentSummary,
  type CreateAgentInput,
  type CreateAgentResult,
  type GetAgentRevisionResult,
  type GetAgentResult,
  type ListAgentRevisionsResult,
  type ListAgentsResult,
  type OwnerAuthority,
  type UpdateAgentInput,
  type UpdateAgentResult,
  type ConfigureAgentConnectionResult,
  type ConfigureAgentConnectionInput,
  type ComposioToolCapabilityGrant,
  type FleetConfigurationData,
  type LookupAgentConnectionConfigurationResult,
  type ResolvedConnectionForAttachment,
} from "@crewhelm/contracts";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentCreations,
  agentRevisions,
  agentUpdates,
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type AgentRequestFailure = Extract<CreateAgentResult, { ok: false }>;
type StoredAgentRow = {
  agentId: string;
  capabilityGrants: Agent["capabilityGrants"];
  createdAt: number;
  currentRevision: number;
  executionLimits: Agent["executionLimits"];
  instructions: string;
  model: string;
  name: string;
  status: Agent["status"];
};
type StoredAgentRevisionRow = StoredAgentRow & { revisedAt: number };
type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ConnectionAttachmentFailure = Extract<ConfigureAgentConnectionResult, { ok: false }>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestCanonicalRequest(canonicalRequest: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));

  return encodeBase64Url(new Uint8Array(digest));
}

async function digestAgentCreation(input: CreateAgentInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      executionLimits: input.executionLimits,
      instructions: input.instructions,
      model: input.model,
      name: input.name,
    }),
  );
}

async function digestAgentUpdate(input: UpdateAgentInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      id: input.id,
      expectedRevision: input.expectedRevision,
      executionLimits: {
        maxDurationSeconds: input.executionLimits.maxDurationSeconds,
        maxModelTokens: input.executionLimits.maxModelTokens,
        maxToolCalls: input.executionLimits.maxToolCalls,
        maxTurns: input.executionLimits.maxTurns,
      },
      instructions: input.instructions,
      model: input.model,
      name: input.name,
    }),
  );
}

async function digestConnectionConfiguration(
  input: ConfigureAgentConnectionInput,
): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      agentId: input.agentId,
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision,
      expiresAt: input.expiresAt,
      limits: input.limits,
      tools: input.tools.map((tool) => ({
        authorization: tool.authorization,
        slug: tool.slug,
        version: tool.version,
      })),
    }),
  );
}

export function deniedAgent(code: AgentRequestFailure["error"]["code"]): AgentRequestFailure {
  return {
    error: {
      code,
      message: "Agent request denied.",
    },
    ok: false,
  };
}

export function deniedConnectionAttachment(
  code: ConnectionAttachmentFailure["error"]["code"],
): ConnectionAttachmentFailure {
  return {
    error: {
      code,
      message: "Connection attachment request denied.",
    },
    ok: false,
  };
}

export class AgentRegistry {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: ControlPlaneDatabase;

  constructor(
    database: ControlPlaneDatabase,
    currentFleetConfiguration: () => FleetConfigurationData,
  ) {
    this.#database = database;
    this.#currentFleetConfiguration = currentFleetConfiguration;
  }

  resolveConnectionForAttachment(input: unknown): ResolvedConnectionForAttachment {
    const request = resolveConnectionForAttachmentInputSchema.safeParse(input);

    if (!request.success) {
      return resolvedConnectionForAttachmentSchema.parse(
        deniedConnectionAttachment("invalid_request"),
      );
    }

    const row = this.#database
      .select({
        currentRevision: agents.currentRevision,
        providerConnectionId: connections.providerConnectionId,
        status: connections.status,
      })
      .from(agents)
      .innerJoin(connections, eq(connections.connectionId, request.data.connectionId))
      .where(eq(agents.agentId, request.data.agentId))
      .all()[0];

    if (row === undefined) {
      return resolvedConnectionForAttachmentSchema.parse(
        this.#agentExists(request.data.agentId)
          ? deniedConnectionAttachment("connection_not_found")
          : deniedConnectionAttachment("agent_not_found"),
      );
    }

    if (row.currentRevision !== request.data.expectedRevision) {
      return resolvedConnectionForAttachmentSchema.parse(
        deniedConnectionAttachment("revision_conflict"),
      );
    }

    if (row.status === "revoked" || row.status === "unavailable") {
      return resolvedConnectionForAttachmentSchema.parse(
        deniedConnectionAttachment("connection_not_found"),
      );
    }

    return resolvedConnectionForAttachmentSchema.parse({
      ok: true,
      providerConnectionId: row.providerConnectionId,
    });
  }

  async lookupConnectionConfiguration(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<LookupAgentConnectionConfigurationResult> {
    const request = configureAgentConnectionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionAttachment("invalid_request");
    }

    const requestDigest = await digestConnectionConfiguration(request.data);
    const existingUpdate = this.#database
      .select({
        agentId: agents.agentId,
        capabilityGrants: agentRevisions.capabilityGrants,
        createdAt: agents.createdAt,
        currentRevision: agentUpdates.revision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
        name: agentRevisions.name,
        requestDigest: agentUpdates.requestDigest,
        status: agents.status,
      })
      .from(agentUpdates)
      .innerJoin(agents, eq(agents.agentId, agentUpdates.agentId))
      .innerJoin(
        agentRevisions,
        and(
          eq(agentRevisions.agentId, agentUpdates.agentId),
          eq(agentRevisions.revision, agentUpdates.revision),
        ),
      )
      .where(
        and(
          eq(agentUpdates.clientId, authority.clientId),
          eq(agentUpdates.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .all()[0];

    if (existingUpdate === undefined) {
      return lookupAgentConnectionConfigurationResultSchema.parse({
        ok: true,
        replay: null,
      });
    }

    if (
      existingUpdate.agentId !== request.data.agentId ||
      existingUpdate.requestDigest !== requestDigest
    ) {
      return deniedConnectionAttachment("idempotency_conflict");
    }

    return lookupAgentConnectionConfigurationResultSchema.parse({
      ok: true,
      replay: {
        agent: this.#agentFromRow(existingUpdate),
        configured: false,
        ok: true,
      },
    });
  }

  async configureConnection(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ConfigureAgentConnectionResult> {
    const request = completeAgentConnectionConfigurationInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionAttachment("invalid_request");
    }

    const requestDigest = await digestConnectionConfiguration({
      ...request.data,
      tools: request.data.tools.map((tool) => ({
        authorization: tool.authorization,
        slug: tool.slug,
        version: tool.version,
      })),
    });
    const targetDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.data.connectionId)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    return this.#database.transaction((transaction) => {
      const existingUpdate = transaction
        .select({
          agentId: agents.agentId,
          capabilityGrants: agentRevisions.capabilityGrants,
          createdAt: agents.createdAt,
          currentRevision: agentUpdates.revision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
          name: agentRevisions.name,
          requestDigest: agentUpdates.requestDigest,
          status: agents.status,
        })
        .from(agentUpdates)
        .innerJoin(agents, eq(agents.agentId, agentUpdates.agentId))
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agentUpdates.agentId),
            eq(agentRevisions.revision, agentUpdates.revision),
          ),
        )
        .where(
          and(
            eq(agentUpdates.clientId, authority.clientId),
            eq(agentUpdates.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingUpdate !== undefined) {
        if (existingUpdate.requestDigest !== requestDigest) {
          return deniedConnectionAttachment("idempotency_conflict");
        }

        return configureAgentConnectionResultSchema.parse({
          agent: this.#agentFromRow(existingUpdate),
          configured: false,
          ok: true,
        });
      }

      const currentRow = transaction
        .select({
          agentId: agents.agentId,
          capabilityGrants: agentRevisions.capabilityGrants,
          createdAt: agents.createdAt,
          currentRevision: agents.currentRevision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
          name: agentRevisions.name,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agents.agentId),
            eq(agentRevisions.revision, agents.currentRevision),
          ),
        )
        .where(eq(agents.agentId, request.data.agentId))
        .all()[0];

      if (currentRow === undefined) {
        return deniedConnectionAttachment("agent_not_found");
      }

      if (currentRow.currentRevision !== request.data.expectedRevision) {
        return deniedConnectionAttachment("revision_conflict");
      }

      if (currentRow.currentRevision >= MAXIMUM_REVISIONS_PER_AGENT) {
        return deniedConnectionAttachment("agent_revision_limit_exceeded");
      }

      const connection = transaction
        .select({
          providerConnectionId: connections.providerConnectionId,
          status: connections.status,
        })
        .from(connections)
        .where(eq(connections.connectionId, request.data.connectionId))
        .all()[0];

      if (connection === undefined) {
        return deniedConnectionAttachment("connection_not_found");
      }

      const detaching = request.data.tools.length === 0;

      if (
        (!detaching &&
          (connection.status === "revoked" ||
            connection.status === "unavailable" ||
            request.data.providerConnectionId !== connection.providerConnectionId ||
            request.data.verifiedToolkitSlug === null)) ||
        (detaching &&
          (request.data.providerConnectionId !== null || request.data.verifiedToolkitSlug !== null))
      ) {
        return deniedConnectionAttachment("connection_unavailable");
      }

      const configuredTools = request.data.tools;
      const selected = configuredTools.map((tool) => `${tool.slug}:${tool.version}`);
      const canonical = selected.toSorted();

      if (
        selected.some((value, index) => value !== canonical[index]) ||
        configuredTools.some(
          (tool) =>
            tool.integration.slug !== request.data.verifiedToolkitSlug ||
            isCredentialBearingComposioTool(tool),
        )
      ) {
        return deniedConnectionAttachment("invalid_request");
      }

      const previousGrants = transaction
        .select({ grant: capabilityGrants.grant })
        .from(capabilityGrants)
        .where(
          and(
            eq(capabilityGrants.agentId, currentRow.agentId),
            eq(capabilityGrants.agentRevision, currentRow.currentRevision),
            eq(capabilityGrants.status, "active"),
          ),
        )
        .all()
        .map((row) => row.grant)
        .filter((grant) => grant.connectionId !== request.data.connectionId);
      const revision = currentRow.currentRevision + 1;
      const createdAt = Date.now();
      const candidateGrants: ComposioToolCapabilityGrant[] = [
        ...previousGrants.map((grant) => ({
          ...grant,
          agentRevision: revision,
          grantId: `grant_${crypto.randomUUID()}`,
        })),
        ...configuredTools.map((tool) => ({
          agentId: currentRow.agentId,
          agentRevision: revision,
          authorization: tool.authorization,
          capabilityId: "composio.tool.execute" as const,
          connectionId: request.data.connectionId,
          effect: classifyComposioToolEffect(tool.tags, tool.slug),
          expiresAt: request.data.expiresAt,
          grantId: `grant_${crypto.randomUUID()}`,
          integrationSlug: tool.integration.slug,
          limits: request.data.limits,
          ownerKey: authority.ownerKey,
          targetDigests: [targetDigest],
          tool: {
            description: tool.description,
            inputParametersJson: JSON.stringify(tool.inputParameters),
            name: tool.name,
            outputParametersJson: JSON.stringify(tool.outputParameters),
            tags: tool.tags,
          },
          toolkitVersion: tool.version,
          toolSlug: tool.slug,
        })),
      ];
      const parsedGrants = candidateGrants.map((grant) =>
        composioToolCapabilityGrantSchema.safeParse(grant),
      );

      if (parsedGrants.length > 100 || parsedGrants.some((parsedGrant) => !parsedGrant.success)) {
        return deniedConnectionAttachment("invalid_request");
      }

      const grants = parsedGrants.flatMap((parsedGrant) =>
        parsedGrant.success ? [parsedGrant.data] : [],
      );
      const grantIds = grants.map((grant) => grant.grantId).toSorted();

      transaction
        .insert(agentRevisions)
        .values({
          agentId: currentRow.agentId,
          capabilityGrants: grantIds,
          createdAt,
          executionLimits: currentRow.executionLimits,
          instructions: currentRow.instructions,
          model: currentRow.model,
          name: currentRow.name,
          revision,
        })
        .run();

      for (const grant of grants) {
        transaction
          .insert(capabilityGrants)
          .values({
            agentId: grant.agentId,
            agentRevision: grant.agentRevision,
            connectionId: grant.connectionId,
            createdAt,
            grant,
            grantId: grant.grantId,
            status: "active",
          })
          .run();
      }

      transaction
        .update(agents)
        .set({ currentRevision: revision })
        .where(eq(agents.agentId, currentRow.agentId))
        .run();
      transaction
        .insert(agentUpdates)
        .values({
          agentId: currentRow.agentId,
          clientId: authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision,
        })
        .run();

      if (!detaching) {
        transaction
          .update(connections)
          .set({ status: "active" })
          .where(eq(connections.connectionId, request.data.connectionId))
          .run();
      }

      transaction
        .insert(auditEvents)
        .values({
          action: detaching ? "agent.connection_detached" : "agent.connection_configured",
          clientId: authority.clientId,
          occurredAt: createdAt,
          subjectId: currentRow.agentId,
        })
        .run();

      return configureAgentConnectionResultSchema.parse({
        agent: {
          capabilityGrants: grantIds,
          createdAt: new Date(currentRow.createdAt).toISOString(),
          executionLimits: currentRow.executionLimits,
          id: currentRow.agentId,
          instructions: currentRow.instructions,
          model: currentRow.model,
          name: currentRow.name,
          revision,
          status: currentRow.status,
        },
        configured: true,
        ok: true,
      });
    });
  }

  async create(authority: OwnerAuthority, input: unknown): Promise<CreateAgentResult> {
    const request = createAgentInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const requestDigest = await digestAgentCreation(request.data);
    const fleetConfiguration = this.#currentFleetConfiguration();
    const executionLimits = request.data.executionLimits ?? fleetConfiguration.execution;
    const model = request.data.model ?? fleetConfiguration.models.default;

    return this.#database.transaction((transaction) => {
      const existingRow = transaction
        .select({
          agentId: agents.agentId,
          capabilityGrants: agentRevisions.capabilityGrants,
          createdAt: agents.createdAt,
          currentRevision: agentCreations.revision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
          name: agentRevisions.name,
          requestDigest: agentCreations.requestDigest,
          status: agents.status,
        })
        .from(agentCreations)
        .innerJoin(agents, eq(agents.agentId, agentCreations.agentId))
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agentCreations.agentId),
            eq(agentRevisions.revision, agentCreations.revision),
          ),
        )
        .where(
          and(
            eq(agentCreations.clientId, authority.clientId),
            eq(agentCreations.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingRow !== undefined) {
        if (existingRow.requestDigest !== requestDigest) {
          return deniedAgent("idempotency_conflict");
        }

        return createAgentResultSchema.parse({
          agent: this.#agentFromRow(existingRow),
          created: false,
          ok: true,
        });
      }

      if (!fleetConfiguration.models.allowed.some((candidate) => candidate === model)) {
        return deniedAgent("invalid_request");
      }

      const agentCount = transaction.select({ value: count() }).from(agents).get()?.value ?? 0;

      if (agentCount >= MAXIMUM_AGENTS_PER_OWNER) {
        return deniedAgent("agent_limit_exceeded");
      }

      const agentId = `agent_${crypto.randomUUID()}`;
      const createdAt = Date.now();

      transaction.insert(agents).values({ agentId, createdAt, currentRevision: 1 }).run();
      transaction
        .insert(agentRevisions)
        .values({
          agentId,
          capabilityGrants: [],
          createdAt,
          executionLimits,
          instructions: request.data.instructions,
          model,
          name: request.data.name,
          revision: 1,
        })
        .run();
      transaction
        .insert(agentCreations)
        .values({
          agentId,
          clientId: authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision: 1,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent.created",
          clientId: authority.clientId,
          occurredAt: createdAt,
          subjectId: agentId,
        })
        .run();

      const agent = agentSchema.parse({
        capabilityGrants: [],
        createdAt: new Date(createdAt).toISOString(),
        executionLimits,
        id: agentId,
        instructions: request.data.instructions,
        model,
        name: request.data.name,
        revision: 1,
        status: "active",
      });

      return createAgentResultSchema.parse({ agent, created: true, ok: true });
    });
  }

  get(input: unknown): GetAgentResult {
    const request = getAgentInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const row = this.#currentAgentRow(request.data.id);

    if (row === undefined) {
      return deniedAgent("agent_not_found");
    }

    return getAgentResultSchema.parse({
      agent: this.#agentFromRow(row),
      ok: true,
    });
  }

  getRevision(input: unknown): GetAgentRevisionResult {
    const request = getAgentRevisionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const row = this.#agentRevisionRow(request.data.id, request.data.revision);

    if (row === undefined) {
      return deniedAgent("agent_not_found");
    }

    return getAgentRevisionResultSchema.parse({
      agent: this.#agentRevisionFromRow(row),
      ok: true,
    });
  }

  listRevisions(input: unknown): ListAgentRevisionsResult {
    const request = listAgentRevisionsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const rows = this.#database
      .select({
        agentId: agents.agentId,
        capabilityGrants: agentRevisions.capabilityGrants,
        createdAt: agents.createdAt,
        currentRevision: agentRevisions.revision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
        name: agentRevisions.name,
        revisedAt: agentRevisions.createdAt,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(agentRevisions, eq(agentRevisions.agentId, agents.agentId))
      .where(
        and(
          eq(agents.agentId, request.data.id),
          request.data.cursor === undefined
            ? undefined
            : lt(agentRevisions.revision, request.data.cursor),
        ),
      )
      .orderBy(desc(agentRevisions.revision))
      .limit(request.data.limit + 1)
      .all();

    if (rows.length === 0 && !this.#agentExists(request.data.id)) {
      return deniedAgent("agent_not_found");
    }

    const hasMore = rows.length > request.data.limit;
    const revisions = rows
      .slice(0, request.data.limit)
      .map((row) => this.#agentRevisionSummaryFromRow(row));
    const nextCursor = hasMore ? (revisions.at(-1)?.revision ?? null) : null;

    return listAgentRevisionsResultSchema.parse({ nextCursor, ok: true, revisions });
  }

  async update(authority: OwnerAuthority, input: unknown): Promise<UpdateAgentResult> {
    const request = updateAgentInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const requestDigest = await digestAgentUpdate(request.data);

    return this.#database.transaction((transaction) => {
      const existingUpdate = transaction
        .select({
          agentId: agents.agentId,
          capabilityGrants: agentRevisions.capabilityGrants,
          createdAt: agents.createdAt,
          currentRevision: agentUpdates.revision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
          name: agentRevisions.name,
          requestDigest: agentUpdates.requestDigest,
          status: agents.status,
        })
        .from(agentUpdates)
        .innerJoin(agents, eq(agents.agentId, agentUpdates.agentId))
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agentUpdates.agentId),
            eq(agentRevisions.revision, agentUpdates.revision),
          ),
        )
        .where(
          and(
            eq(agentUpdates.clientId, authority.clientId),
            eq(agentUpdates.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingUpdate !== undefined) {
        if (existingUpdate.requestDigest !== requestDigest) {
          return deniedAgent("idempotency_conflict");
        }

        return updateAgentResultSchema.parse({
          agent: this.#agentFromRow(existingUpdate),
          ok: true,
          updated: false,
        });
      }

      const currentRow = transaction
        .select({
          agentId: agents.agentId,
          capabilityGrants: agentRevisions.capabilityGrants,
          createdAt: agents.createdAt,
          currentRevision: agents.currentRevision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
          name: agentRevisions.name,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agents.agentId),
            eq(agentRevisions.revision, agents.currentRevision),
          ),
        )
        .where(eq(agents.agentId, request.data.id))
        .all()[0];

      if (currentRow === undefined) {
        return deniedAgent("agent_not_found");
      }

      const currentAgent = this.#agentFromRow(currentRow);

      if (currentAgent.revision !== request.data.expectedRevision) {
        return deniedAgent("revision_conflict");
      }

      if (
        currentAgent.name === request.data.name &&
        currentAgent.model === request.data.model &&
        currentAgent.instructions === request.data.instructions &&
        currentAgent.executionLimits.maxDurationSeconds ===
          request.data.executionLimits.maxDurationSeconds &&
        currentAgent.executionLimits.maxModelTokens ===
          request.data.executionLimits.maxModelTokens &&
        currentAgent.executionLimits.maxToolCalls === request.data.executionLimits.maxToolCalls &&
        currentAgent.executionLimits.maxTurns === request.data.executionLimits.maxTurns
      ) {
        return deniedAgent("no_changes");
      }

      if (currentAgent.revision >= MAXIMUM_REVISIONS_PER_AGENT) {
        return deniedAgent("agent_revision_limit_exceeded");
      }

      const updatedAt = Date.now();
      const revision = currentAgent.revision + 1;
      const parsedGrants = transaction
        .select({ grant: capabilityGrants.grant })
        .from(capabilityGrants)
        .where(
          and(
            eq(capabilityGrants.agentId, currentAgent.id),
            eq(capabilityGrants.agentRevision, currentAgent.revision),
            eq(capabilityGrants.status, "active"),
          ),
        )
        .all()
        .map(({ grant }) => composioToolCapabilityGrantSchema.safeParse(grant));

      if (parsedGrants.some((grant) => !grant.success)) {
        return deniedAgent("incompatible_schema");
      }

      const currentGrants = parsedGrants.flatMap((grant) => (grant.success ? [grant.data] : []));

      if (
        currentGrants.some(({ authorization }) => authorization === "standing") &&
        !authority.scopes.includes(AUTONOMY_WRITE_SCOPE)
      ) {
        return deniedAgent("insufficient_scope");
      }

      const grants = currentGrants.map((grant) => ({
        ...grant,
        agentRevision: revision,
        grantId: `grant_${crypto.randomUUID()}`,
      }));
      const grantIds = grants.map((grant) => grant.grantId).toSorted();

      transaction
        .insert(agentRevisions)
        .values({
          agentId: currentAgent.id,
          capabilityGrants: grantIds,
          createdAt: updatedAt,
          executionLimits: request.data.executionLimits,
          instructions: request.data.instructions,
          model: request.data.model,
          name: request.data.name,
          revision,
        })
        .run();

      for (const grant of grants) {
        transaction
          .insert(capabilityGrants)
          .values({
            agentId: grant.agentId,
            agentRevision: grant.agentRevision,
            connectionId: grant.connectionId,
            createdAt: updatedAt,
            grant,
            grantId: grant.grantId,
            status: "active",
          })
          .run();
      }
      transaction
        .update(agents)
        .set({ currentRevision: revision })
        .where(eq(agents.agentId, currentAgent.id))
        .run();
      transaction
        .insert(agentUpdates)
        .values({
          agentId: currentAgent.id,
          clientId: authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent.updated",
          clientId: authority.clientId,
          occurredAt: updatedAt,
          subjectId: currentAgent.id,
        })
        .run();

      return updateAgentResultSchema.parse({
        agent: {
          capabilityGrants: grantIds,
          createdAt: currentAgent.createdAt,
          executionLimits: request.data.executionLimits,
          id: currentAgent.id,
          instructions: request.data.instructions,
          model: request.data.model,
          name: request.data.name,
          revision,
          status: currentAgent.status,
        },
        ok: true,
        updated: true,
      });
    });
  }

  list(input: unknown): ListAgentsResult {
    const request = listAgentsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const rows = this.#database
      .select({
        agentId: agents.agentId,
        capabilityGrants: agentRevisions.capabilityGrants,
        createdAt: agents.createdAt,
        currentRevision: agents.currentRevision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
        name: agentRevisions.name,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(
        agentRevisions,
        and(
          eq(agentRevisions.agentId, agents.agentId),
          eq(agentRevisions.revision, agents.currentRevision),
        ),
      )
      .where(
        request.data.cursor === undefined ? undefined : gt(agents.agentId, request.data.cursor),
      )
      .orderBy(asc(agents.agentId))
      .limit(request.data.limit + 1)
      .all();
    const hasMore = rows.length > request.data.limit;
    const agentSummaries = rows
      .slice(0, request.data.limit)
      .map((row) => this.#agentSummaryFromRow(row));
    const nextCursor = hasMore ? (agentSummaries.at(-1)?.id ?? null) : null;

    return listAgentsResultSchema.parse({ agents: agentSummaries, nextCursor, ok: true });
  }

  #agentFromRow(row: StoredAgentRow): Agent {
    return agentSchema.parse({
      capabilityGrants: row.capabilityGrants,
      createdAt: new Date(row.createdAt).toISOString(),
      executionLimits: row.executionLimits,
      id: row.agentId,
      instructions: row.instructions,
      model: row.model,
      name: row.name,
      revision: row.currentRevision,
      status: row.status,
    });
  }

  #agentRevisionFromRow(row: StoredAgentRevisionRow): AgentRevision {
    return agentRevisionSchema.parse({
      ...this.#agentFromRow(row),
      revisedAt: new Date(row.revisedAt).toISOString(),
    });
  }

  #agentRevisionRow(agentId: string, revision: number): StoredAgentRevisionRow | undefined {
    return this.#database
      .select({
        agentId: agents.agentId,
        capabilityGrants: agentRevisions.capabilityGrants,
        createdAt: agents.createdAt,
        currentRevision: agentRevisions.revision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
        name: agentRevisions.name,
        revisedAt: agentRevisions.createdAt,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(agentRevisions, eq(agentRevisions.agentId, agents.agentId))
      .where(and(eq(agents.agentId, agentId), eq(agentRevisions.revision, revision)))
      .all()[0];
  }

  #agentExists(agentId: string): boolean {
    return (
      this.#database
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.agentId, agentId))
        .all()[0] !== undefined
    );
  }

  #currentAgentRow(agentId: string): StoredAgentRow | undefined {
    return this.#database
      .select({
        agentId: agents.agentId,
        capabilityGrants: agentRevisions.capabilityGrants,
        createdAt: agents.createdAt,
        currentRevision: agents.currentRevision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
        name: agentRevisions.name,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(
        agentRevisions,
        and(
          eq(agentRevisions.agentId, agents.agentId),
          eq(agentRevisions.revision, agents.currentRevision),
        ),
      )
      .where(eq(agents.agentId, agentId))
      .all()[0];
  }

  #agentSummaryFromRow(row: StoredAgentRow): AgentSummary {
    const agent = this.#agentFromRow(row);

    return agentSummarySchema.parse({
      capabilityGrants: agent.capabilityGrants,
      createdAt: agent.createdAt,
      executionLimits: agent.executionLimits,
      id: agent.id,
      model: agent.model,
      name: agent.name,
      revision: agent.revision,
      status: agent.status,
    });
  }

  #agentRevisionSummaryFromRow(row: StoredAgentRevisionRow): AgentRevisionSummary {
    return agentRevisionSummarySchema.parse({
      capabilityGrants: row.capabilityGrants,
      createdAt: new Date(row.createdAt).toISOString(),
      executionLimits: row.executionLimits,
      id: row.agentId,
      model: row.model,
      name: row.name,
      revisedAt: new Date(row.revisedAt).toISOString(),
      revision: row.currentRevision,
      status: row.status,
    });
  }
}
