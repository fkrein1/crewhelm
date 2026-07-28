import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  changeAuthorityInputSchema,
  controlPlaneStatusResultSchema,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  ownerAuthoritySchema,
  type ControlPlaneStatusResult,
  type CancelRunResult,
  type CreateAgentResult,
  type CreateConnectionLinkResult,
  type EnableIntegrationResult,
  type ConfirmRunAdmissionResult,
  type CreateRunAdmissionResult,
  type GetAgentRevisionResult,
  type GetAgentResult,
  type ListAgentRevisionsResult,
  type ListAgentsResult,
  type ListConnectionsResult,
  type LookupAgentConnectionConfigurationResult,
  type InspectRunResult,
  type ListRunToolApprovalsResult,
  type DecideRunToolApprovalResult,
  type OwnerAuthority,
  type OwnerScope,
  type RecordConnectionAuthorizationReturnResult,
  type RedeemRunReceiverCapabilityResult,
  type ReserveConnectionLinkResult,
  type ReserveIntegrationEnablementResult,
  type StartRunResult,
  type UpdateAgentResult,
  type VerifyActiveRunAdmissionResult,
  type VerifyRunAdmissionResult,
  type CompleteToolExecutionResult,
  type ConfigureAgentConnectionResult,
  type EvaluateToolExecutionResult,
  type ResolvedConnectionForAttachment,
  type ReserveToolExecutionResult,
  type ResolveToolExecutionConnectionResult,
  type ChangeAuthorityResult,
  type ReconcileToolExecutionResult,
} from "@crewhelm/contracts";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  AgentChannel,
  deniedCancelRun,
  deniedDecideRunToolApproval,
  deniedInspectRun,
  deniedListRunToolApprovals,
  deniedStartRun,
} from "./agent-channel/module.js";
import { AgentRegistry, deniedAgent, deniedConnectionAttachment } from "./agents/module.js";
import {
  Connections,
  deniedConnectionAuthorizationReturn,
  deniedConnectionLink,
  deniedConnectionRead,
  deniedIntegrationEnablement,
} from "./connections/module.js";
import { CONTROL_PLANE_SCHEMA_VERSION, migrateControlPlane } from "./migrations.js";
import { controlPlane, controlPlaneSchema, type ControlPlaneDatabaseSchema } from "./schema.js";

import { RunAdmissions } from "./runs/module.js";
import { ToolExecutions, deniedToolExecutionReconciliation } from "./runs/tool-execution.js";
import { AuthorityControls, deniedAuthorityControl } from "./recovery/module.js";

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
type RunAdmissionRequestFailure = Extract<CreateRunAdmissionResult, { ok: false }>;
type AuthorityResult =
  | { authority: OwnerAuthority; ok: true }
  | { code: AuthorityErrorCode; ok: false };
export class OwnerControlPlane extends DurableObject {
  readonly #database: DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;
  #migrationReady = false;
  readonly #runAdmissions: RunAdmissions;
  readonly #toolExecutions: ToolExecutions;
  readonly #agents: AgentRegistry;
  readonly #connections: Connections;
  readonly #agentChannel: AgentChannel;
  readonly #authorityControls: AuthorityControls;

