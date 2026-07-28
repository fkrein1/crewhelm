import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  acceptRunAdmissionResultSchema,
  agentRevisionSchema,
  agentRevisionSummarySchema,
  agentSchema,
  agentSummarySchema,
  controlPlaneStatusResultSchema,
  completeConnectionLinkInputSchema,
  connectionAuthorizationTokenSchema,
  connectionSummarySchema,
  createAgentInputSchema,
  createAgentResultSchema,
  createConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  crewAgentObjectName,
  getAgentInputSchema,
  getAgentRevisionInputSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsInputSchema,
  listAgentRevisionsResultSchema,
  listAgentsInputSchema,
  listAgentsResultSchema,
  listConnectionsInputSchema,
  listConnectionsResultSchema,
  inspectAdmittedRunResultSchema,
  inspectRunInputSchema,
  inspectRunResultSchema,
  MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER,
  MAXIMUM_CONNECTIONS_PER_OWNER,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_REVISIONS_PER_AGENT,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  ownerAuthoritySchema,
  recordConnectionAuthorizationReturnInputSchema,
  recordConnectionAuthorizationReturnResultSchema,
  RUN_RECEIVER_CAPABILITY_LIFETIME_MS,
  runAdmissionNonceSchema,
  runReceiverCapabilitySchema,
  reserveConnectionLinkResultSchema,
  startRunInputSchema,
  startRunResultSchema,
  updateAgentInputSchema,
  updateAgentResultSchema,
  type Agent,
  type AgentRevision,
  type AgentRevisionSummary,
  type AgentSummary,
  type ControlPlaneStatusResult,
  type CreateAgentInput,
  type CreateAgentResult,
  type CreateConnectionLinkInput,
  type CreateConnectionLinkResult,
  type ConnectionSummary,
  type ConfirmRunAdmissionResult,
  type CreateRunAdmissionResult,
  type GetAgentRevisionResult,
  type GetAgentResult,
  type ListAgentRevisionsResult,
  type ListAgentsResult,
  type ListConnectionsResult,
  type InspectRunResult,
  type OwnerAuthority,
  type OwnerScope,
  type RecordConnectionAuthorizationReturnResult,
  type RedeemRunReceiverCapabilityResult,
  type ReserveConnectionLinkResult,
  type RunReceiverCapability,
  type StartRunResult,
  type UpdateAgentInput,
  type UpdateAgentResult,
  type VerifyActiveRunAdmissionResult,
  type VerifyRunAdmissionResult,
} from "@crewhelm/contracts";
import { DurableObject } from "cloudflare:workers";
import { and, asc, count, desc, eq, gt, inArray, lt, lte, min } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { CONTROL_PLANE_SCHEMA_VERSION, migrateControlPlane } from "./control-plane-migrations.js";
import {
  agentCreations,
  agentRevisions,
  agentUpdates,
  agents,
  auditEvents,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  controlPlane,
  controlPlaneSchema,
  type ControlPlaneDatabaseSchema,
  type StoredConnectionAuthorizationOutcome,
} from "./control-plane-schema.js";

import { digestRunPrompt, RunAdmissions } from "./run-admission.js";
import type { CrewAgent } from "./crew-agent.js";

const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";
const MAXIMUM_PENDING_RUN_RECEIVER_CAPABILITIES = 128;
const INVALID_RUN_ADMISSION = {
  error: {
    code: "invalid_admission",
    message: "Run admission denied.",
  },
  ok: false,
} as const;
type AuthorityErrorCode =
  | "incompatible_schema"
  | "insufficient_scope"
  | "invalid_authority"
  | "owner_mismatch";
type AgentRequestErrorCode =
  | AuthorityErrorCode
  | "agent_limit_exceeded"
  | "agent_not_found"
  | "agent_revision_limit_exceeded"
  | "idempotency_conflict"
  | "invalid_request"
  | "no_changes"
  | "revision_conflict";
type AgentRequestFailure = Extract<CreateAgentResult, { ok: false }>;
type ConnectionLinkRequestErrorCode =
  | AuthorityErrorCode
  | "connection_limit_exceeded"
  | "connection_link_expired"
  | "connection_link_in_progress"
  | "connection_link_outcome_unknown"
  | "connection_link_request_limit_exceeded"
  | "connection_link_unavailable"
  | "idempotency_conflict"
  | "invalid_request";
type ConnectionLinkRequestFailure = Extract<CreateConnectionLinkResult, { ok: false }>;
type ConnectionReadRequestErrorCode = AuthorityErrorCode | "invalid_request";
type ConnectionReadRequestFailure = Extract<ListConnectionsResult, { ok: false }>;
type ConnectionAuthorizationReturnFailure = Extract<
  RecordConnectionAuthorizationReturnResult,
  { ok: false }
