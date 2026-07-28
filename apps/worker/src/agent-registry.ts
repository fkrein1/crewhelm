import {
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
} from "@crewhelm/contracts";
import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentCreations,
  agentRevisions,
  agentUpdates,
  agents,
  auditEvents,
  type ControlPlaneDatabaseSchema,
} from "./control-plane-schema.js";

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
};
type StoredAgentRevisionRow = StoredAgentRow & { revisedAt: number };
type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;

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

export function deniedAgent(code: AgentRequestFailure["error"]["code"]): AgentRequestFailure {
  return {
    error: {
      code,
      message: "Agent request denied.",
    },
    ok: false,
  };
}

export class AgentRegistry {
  readonly #database: ControlPlaneDatabase;

  constructor(database: ControlPlaneDatabase) {
    this.#database = database;
  }

  async create(authority: OwnerAuthority, input: unknown): Promise<CreateAgentResult> {
    const request = createAgentInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgent("invalid_request");
    }

    const requestDigest = await digestAgentCreation(request.data);

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
          executionLimits: request.data.executionLimits,
          instructions: request.data.instructions,
          model: request.data.model,
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
        executionLimits: request.data.executionLimits,
        id: agentId,
        instructions: request.data.instructions,
        model: request.data.model,
        name: request.data.name,
        revision: 1,
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

      transaction
        .insert(agentRevisions)
        .values({
          agentId: currentAgent.id,
          capabilityGrants: currentAgent.capabilityGrants,
          createdAt: updatedAt,
          executionLimits: request.data.executionLimits,
          instructions: request.data.instructions,
          model: request.data.model,
          name: request.data.name,
          revision,
        })
        .run();
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
          capabilityGrants: currentAgent.capabilityGrants,
          createdAt: currentAgent.createdAt,
          executionLimits: request.data.executionLimits,
          id: currentAgent.id,
          instructions: request.data.instructions,
          model: request.data.model,
          name: request.data.name,
          revision,
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
    });
  }
}