  constructor(state: DurableObjectState, environment: Cloudflare.Env) {
    super(state, environment);
    this.#objectName = state.id.name;
    this.#storage = state.storage;
    this.#database = drizzle(this.#storage, {
      logger: false,
      schema: controlPlaneSchema,
    });
    this.#runAdmissions = new RunAdmissions(this.#objectName, this.#database, this.#storage);
    this.#toolExecutions = new ToolExecutions(this.#objectName, this.#database, this.#storage);
    this.#agents = new AgentRegistry(this.#database);
    this.#connections = new Connections(this.#database, this.#storage);
    this.#authorityControls = new AuthorityControls(this.#database);
    this.#agentChannel = new AgentChannel(
      this.#objectName,
      this.#database,
      environment.CREW_AGENT,
      this.#runAdmissions,
      this.#toolExecutions,
    );
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
      return deniedAgent(authorization.code);
    }

    return this.#agents.create(authorization.authority, input);
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

  evaluateToolExecution(input: unknown): Promise<EvaluateToolExecutionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve({
        error: { code: "invalid_execution", message: "Tool execution denied." },
        ok: false,
      });
    }

    return this.#toolExecutions.evaluate(input);
  }

  reserveToolExecution(input: unknown): Promise<ReserveToolExecutionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve({
        error: { code: "invalid_execution", message: "Tool execution denied." },
        ok: false,
      });
    }

    return this.#toolExecutions.reserve(input);
  }

  completeToolExecution(input: unknown): Promise<CompleteToolExecutionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve({
        error: { code: "invalid_execution", message: "Tool execution denied." },
        ok: false,
      });
    }

    return this.#toolExecutions.complete(input);
  }

  resolveToolExecutionConnection(input: unknown): Promise<ResolveToolExecutionConnectionResult> {
    if (!this.#migrationReady) {
      return Promise.resolve({
        error: { code: "invalid_execution", message: "Tool execution denied." },
        ok: false,
      });
    }

    return this.#toolExecutions.resolveConnection(input);
  }

  changeAuthority(authorityInput: unknown, input: unknown): ChangeAuthorityResult {
    const request = changeAuthorityInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAuthorityControl("invalid_request");
    }

    const requiredScope =
      request.data.target === "connection" ? CONNECTIONS_WRITE_SCOPE : AGENTS_WRITE_SCOPE;
    const authorization = this.#authorize(authorityInput, requiredScope);

    return authorization.ok
      ? this.#authorityControls.change(authorization.authority, request.data)
      : deniedAuthorityControl(authorization.code);
  }

  reconcileToolExecution(authorityInput: unknown, input: unknown): ReconcileToolExecutionResult {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#toolExecutions.reconcile(authorization.authority, input)
      : deniedToolExecutionReconciliation(authorization.code);
  }

  redeemRunReceiverCapability(input: unknown): RedeemRunReceiverCapabilityResult {
    return this.#migrationReady ? this.#agentChannel.redeem(input) : INVALID_RUN_ADMISSION;
  }

  async startRun(authorityInput: unknown, input: unknown): Promise<StartRunResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentChannel.start(authorization.authority, input)
      : deniedStartRun(authorization.code);
  }

  async cancelRun(authorityInput: unknown, input: unknown): Promise<CancelRunResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentChannel.cancel(authorization.authority, input)
      : deniedCancelRun(authorization.code);
  }

  async inspectRun(authorityInput: unknown, input: unknown): Promise<InspectRunResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentChannel.inspect(authorization.authority, input)
      : deniedInspectRun(authorization.code);
  }

  async listRunToolApprovals(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ListRunToolApprovalsResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentChannel.listApprovals(authorization.authority, input)
      : deniedListRunToolApprovals(authorization.code);
  }

  async decideRunToolApproval(
    authorityInput: unknown,
    input: unknown,
  ): Promise<DecideRunToolApprovalResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentChannel.decideApproval(authorization.authority, input)
      : deniedDecideRunToolApproval(authorization.code);
  }

  async reserveConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ReserveConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    return authorization.ok
      ? this.#connections.reserve(authorization.authority, input)
      : deniedConnectionLink(authorization.code);
  }

  async reserveIntegrationEnablement(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ReserveIntegrationEnablementResult> {
    const authorization = this.#authorize(authorityInput, CONNECTION_CONFIGS_WRITE_SCOPE);

    return authorization.ok
      ? this.#connections.reserveIntegrationEnablement(authorization.authority, input)
      : deniedIntegrationEnablement(authorization.code);
  }

  async completeIntegrationEnablement(
    authorityInput: unknown,
    input: unknown,
  ): Promise<EnableIntegrationResult> {
    const authorization = this.#authorize(authorityInput, CONNECTION_CONFIGS_WRITE_SCOPE);

    return authorization.ok
      ? this.#connections.completeIntegrationEnablement(authorization.authority, input)
      : deniedIntegrationEnablement(authorization.code);
  }

  async completeConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<CreateConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    return authorization.ok
      ? this.#connections.complete(authorization.authority, input)
      : deniedConnectionLink(authorization.code);
  }

  recordConnectionAuthorizationReturn(
    input: unknown,
  ): Promise<RecordConnectionAuthorizationReturnResult> {
    return this.#migrationReady
      ? this.#connections.recordAuthorizationReturn(input)
      : Promise.resolve(deniedConnectionAuthorizationReturn());
  }

  override async alarm(): Promise<void> {
    if (!this.#migrationReady) {
      return;
    }

    const currentTime = Date.now();
    this.#toolExecutions.reconcileExpired(currentTime);
    this.#runAdmissions.cleanup(currentTime);
    const nextConnectionCleanup = this.#connections.cleanup(currentTime);
    const nextRunCleanup = this.#runAdmissions.nextCleanupAt();
    const nextToolReconciliation = this.#toolExecutions.nextReconciliationAt();
    const nextAlarm =
      [nextConnectionCleanup, nextRunCleanup, nextToolReconciliation]
        .filter((candidate): candidate is number => candidate !== null)
        .toSorted((left, right) => left - right)[0] ?? null;

    if (nextAlarm !== null) {
      await this.#storage.setAlarm(nextAlarm);
    }
  }

  getAgent(authorityInput: unknown, input: unknown): GetAgentResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok ? this.#agents.get(input) : deniedAgent(authorization.code);
  }

  getAgentRevision(authorityInput: unknown, input: unknown): GetAgentRevisionResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok ? this.#agents.getRevision(input) : deniedAgent(authorization.code);
  }

  listAgentRevisions(authorityInput: unknown, input: unknown): ListAgentRevisionsResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok ? this.#agents.listRevisions(input) : deniedAgent(authorization.code);
  }

  async updateAgent(authorityInput: unknown, input: unknown): Promise<UpdateAgentResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#agents.update(authorization.authority, input)
      : deniedAgent(authorization.code);
  }

  async lookupAgentConnectionConfiguration(
    authorityInput: unknown,
    input: unknown,
  ): Promise<LookupAgentConnectionConfigurationResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return deniedConnectionAttachment(authorization.code);
    }

    if (!authorization.authority.scopes.includes(CONNECTIONS_READ_SCOPE)) {
      return deniedConnectionAttachment("insufficient_scope");
    }

    return this.#agents.lookupConnectionConfiguration(authorization.authority, input);
  }

  resolveConnectionForAttachment(
    authorityInput: unknown,
    input: unknown,
  ): ResolvedConnectionForAttachment {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return {
        error: {
          code: authorization.code,
          message: "Connection attachment request denied.",
        },
        ok: false,
      };
    }

    if (!authorization.authority.scopes.includes(CONNECTIONS_READ_SCOPE)) {
      return {
        error: {
          code: "insufficient_scope",
          message: "Connection attachment request denied.",
        },
        ok: false,
      };
    }

    return this.#agents.resolveConnectionForAttachment(input);
  }

  async configureAgentConnection(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ConfigureAgentConnectionResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return deniedConnectionAttachment(authorization.code);
    }

    if (!authorization.authority.scopes.includes(CONNECTIONS_READ_SCOPE)) {
      return deniedConnectionAttachment("insufficient_scope");
    }

    return this.#agents.configureConnection(authorization.authority, input);
  }

  listAgents(authorityInput: unknown, input: unknown): ListAgentsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok ? this.#agents.list(input) : deniedAgent(authorization.code);
  }

  listConnections(authorityInput: unknown, input: unknown): ListConnectionsResult {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_READ_SCOPE);

    return authorization.ok
      ? this.#connections.list(input)
      : deniedConnectionRead(authorization.code);
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

  #deniedRunAdmission(code: AuthorityErrorCode): RunAdmissionRequestFailure {
    return {
      error: {
        code,
        message: "Run admission denied.",
      },
      ok: false,
    };
  }
}