>;
type RunAdmissionRequestFailure = Extract<CreateRunAdmissionResult, { ok: false }>;
type StartRunRequestFailure = Extract<StartRunResult, { ok: false }>;
type InspectRunRequestFailure = Extract<InspectRunResult, { ok: false }>;
type AuthorityResult =
  | { authority: OwnerAuthority; ok: true }
  | { code: AuthorityErrorCode; ok: false };
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
type StoredConnectionLinkRow = {
  connectionId: string | null;
  expiresAt: number | null;
  redirectUrl: string | null;
};
type StoredConnectionSummaryRow = {
  authConfigId: string;
  authorizationOutcome: ConnectionSummary["authorizationOutcome"];
  connectionId: string;
  createdAt: number;
  status: "initiated";
};
type ControlPlaneWriter = Pick<DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>, "update">;

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

function createConnectionAuthorizationToken(): string {
  return connectionAuthorizationTokenSchema.parse(
    encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  );
}

function createRunReceiverNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
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

async function digestConnectionLink(input: CreateConnectionLinkInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      authConfigId: input.authConfigId,
    }),
  );
}

function isCanonicalComposioConnectUrl(value: string): boolean {
  const url = new URL(value);

  return (
    url.origin === COMPOSIO_CONNECT_ORIGIN &&
    /^\/link\/ln_[A-Za-z0-9_-]+$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === ""
  );
}

export class OwnerControlPlane extends DurableObject {
  readonly #database: DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
  readonly #crewAgents: DurableObjectNamespace<CrewAgent>;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;
  #migrationReady = false;
  readonly #pendingRunReceiverCapabilities = new Map<
    string,
    { canonical: string; expiresAt: number }
  >();
  readonly #runAdmissions: RunAdmissions;

  constructor(state: DurableObjectState, environment: Cloudflare.Env) {
    super(state, environment);
    this.#crewAgents = environment.CREW_AGENT;
    this.#objectName = state.id.name;
    this.#storage = state.storage;
    this.#database = drizzle(this.#storage, {
      logger: false,
      schema: controlPlaneSchema,
    });
    this.#runAdmissions = new RunAdmissions(this.#objectName, this.#database, this.#storage);
    this.#storage.sql.exec("PRAGMA foreign_keys = ON");
    void this.ctx.blockConcurrencyWhile(async () => {
      this.#migrationReady = await migrateControlPlane(this.#database, this.#storage);
    });
  }

  status(authorityInput: unknown): ControlPlaneStatusResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedStatus(authorization.code);
    }

    return controlPlaneStatusResultSchema.parse({
      ok: true,
      status: {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        status: "ready",
      },
    });
  }

  async createAgent(authorityInput: unknown, input: unknown): Promise<CreateAgentResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = createAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
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
            eq(agentCreations.clientId, authorization.authority.clientId),
            eq(agentCreations.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingRow !== undefined) {
        if (existingRow.requestDigest !== requestDigest) {
          return this.#deniedAgent("idempotency_conflict");
        }

        return createAgentResultSchema.parse({
          agent: this.#agentFromRow(existingRow),
          created: false,
          ok: true,
        });
      }

      const agentCount = transaction.select({ value: count() }).from(agents).get()?.value ?? 0;

      if (agentCount >= MAXIMUM_AGENTS_PER_OWNER) {
        return this.#deniedAgent("agent_limit_exceeded");
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
          clientId: authorization.authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision: 1,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent.created",
          clientId: authorization.authority.clientId,
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

  async createRunAdmission(
    authorityInput: unknown,
    input: unknown,
  ): Promise<CreateRunAdmissionResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedRunAdmission(authorization.code);
    }

    return this.#runAdmissions.create(authorization.authority, input);
  }

  verifyRunAdmission(input: unknown): Promise<VerifyRunAdmissionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve(INVALID_RUN_ADMISSION);
    }

    return this.#runAdmissions.verify(input);
  }

  confirmRunAdmission(input: unknown): Promise<ConfirmRunAdmissionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve(INVALID_RUN_ADMISSION);
    }

    return this.#runAdmissions.confirm(input);
  }

  verifyActiveRunAdmission(input: unknown): VerifyActiveRunAdmissionResult {
    if (!this.#migrationReady) {
      return INVALID_RUN_ADMISSION;
    }

    return this.#runAdmissions.verifyActive(input);
  }

  redeemRunReceiverCapability(input: unknown): RedeemRunReceiverCapabilityResult {
    if (!this.#migrationReady) {
      return INVALID_RUN_ADMISSION;
    }

    const capability = runReceiverCapabilitySchema.safeParse(input);

    if (!capability.success || capability.data.ownerKey !== this.#objectName) {
      return INVALID_RUN_ADMISSION;
    }

    const pending = this.#pendingRunReceiverCapabilities.get(capability.data.nonce);
    this.#pendingRunReceiverCapabilities.delete(capability.data.nonce);

    if (
      pending === undefined ||
      pending.expiresAt <= Date.now() ||
      pending.canonical !== JSON.stringify(capability.data)
    ) {
      return INVALID_RUN_ADMISSION;
    }

    return this.#runAdmissions.verifyReceiverCapability(capability.data);
  }

  async startRun(authorityInput: unknown, input: unknown): Promise<StartRunResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedStartRun(authorization.code);
    }

    const request = startRunInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedStartRun("invalid_request");
    }

    const admission = await this.#runAdmissions.create(authorization.authority, {
      agentId: request.data.agentId,
      expectedRevision: request.data.expectedRevision,
      idempotencyKey: request.data.idempotencyKey,
      promptCharacters: request.data.prompt.length,
      promptDigest: await digestRunPrompt(request.data.prompt),
    });

    if (!admission.ok) {
      return this.#deniedStartRun(admission.error.code);
    }

    const runId = admission.state === "issued" ? admission.permit.runId : admission.admission.runId;
    const storedAdmission = this.#runAdmissions.read(runId);

    if (storedAdmission === undefined) {
      return this.#deniedStartRun("run_unavailable");
    }

    const { agentId, agentRevision } = storedAdmission;
    const agent = this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId,
        ownerKey: authorization.authority.ownerKey,
      }),
    );

    if (admission.state === "expired") {
      return startRunResultSchema.parse({
        created: false,
        ok: true,
        run: {
          agentId,
          agentRevision,
          createdAt: new Date(storedAdmission.createdAt).toISOString(),
          runId,
          status: "failed",
        },
      });
    }

    let accepted: unknown;

    try {
      if (admission.state === "issued") {
        accepted = await agent.acceptRunAdmission({
          permit: admission.permit,
          prompt: request.data.prompt,
        });
      } else {
        const capability = this.#issueRunReceiverCapability(
          authorization.authority,
          storedAdmission,
          "resume",
        );

        if (capability === undefined) {
          return this.#deniedStartRun("run_unavailable");
        }

        accepted = await agent.resumeRunAdmission({
          capability,
          prompt: request.data.prompt,
        });
      }
    } catch {
      return this.#deniedStartRun("run_unavailable");
    }

    const acceptance = acceptRunAdmissionResultSchema.safeParse(accepted);

    if (
      !acceptance.success ||
      !acceptance.data.ok ||
      acceptance.data.runId !== runId ||
      acceptance.data.agentId !== agentId ||
      acceptance.data.agentRevision !== agentRevision
    ) {
      return this.#deniedStartRun("run_unavailable");
    }

    let inspected: unknown;

    try {
      const capability = this.#issueRunReceiverCapability(
        authorization.authority,
        storedAdmission,
        "inspect",
      );

      if (capability === undefined) {
        return this.#deniedStartRun("run_unavailable");
      }

      inspected = await agent.inspectAdmittedRun({ capability });
    } catch {
      return this.#deniedStartRun("run_unavailable");
    }

    const result = inspectAdmittedRunResultSchema.safeParse(inspected);

    if (
      !result.success ||
      !result.data.ok ||
      result.data.run.runId !== runId ||
      result.data.run.agentId !== agentId ||
      result.data.run.agentRevision !== agentRevision
    ) {
      return this.#deniedStartRun("run_unavailable");
    }

    return startRunResultSchema.parse({
      created: admission.state === "issued" && admission.created,
      ok: true,
      run: {
        ...result.data.run,
        createdAt: new Date(storedAdmission.createdAt).toISOString(),
      },
    });
  }

  async inspectRun(authorityInput: unknown, input: unknown): Promise<InspectRunResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedInspectRun(authorization.code);
    }

    const request = inspectRunInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedInspectRun("invalid_request");
    }

    const admission = this.#runAdmissions.read(request.data.runId);

    if (admission === undefined) {
      return this.#deniedInspectRun("run_not_found");
    }

    if (admission.status !== "redeemed") {
      return inspectRunResultSchema.parse({
        ok: true,
        run: {
          agentId: admission.agentId,
          agentRevision: admission.agentRevision,
          createdAt: new Date(admission.createdAt).toISOString(),
          runId: admission.runId,
          status: admission.status === "expired" ? "failed" : "queued",
        },
      });
    }

    const agent = this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId: admission.agentId,
        ownerKey: authorization.authority.ownerKey,
      }),
    );
    let inspected: unknown;

    try {
      const capability = this.#issueRunReceiverCapability(
        authorization.authority,
        admission,
        "inspect",
      );

      if (capability === undefined) {
        return this.#deniedInspectRun("run_unavailable");
      }

      inspected = await agent.inspectAdmittedRun({ capability });
    } catch {
      return this.#deniedInspectRun("run_unavailable");
    }

    const result = inspectAdmittedRunResultSchema.safeParse(inspected);

    if (
      !result.success ||
      !result.data.ok ||
      result.data.run.runId !== admission.runId ||
      result.data.run.agentId !== admission.agentId ||
      result.data.run.agentRevision !== admission.agentRevision
    ) {
      return this.#deniedInspectRun("run_unavailable");
    }

    return inspectRunResultSchema.parse({
      ok: true,
      run: {
        ...result.data.run,
        createdAt: new Date(admission.createdAt).toISOString(),
      },
    });
  }

  async reserveConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ReserveConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionLink(authorization.code);
    }

    const request = createConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionLink("invalid_request");
    }

    const requestDigest = await digestConnectionLink(request.data);
    const authorizationToken = createConnectionAuthorizationToken();
    const authorizationTokenDigest = await digestCanonicalRequest(authorizationToken);
    const currentTime = Date.now();
    const recoverAfter = currentTime + CONNECTION_LINK_UNKNOWN_RECOVERY_MS;

    await this.#scheduleConnectionLinkCleanup(recoverAfter);

    return this.#database.transaction((transaction) => {
      this.#expireConnectionLinkRequests(transaction, currentTime);

      const existingRequest = transaction
        .select({
          connectionId: connectionLinkRequests.connectionId,
          expiresAt: connectionLinkRequests.expiresAt,
          redirectUrl: connectionLinkRequests.redirectUrl,
          requestDigest: connectionLinkRequests.requestDigest,
          reservationId: connectionLinkRequests.reservationId,
          status: connectionLinkRequests.status,
        })
        .from(connectionLinkRequests)
        .where(
          and(
            eq(connectionLinkRequests.clientId, authorization.authority.clientId),
            eq(connectionLinkRequests.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingRequest !== undefined) {
        if (existingRequest.requestDigest !== requestDigest) {
          return this.#deniedConnectionLink("idempotency_conflict");
        }

        if (existingRequest.status === "expired") {
          return this.#deniedConnectionLink("connection_link_expired");
        }

        if (existingRequest.status !== "completed") {
          return this.#deniedConnectionLink("connection_link_outcome_unknown");
        }

        const expiresAt = existingRequest.expiresAt;

        if (expiresAt === null || expiresAt <= currentTime) {
          return this.#deniedConnectionLink("connection_link_expired");
        }

        return reserveConnectionLinkResultSchema.parse({
          connectionLink: this.#connectionLinkFromRow(existingRequest),
          ok: true,
          state: "replay",
        });
      }

      const pendingRequest = transaction
        .select({ reservationId: connectionLinkRequests.reservationId })
        .from(connectionLinkRequests)
        .where(
          and(
            eq(connectionLinkRequests.authConfigId, request.data.authConfigId),
            eq(connectionLinkRequests.status, "pending"),
            gt(connectionLinkRequests.recoverAfter, currentTime),
          ),
        )
        .limit(1)
        .all()[0];

      if (pendingRequest !== undefined) {
        return this.#deniedConnectionLink("connection_link_in_progress");
      }

      const requestCount =
        transaction.select({ value: count() }).from(connectionLinkRequests).get()?.value ?? 0;

      if (requestCount >= MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER) {
        return this.#deniedConnectionLink("connection_link_request_limit_exceeded");
      }

      const connectionCount =
        transaction.select({ value: count() }).from(connections).get()?.value ?? 0;
      const pendingCount =
        transaction
          .select({ value: count() })
          .from(connectionLinkRequests)
          .where(
            and(
              eq(connectionLinkRequests.status, "pending"),
              gt(connectionLinkRequests.recoverAfter, currentTime),
            ),
          )
          .get()?.value ?? 0;

      if (connectionCount + pendingCount >= MAXIMUM_CONNECTIONS_PER_OWNER) {
        return this.#deniedConnectionLink("connection_limit_exceeded");
      }

      const reservationId = `connection_link_${crypto.randomUUID()}`;

      transaction
        .insert(connectionLinkRequests)
        .values({
          authConfigId: request.data.authConfigId,
          clientId: authorization.authority.clientId,
          createdAt: currentTime,
          idempotencyKey: request.data.idempotencyKey,
          recoverAfter,
          requestDigest,
          reservationId,
          status: "pending",
        })
        .run();
      transaction
        .insert(connectionAuthorizationReturns)
        .values({
          createdAt: currentTime,
          expiresAt: recoverAfter,
          reservationId,
          status: "pending",
          tokenDigest: authorizationTokenDigest,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.link_reserved",
          clientId: authorization.authority.clientId,
          occurredAt: currentTime,
          subjectId: reservationId,
        })
        .run();

      return reserveConnectionLinkResultSchema.parse({
        authorizationExpiresAt: new Date(recoverAfter).toISOString(),
        authorizationToken,
        ok: true,
        reservationId,
        state: "dispatch",
      });
    });
  }

  async completeConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<CreateConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionLink(authorization.code);
    }

    const request = completeConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionLink("invalid_request");
    }

    if (!isCanonicalComposioConnectUrl(request.data.url)) {
      return this.#deniedConnectionLink("invalid_request");
    }

    const authorizationTokenDigest = await digestCanonicalRequest(request.data.authorizationToken);
    const result = this.#database.transaction((transaction) => {
      const currentTime = Date.now();

      this.#expireConnectionLinkRequests(transaction, currentTime);

      const row = transaction
        .select({
          authConfigId: connectionLinkRequests.authConfigId,
          authorizationStatus: connectionAuthorizationReturns.status,
          authorizationTokenDigest: connectionAuthorizationReturns.tokenDigest,
          connectionId: connectionLinkRequests.connectionId,
          expiresAt: connectionLinkRequests.expiresAt,
          providerConnectionId: connections.providerConnectionId,
          recoverAfter: connectionLinkRequests.recoverAfter,
          redirectUrl: connectionLinkRequests.redirectUrl,
          status: connectionLinkRequests.status,
        })
        .from(connectionLinkRequests)
        .leftJoin(
          connectionAuthorizationReturns,
          eq(connectionAuthorizationReturns.reservationId, connectionLinkRequests.reservationId),
        )
        .leftJoin(connections, eq(connections.connectionId, connectionLinkRequests.connectionId))
        .where(
          and(
            eq(connectionLinkRequests.clientId, authorization.authority.clientId),
            eq(connectionLinkRequests.reservationId, request.data.reservationId),
          ),
        )
        .all()[0];

      if (row === undefined || row.authorizationTokenDigest !== authorizationTokenDigest) {
        return this.#deniedConnectionLink("invalid_request");
      }

      if (row.status === "expired") {
        return this.#deniedConnectionLink("connection_link_expired");
      }

      if (row.status === "completed") {
        if (
          row.providerConnectionId !== request.data.providerConnectionId ||
          row.redirectUrl !== request.data.url ||
          row.expiresAt !== Date.parse(request.data.expiresAt)
        ) {
          return this.#deniedConnectionLink("invalid_request");
        }

        return createConnectionLinkResultSchema.parse({
          connectionLink: this.#connectionLinkFromRow(row),
          created: false,
          ok: true,
        });
      }

      const recoverAfter = row.recoverAfter;
      const expiresAt = Date.parse(request.data.expiresAt);

      if (
        row.status !== "pending" ||
        row.authorizationStatus !== "pending" ||
        currentTime >= recoverAfter ||
        expiresAt <= currentTime ||
        expiresAt > recoverAfter
      ) {
        return this.#deniedConnectionLink("connection_link_outcome_unknown");
      }

      const authConfigId = row.authConfigId;
      const existingConnection = transaction
        .select({
          authConfigId: connections.authConfigId,
          connectionId: connections.connectionId,
        })
        .from(connections)
        .where(eq(connections.providerConnectionId, request.data.providerConnectionId))
        .all()[0];
      let connectionId: string;

      if (existingConnection === undefined) {
        connectionId = `connection_${crypto.randomUUID()}`;
        transaction
          .insert(connections)
          .values({
            authConfigId,
            connectionId,
            createdAt: currentTime,
            provider: "composio",
            providerConnectionId: request.data.providerConnectionId,
            status: "initiated",
          })
          .run();
      } else {
        if (existingConnection.authConfigId !== authConfigId) {
          return this.#deniedConnectionLink("connection_link_outcome_unknown");
        }

        connectionId = existingConnection.connectionId;
      }

      transaction
        .update(connectionLinkRequests)
        .set({
          completedAt: currentTime,
          connectionId,
          expiresAt,
          redirectUrl: request.data.url,
          status: "completed",
        })
        .where(
          and(
            eq(connectionLinkRequests.clientId, authorization.authority.clientId),
            eq(connectionLinkRequests.reservationId, request.data.reservationId),
            eq(connectionLinkRequests.status, "pending"),
          ),
        )
        .run();
      transaction
        .update(connectionAuthorizationReturns)
        .set({ connectionId, expiresAt })
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, authorizationTokenDigest),
            eq(connectionAuthorizationReturns.status, "pending"),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.link_created",
          clientId: authorization.authority.clientId,
          occurredAt: currentTime,
          subjectId: connectionId,
        })
        .run();

      return createConnectionLinkResultSchema.parse({
        connectionLink: {
          connectionId,
          expiresAt: request.data.expiresAt,
          url: request.data.url,
        },
        created: true,
        ok: true,
      });
    });

    if (result.ok) {
      await this.#scheduleConnectionLinkCleanup(Date.parse(result.connectionLink.expiresAt));
    }

    return result;
  }

  async recordConnectionAuthorizationReturn(
    input: unknown,
  ): Promise<RecordConnectionAuthorizationReturnResult> {
    if (!this.#migrationReady) {
      return this.#deniedConnectionAuthorizationReturn();
    }

    const request = recordConnectionAuthorizationReturnInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionAuthorizationReturn();
    }

    const tokenDigest = await digestCanonicalRequest(request.data.authorizationToken);

    return this.#database.transaction((transaction) => {
      const currentTime = Date.now();

      this.#expireConnectionLinkRequests(transaction, currentTime);

      const row = transaction
        .select({
          authorizationExpiresAt: connectionAuthorizationReturns.expiresAt,
          authorizationStatus: connectionAuthorizationReturns.status,
          clientId: connectionLinkRequests.clientId,
          connectionId: connectionAuthorizationReturns.connectionId,
          providerConnectionId: connections.providerConnectionId,
          requestStatus: connectionLinkRequests.status,
        })
        .from(connectionAuthorizationReturns)
        .innerJoin(
          connectionLinkRequests,
          eq(connectionLinkRequests.reservationId, connectionAuthorizationReturns.reservationId),
        )
        .leftJoin(
          connections,
          eq(connections.connectionId, connectionAuthorizationReturns.connectionId),
        )
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, tokenDigest),
          ),
        )
        .all()[0];

      if (row === undefined) {
        return this.#deniedConnectionAuthorizationReturn();
      }

      const desiredOutcome = request.data.status === "success" ? "returned" : "failed";
      const currentOutcome = row.authorizationStatus;
      const storedProviderConnectionId = row.providerConnectionId;

      if (currentOutcome === "returned" || currentOutcome === "failed") {
        if (
          currentOutcome !== desiredOutcome ||
          typeof storedProviderConnectionId !== "string" ||
          (request.data.providerConnectionId !== undefined &&
            request.data.providerConnectionId !== storedProviderConnectionId) ||
          (desiredOutcome === "returned" &&
            request.data.providerConnectionId !== storedProviderConnectionId)
        ) {
          return this.#deniedConnectionAuthorizationReturn();
        }

        return recordConnectionAuthorizationReturnResultSchema.parse({
          ok: true,
          outcome: desiredOutcome,
          recorded: false,
        });
      }

      const authorizationExpiresAt = row.authorizationExpiresAt;
      const connectionId = row.connectionId;
      const clientId = row.clientId;

      if (
        currentOutcome !== "pending" ||
        row.requestStatus !== "completed" ||
        authorizationExpiresAt <= currentTime ||
        connectionId === null ||
        storedProviderConnectionId === null ||
        (request.data.providerConnectionId !== undefined &&
          request.data.providerConnectionId !== storedProviderConnectionId) ||
        (desiredOutcome === "returned" &&
          request.data.providerConnectionId !== storedProviderConnectionId)
      ) {
        return this.#deniedConnectionAuthorizationReturn();
      }

      transaction
        .update(connectionAuthorizationReturns)
        .set({ completedAt: currentTime, status: desiredOutcome })
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, tokenDigest),
            eq(connectionAuthorizationReturns.status, "pending"),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action:
            desiredOutcome === "returned"
              ? "connection.authorization_returned"
              : "connection.authorization_failed",
          clientId,
          occurredAt: currentTime,
          subjectId: connectionId,
        })
        .run();

      return recordConnectionAuthorizationReturnResultSchema.parse({
        ok: true,
        outcome: desiredOutcome,
        recorded: true,
      });
    });
  }

  override async alarm(): Promise<void> {
    if (!this.#migrationReady) {
      return;
    }

    this.#runAdmissions.cleanup(Date.now());
    const nextCleanupAt = this.#database.transaction((transaction) => {
      const currentTime = Date.now();

      this.#expireConnectionLinkRequests(transaction, currentTime);

      const completedCleanup =
        transaction
          .select({ value: min(connectionLinkRequests.expiresAt) })
          .from(connectionLinkRequests)
          .where(eq(connectionLinkRequests.status, "completed"))
          .get()?.value ?? null;
      const pendingCleanup =
        transaction
          .select({ value: min(connectionLinkRequests.recoverAfter) })
          .from(connectionLinkRequests)
          .where(eq(connectionLinkRequests.status, "pending"))
          .get()?.value ?? null;
      const scheduled = [completedCleanup, pendingCleanup].filter(
        (value): value is number => value !== null,
      );

      const nextConnectionCleanup = scheduled.length === 0 ? null : Math.min(...scheduled);

      return nextConnectionCleanup;
    });
    const nextRunCleanup = this.#runAdmissions.nextCleanupAt();
    const nextAlarm =
      nextCleanupAt === null
        ? nextRunCleanup
        : nextRunCleanup === null
          ? nextCleanupAt
          : Math.min(nextCleanupAt, nextRunCleanup);

    if (nextAlarm !== null) {
      await this.#storage.setAlarm(nextAlarm);
    }
  }

  getAgent(authorityInput: unknown, input: unknown): GetAgentResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = getAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const row = this.#currentAgentRow(request.data.id);

    if (row === undefined) {
      return this.#deniedAgent("agent_not_found");
    }

    return getAgentResultSchema.parse({
      agent: this.#agentFromRow(row),
      ok: true,
    });
  }

  getAgentRevision(authorityInput: unknown, input: unknown): GetAgentRevisionResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = getAgentRevisionInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const row = this.#agentRevisionRow(request.data.id, request.data.revision);

    if (row === undefined) {
      return this.#deniedAgent("agent_not_found");
    }

    return getAgentRevisionResultSchema.parse({
      agent: this.#agentRevisionFromRow(row),
      ok: true,
    });
  }

  listAgentRevisions(authorityInput: unknown, input: unknown): ListAgentRevisionsResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = listAgentRevisionsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
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
      return this.#deniedAgent("agent_not_found");
    }

    const hasMore = rows.length > request.data.limit;
    const revisions = rows
      .slice(0, request.data.limit)
      .map((row) => this.#agentRevisionSummaryFromRow(row));
    const nextCursor = hasMore ? (revisions.at(-1)?.revision ?? null) : null;

    return listAgentRevisionsResultSchema.parse({ nextCursor, ok: true, revisions });
  }

  async updateAgent(authorityInput: unknown, input: unknown): Promise<UpdateAgentResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = updateAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
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
            eq(agentUpdates.clientId, authorization.authority.clientId),
            eq(agentUpdates.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingUpdate !== undefined) {
        if (existingUpdate.requestDigest !== requestDigest) {
          return this.#deniedAgent("idempotency_conflict");
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
        return this.#deniedAgent("agent_not_found");
      }

      const currentAgent = this.#agentFromRow(currentRow);

      if (currentAgent.revision !== request.data.expectedRevision) {
        return this.#deniedAgent("revision_conflict");
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
        return this.#deniedAgent("no_changes");
      }

      if (currentAgent.revision >= MAXIMUM_REVISIONS_PER_AGENT) {
        return this.#deniedAgent("agent_revision_limit_exceeded");
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
          clientId: authorization.authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent.updated",
          clientId: authorization.authority.clientId,
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

  listAgents(authorityInput: unknown, input: unknown): ListAgentsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = listAgentsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
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

  listConnections(authorityInput: unknown, input: unknown): ListConnectionsResult {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionRead(authorization.code);
    }

    const request = listConnectionsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionRead("invalid_request");
    }

    const rows = this.#database
      .select({
        authConfigId: connections.authConfigId,
        connectionId: connections.connectionId,
        createdAt: connections.createdAt,
        status: connections.status,
      })
      .from(connections)
      .where(
        request.data.cursor === undefined
          ? undefined
          : gt(connections.connectionId, request.data.cursor),
      )
      .orderBy(asc(connections.connectionId))
      .limit(request.data.limit + 1)
      .all();
    const connectionIds = rows.map((row) => row.connectionId);
    const authorizationRows =
      connectionIds.length === 0
        ? []
        : this.#database
            .select({
              connectionId: connectionAuthorizationReturns.connectionId,
              reservationId: connectionAuthorizationReturns.reservationId,
              status: connectionAuthorizationReturns.status,
            })
            .from(connectionAuthorizationReturns)
            .where(inArray(connectionAuthorizationReturns.connectionId, connectionIds))
            .orderBy(
              desc(connectionAuthorizationReturns.createdAt),
              desc(connectionAuthorizationReturns.reservationId),
            )
            .all();
    const authorizationByConnection = new Map<string, StoredConnectionAuthorizationOutcome>();

    for (const authorizationRow of authorizationRows) {
      if (
        authorizationRow.connectionId !== null &&
        !authorizationByConnection.has(authorizationRow.connectionId)
      ) {
        authorizationByConnection.set(authorizationRow.connectionId, authorizationRow.status);
      }
    }

    const rowsWithAuthorization: StoredConnectionSummaryRow[] = rows.map((row) => ({
      ...row,
      authorizationOutcome: authorizationByConnection.get(row.connectionId) ?? "untracked",
    }));
    const hasMore = rows.length > request.data.limit;
    const connectionSummaries = rowsWithAuthorization
      .slice(0, request.data.limit)
      .map((row) => this.#connectionSummaryFromRow(row));
    const nextCursor = hasMore ? (connectionSummaries.at(-1)?.connectionId ?? null) : null;

    return listConnectionsResultSchema.parse({
      connections: connectionSummaries,
      nextCursor,
      ok: true,
    });
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

  #connectionLinkFromRow(row: StoredConnectionLinkRow) {
    if (row.connectionId === null || row.expiresAt === null || row.redirectUrl === null) {
      throw new Error("Invalid connection-link storage.");
    }

    return {
      connectionId: row.connectionId,
      expiresAt: new Date(row.expiresAt).toISOString(),
      url: row.redirectUrl,
    };
  }

  #connectionSummaryFromRow(row: StoredConnectionSummaryRow): ConnectionSummary {
    return connectionSummarySchema.parse({
      authorizationOutcome: row.authorizationOutcome,
      authConfigId: row.authConfigId,
      connectionId: row.connectionId,
      createdAt: new Date(row.createdAt).toISOString(),
      status: row.status,
    });
  }

  #expireConnectionLinkRequests(database: ControlPlaneWriter, currentTime: number): void {
    database
      .update(connectionAuthorizationReturns)
      .set({ status: "expired" })
      .where(
        and(
          eq(connectionAuthorizationReturns.status, "pending"),
          lte(connectionAuthorizationReturns.expiresAt, currentTime),
        ),
      )
      .run();
    database
      .update(connectionLinkRequests)
      .set({ redirectUrl: null, status: "expired" })
      .where(
        and(
          eq(connectionLinkRequests.status, "completed"),
          lte(connectionLinkRequests.expiresAt, currentTime),
        ),
      )
      .run();
    database
      .update(connectionLinkRequests)
      .set({ status: "abandoned" })
      .where(
        and(
          eq(connectionLinkRequests.status, "pending"),
          lte(connectionLinkRequests.recoverAfter, currentTime),
        ),
      )
      .run();
  }

  async #scheduleConnectionLinkCleanup(cleanupAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || cleanupAt < scheduledAlarm) {
      await this.#storage.setAlarm(cleanupAt);
    }
  }

  #issueRunReceiverCapability(
    authority: OwnerAuthority,
    admission: NonNullable<ReturnType<RunAdmissions["read"]>>,
    action: RunReceiverCapability["action"],
  ): RunReceiverCapability | undefined {
    const currentTime = Date.now();

    for (const [nonce, pending] of this.#pendingRunReceiverCapabilities) {
      if (pending.expiresAt <= currentTime) {
        this.#pendingRunReceiverCapabilities.delete(nonce);
      }
    }

    if (
      this.#objectName === undefined ||
      this.#pendingRunReceiverCapabilities.size >= MAXIMUM_PENDING_RUN_RECEIVER_CAPABILITIES
    ) {
      return undefined;
    }

    const expiresAt = currentTime + RUN_RECEIVER_CAPABILITY_LIFETIME_MS;
    const capability = runReceiverCapabilitySchema.parse({
      action,
      agentId: admission.agentId,
      agentRevision: admission.agentRevision,
      audience: "crew_agent",
      budgetReservation: admission.budgetReservation,
      capability: action === "resume" ? "run:resume" : "run:inspect",
      clientId: authority.clientId,
      connection: "none",
      effect: "none",
      expiresAt: new Date(expiresAt).toISOString(),
      idempotencyKey: admission.idempotencyKey,
      nonce: createRunReceiverNonce(),
      ownerKey: this.#objectName,
      promptDigest: admission.promptDigest,
      runId: admission.runId,
      target: "none",
    });

    this.#pendingRunReceiverCapabilities.set(capability.nonce, {
      canonical: JSON.stringify(capability),
      expiresAt,
    });

    return capability;
  }

  #authorize(authorityInput: unknown, requiredScope: OwnerScope): AuthorityResult {
    if (!this.#migrationReady) {
      return { code: "incompatible_schema", ok: false };
    }

    const result = ownerAuthoritySchema.safeParse(authorityInput);

    if (!result.success || !this.#objectName) {
      return { code: "invalid_authority", ok: false };
    }

    const authority = result.data;

    if (authority.ownerKey !== this.#objectName) {
      return { code: "owner_mismatch", ok: false };
    }

    this.#database
      .insert(controlPlane)
      .values({
        ownerKey: authority.ownerKey,
        singleton: 1,
      })
      .onConflictDoNothing()
      .run();

    const row = this.#database
      .select({
        ownerKey: controlPlane.ownerKey,
      })
      .from(controlPlane)
      .where(eq(controlPlane.singleton, 1))
      .all()[0];

    if (row?.ownerKey !== authority.ownerKey) {
      return { code: "owner_mismatch", ok: false };
    }

    if (!authority.scopes.includes(requiredScope)) {
      return { code: "insufficient_scope", ok: false };
    }

    return { authority, ok: true };
  }

  #deniedStatus(code: AuthorityErrorCode): ControlPlaneStatusResult {
    return controlPlaneStatusResultSchema.parse({
      error: {
        code,
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  }

  #deniedAgent(code: AgentRequestErrorCode): AgentRequestFailure {
    return {
      error: {
        code,
        message: "Agent request denied.",
      },
      ok: false,
    };
  }

  #deniedConnectionLink(code: ConnectionLinkRequestErrorCode): ConnectionLinkRequestFailure {
    return {
      error: {
        code,
        message: "Connection link request denied.",
      },
      ok: false,
    };
  }

  #deniedConnectionRead(code: ConnectionReadRequestErrorCode): ConnectionReadRequestFailure {
    return {
      error: {
        code,
        message: "Connection request denied.",
      },
      ok: false,
    };
  }

  #deniedConnectionAuthorizationReturn(): ConnectionAuthorizationReturnFailure {
    return {
      error: {
        code: "invalid_return",
        message: "Connection authorization return denied.",
      },
      ok: false,
    };
  }

  #deniedRunAdmission(code: AuthorityErrorCode): RunAdmissionRequestFailure {
    return {
      error: {
        code,
        message: "Run admission denied.",
      },
      ok: false,
    };
  }

  #deniedStartRun(code: StartRunRequestFailure["error"]["code"]): StartRunRequestFailure {
    return {
      error: {
        code,
        message: "Run request denied.",
      },
      ok: false,
    };
  }

  #deniedInspectRun(code: InspectRunRequestFailure["error"]["code"]): InspectRunRequestFailure {
    return {
      error: {
        code,
        message: "Run request denied.",
      },
      ok: false,
    };
  }
}
