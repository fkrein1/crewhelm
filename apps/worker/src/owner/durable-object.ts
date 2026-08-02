import {
  agentInboxInputSchema,
  agentWatchesInputSchema,
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  batchDisableAgentsInputSchema,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  changeAuthorityInputSchema,
  completeAgentConnectionConfigurationInputSchema,
  configureAgentScheduleInputSchema,
  controlPlaneStatusInputSchema,
  controlPlaneStatusResultSchema,
  listAuditEventsInputSchema,
  listAuditEventsResultSchema,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  startAgentWorkflowInputSchema,
  startRunInputSchema,
  ownerAuthoritySchema,
  type ControlPlaneStatusResult,
  type AgentInboxDeferredReason,
  type AgentInboxResult,
  type AgentWatchOccurrence,
  type CancelRunResult,
  type BatchDisableAgentsResult,
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
  type ListUnresolvedToolEffectsResult,
  type LookupAgentConnectionConfigurationResult,
  type InspectRunResult,
  type InspectAgentSessionResult,
  type ListRunToolApprovalsResult,
  type ListAgentRunsResult,
  type ListAgentSessionsResult,
  type DecideRunToolApprovalResult,
  type OwnerAuthority,
  type OwnerScope,
  type RecordAgentInboxRunResult,
  type RecordConnectionAuthorizationReturnResult,
  type RedeemRunReceiverCapabilityResult,
  type ReserveConnectionLinkResult,
  type ReserveIntegrationEnablementResult,
  type StartRunResult,
  type UpdateAgentResult,
  type VerifyActiveRunAdmissionResult,
  type VerifyRunAdmissionResult,
  type CompleteToolExecutionResult,
  type CompleteRuntimeToolExecutionResult,
  type ConfigureAgentConnectionResult,
  type EvaluateToolExecutionResult,
  type ResolvedConnectionForAttachment,
  type ReserveToolExecutionResult,
  type ReserveRuntimeToolExecutionResult,
  type DispatchRuntimeToolExecutionResult,
  type ResolveToolExecutionConnectionResult,
  type ChangeAuthorityResult,
  type ReconcileToolExecutionResult,
  type ConfigureAgentScheduleResult,
  type GetAgentScheduleResult,
  type ListAgentSchedulesResult,
  type ConfigureFleetConfigurationResult,
  type GetFleetConfigurationResult,
  type GetSkillResult,
  type ListAuditEventsResult,
  type ListSkillsResult,
  type PublishSkillResult,
  type RetireSkillResult,
  type GetAgentBlueprintResult,
  type InstantiateAgentBlueprintResult,
  type ListAgentBlueprintsResult,
  type PublishAgentBlueprintResult,
  type RetireAgentBlueprintResult,
  type DeleteAgentSessionResult,
  type CancelAgentWorkflowResult,
  type CompleteAgentWorkflowStageResult,
  type DeleteAgentWorkflowResult,
  type DispatchAgentWorkflowStageResult,
  type InspectAgentWorkflowResult,
  type ListAgentWorkflowsResult,
  type StartAgentWorkflowResult,
  type CreateBriefResult,
  type ReviseBriefResult,
  type ListBriefsResult,
  type InspectBriefResult,
  type ReadBriefResult,
  type DeleteBriefResult,
} from "@crewhelm/contracts";
import {
  createComposioEventCatalog,
  createComposioTriggerInstances,
  createComposioWebhookSubscriptions,
  verifiedComposioTriggerEventSchema,
} from "@crewhelm/composio";
import { DurableObject } from "cloudflare:workers";
import { and, count, desc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  availableAgentCapabilityPrerequisites,
  defaultAgentModelForPrerequisites,
} from "../agent-capabilities/registry.js";
import {
  AgentChannel,
  deniedAgentInbox,
  deniedCancelRun,
  deniedDecideRunToolApproval,
  deniedInspectRun,
  deniedListAgentRuns,
  deniedListRunToolApprovals,
  deniedStartRun,
} from "./agent-channel/index.js";
import { AgentRegistry, deniedAgent, deniedConnectionAttachment } from "./agents/index.js";
import { AgentBlueprints, deniedAgentBlueprint } from "./agent-blueprints/index.js";
import {
  Connections,
  deniedConnectionAuthorizationReturn,
  deniedConnectionLink,
  deniedConnectionRead,
  deniedIntegrationEnablement,
} from "./connections/index.js";
import { FleetConfigurations, deniedFleetConfiguration } from "./configuration/index.js";
import { CONTROL_PLANE_SCHEMA_VERSION, migrateControlPlane } from "./migrations.js";
import {
  auditEvents,
  aiGatewayCalls,
  controlPlane,
  controlPlaneSchema,
  toolApprovals,
  type ControlPlaneDatabaseSchema,
} from "./schema.js";

import {
  AuthorityControls,
  deniedAuthorityControl,
  deniedBatchAgentDisable,
} from "./recovery/index.js";
import {
  RunAdmissions,
  RuntimeToolExecutions,
  ToolExecutions,
  deniedToolExecutionEvaluation,
  deniedToolExecutionReconciliation,
  deniedUnresolvedToolEffects,
} from "./runs/index.js";
import { recordScheduleEvent } from "../observability/schedules.js";
import { AgentSchedules, deniedAgentSchedule, type DueAgentSchedule } from "./schedules/index.js";
import {
  AgentEventWatches,
  AgentWatches,
  COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME,
  ComposioWebhookIngress,
  deniedAgentWatch,
  eventWatchIdempotencyKey,
  eventWatchPrompt,
  type ComposioWebhookIngressResult,
  type DueAgentEventWatch,
} from "./watches/index.js";
import { AiGatewayUsage } from "./usage/index.js";
import { R2SkillPackageObjectStore, Skills, deniedSkill } from "./skills/index.js";
import { AgentWorkflows } from "./workflows/index.js";
import { Briefs, R2OwnerContentObjectStore, deniedBrief } from "./briefs/index.js";

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
type StartRunFailureCode = Extract<StartRunResult, { ok: false }>["error"]["code"];
type AuthorityResult =
  | { authority: OwnerAuthority; ok: true }
  | { code: AuthorityErrorCode; ok: false };
type AgentWatchRpc = {
  agentId: string;
  agentRevision: number;
  createdAt: string;
  id: string;
  lastOccurrence: AgentWatchOccurrence | null;
  nextCheckAt: string | null;
  revision: number;
  status: "active" | "paused";
};
type AgentWatchesRpcResult =
  | { error: { code: string; message: string }; ok: false }
  | { action: "sources"; ok: true; sources: unknown[] }
  | {
      action: "create" | "pause" | "resume" | "update";
      changed: boolean;
      ok: true;
      watch: AgentWatchRpc;
    }
  | { action: "delete"; deleted: boolean; ok: true; watchId: string }
  | { action: "inspect"; ok: true; watch: AgentWatchRpc }
  | { action: "list"; ok: true; watches: AgentWatchRpc[] }
  | {
      action: "history";
      occurrences: AgentWatchOccurrence[];
      ok: true;
      watchId: string;
    };

function scheduledRunFailureReason(code: StartRunFailureCode): AgentInboxDeferredReason {
  switch (code) {
    case "admission_limit_exceeded":
    case "agent_not_found":
    case "agent_unavailable":
    case "budget_exhausted":
    case "brief_context_too_large":
    case "brief_unavailable":
    case "capability_unavailable":
    case "idempotency_conflict":
    case "model_unavailable":
    case "revision_conflict":
    case "run_unavailable":
      return code;
    case "incompatible_schema":
    case "insufficient_scope":
    case "invalid_authority":
    case "invalid_request":
    case "owner_mismatch":
      return "run_unavailable";
    default:
      return "run_unavailable";
  }
}

export class OwnerControlPlane extends DurableObject {
  readonly #database: DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
  readonly #composioWebhookIngress: ComposioWebhookIngress;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;
  #migrationReady = false;
  readonly #runAdmissions: RunAdmissions;
  readonly #toolExecutions: ToolExecutions;
  readonly #runtimeToolExecutions: RuntimeToolExecutions;
  readonly #agents: AgentRegistry;
  readonly #agentBlueprints: AgentBlueprints;
  readonly #connections: Connections;
  readonly #agentChannel: AgentChannel;
  readonly #authorityControls: AuthorityControls;
  readonly #agentSchedules: AgentSchedules;
  readonly #agentEventWatches: AgentEventWatches;
  readonly #agentWatches: AgentWatches;
  readonly #fleetConfigurations: FleetConfigurations;
  readonly #aiGatewayUsage: AiGatewayUsage;
  readonly #skills: Skills;
  readonly #briefs: Briefs;
  readonly #workflows: AgentWorkflows;

  constructor(state: DurableObjectState, environment: Cloudflare.Env) {
    super(state, environment);
    this.#objectName = state.id.name;
    this.#storage = state.storage;
    this.#database = drizzle(this.#storage, {
      logger: false,
      schema: controlPlaneSchema,
    });
    const availableCapabilityPrerequisites = availableAgentCapabilityPrerequisites(
      environment.AI_GATEWAY_ID,
      environment.CODE_SANDBOX !== undefined,
      environment.BRAVE_SEARCH_API_KEY !== undefined &&
        environment.BRAVE_SEARCH_API_KEY.trim().length > 0,
    );
    this.#fleetConfigurations = new FleetConfigurations(
      this.#database,
      defaultAgentModelForPrerequisites(availableCapabilityPrerequisites),
    );
    this.#aiGatewayUsage = new AiGatewayUsage(
      this.#database,
      this.#storage,
      environment.AI,
      environment.AI_GATEWAY_ID,
    );
    this.#skills = new Skills(
      this.#database,
      new R2SkillPackageObjectStore(environment.SKILL_PACKAGES),
      this.#objectName,
    );
    this.#briefs = new Briefs(
      this.#database,
      new R2OwnerContentObjectStore(environment.SKILL_PACKAGES),
      this.#objectName,
    );
    this.#runAdmissions = new RunAdmissions(
      this.#objectName,
      this.#database,
      this.#storage,
      () => this.#fleetConfigurations.current(),
      this.#skills,
      this.#briefs,
      availableCapabilityPrerequisites,
    );
    this.#toolExecutions = new ToolExecutions(this.#objectName, this.#database, this.#storage, () =>
      this.#fleetConfigurations.current(),
    );
    this.#runtimeToolExecutions = new RuntimeToolExecutions(
      this.#objectName,
      this.#database,
      this.#storage,
      () => this.#fleetConfigurations.current(),
      environment.CODE_SANDBOX,
    );
    this.#agents = new AgentRegistry(
      this.#database,
      () => this.#fleetConfigurations.currentData(),
      this.#skills,
      availableCapabilityPrerequisites,
    );
    this.#agentBlueprints = new AgentBlueprints(this.#database, this.#agents);
    this.#connections = new Connections(this.#database, this.#storage, () =>
      this.#fleetConfigurations.currentData(),
    );
    this.#authorityControls = new AuthorityControls(this.#database);
    this.#agentSchedules = new AgentSchedules(this.#database, this.#storage, () =>
      this.#fleetConfigurations.currentData(),
    );
    const ingressStub = environment.OWNER_CONTROL_PLANE.getByName(
      COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME,
    );
    this.#agentEventWatches = new AgentEventWatches(
      this.#database,
      this.#storage,
      this.#objectName,
      this.#connections,
      {
        eventCatalog: createComposioEventCatalog({ apiKey: environment.COMPOSIO_API_KEY }),
        triggerInstances: createComposioTriggerInstances({ apiKey: environment.COMPOSIO_API_KEY }),
        webhookIngress: {
          ensure: () => ingressStub.ensureComposioWebhookIngress(),
        },
      },
    );
    this.#composioWebhookIngress = new ComposioWebhookIngress(
      this.#database,
      this.#storage,
      this.#objectName,
      {
        deliver: async (event) => {
          const owner = environment.OWNER_CONTROL_PLANE.getByName(event.ownerKey);
          const delivered = await owner.deliverVerifiedComposioEvent(event);

          if (!delivered) {
            throw new Error("Composio webhook delivery is unavailable.");
          }
        },
        encryptionSecret: environment.BETTER_AUTH_SECRET,
        projectApiKey: environment.COMPOSIO_API_KEY,
        subscriptions: createComposioWebhookSubscriptions({
          apiKey: environment.COMPOSIO_API_KEY,
          publicOrigin: environment.PUBLIC_ORIGIN,
        }),
      },
    );
    this.#agentWatches = new AgentWatches(this.#agentSchedules, this.#agentEventWatches);
    this.#agentChannel = new AgentChannel(
      this.#objectName,
      this.#database,
      environment.CREW_AGENT,
      this.#briefs,
      this.#runAdmissions,
      this.#toolExecutions,
      () => this.#fleetConfigurations.currentData(),
    );
    this.#workflows = new AgentWorkflows(
      this.#objectName,
      this.#database,
      this.#storage,
      environment.CREW_AGENT,
      this.#agentChannel,
      this.#briefs,
      () => this.#fleetConfigurations.current(),
    );
    this.#storage.sql.exec("PRAGMA foreign_keys = ON");
    void this.ctx.blockConcurrencyWhile(async () => {
      this.#migrationReady = await migrateControlPlane(this.#database, this.#storage);
    });
  }

  status(authorityInput: unknown, input: unknown = {}): ControlPlaneStatusResult {
    const request = controlPlaneStatusInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedStatus("invalid_request");
    }

    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedStatus(authorization.code);
    }

    const configuration = this.#fleetConfigurations.current();
    const recentAudit = request.data.includeRecentAudit
      ? this.listAuditEvents(authorization.authority, {
          limit: request.data.auditLimit,
        })
      : null;

    return controlPlaneStatusResultSchema.parse({
      ok: true,
      status: {
        capacity: {
          ...configuration.data.capacity,
          retention: configuration.data.retention,
        },
        configurationRevision: configuration.revision,
        ...(recentAudit?.ok ? { recentAudit: recentAudit.events } : {}),
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        status: "ready",
        usage: {
          agents: this.#agents.usage(),
          connections: this.#connections.usage(),
          diagnostics: {
            expiredApprovals:
              this.#database
                .select({ value: count() })
                .from(toolApprovals)
                .where(
                  and(isNull(toolApprovals.decision), lte(toolApprovals.expiresAt, Date.now())),
                )
                .get()?.value ?? 0,
            pendingAiUsage:
              this.#database
                .select({ value: count() })
                .from(aiGatewayCalls)
                .where(eq(aiGatewayCalls.status, "pending"))
                .get()?.value ?? 0,
          },
          recovery: {
            unresolvedEffects: this.#toolExecutions.unresolvedCount(),
          },
          skills: this.#skills.usage(),
          briefs: this.#briefs.usage(),
          workflows: this.#workflows.usage(),
          ...this.#agentChannel.usage(),
        },
      },
    });
  }

  getFleetConfiguration(authorityInput: unknown, input: unknown): GetFleetConfigurationResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return deniedFleetConfiguration(authorization.code);
    }

    return this.#fleetConfigurations.get(input);
  }

  async configureFleetConfiguration(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ConfigureFleetConfigurationResult> {
    const authorization = this.#authorize(authorityInput, AUTONOMY_WRITE_SCOPE);

    if (!authorization.ok) {
      return deniedFleetConfiguration(authorization.code);
    }

    return this.#fleetConfigurations.configure(authorization.authority, input);
  }

  listSkills(authorityInput: unknown, input: unknown): ListSkillsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok ? this.#skills.list(input) : deniedSkill(authorization.code);
  }

  async getSkill(authorityInput: unknown, input: unknown): Promise<GetSkillResult> {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok ? this.#skills.get(input) : deniedSkill(authorization.code);
  }

  async publishSkill(authorityInput: unknown, input: unknown): Promise<PublishSkillResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    return authorization.ok
      ? this.#skills.publish(authorization.authority, input)
      : deniedSkill(authorization.code);
  }

  async retireSkill(authorityInput: unknown, input: unknown): Promise<RetireSkillResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    return authorization.ok
      ? this.#skills.retire(authorization.authority, input)
      : deniedSkill(authorization.code);
  }

  async createBrief(authorityInput: unknown, input: unknown): Promise<CreateBriefResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);
    return authorization.ok
      ? this.#briefs.create(authorization.authority, input)
      : deniedBrief(authorization.code);
  }

  async reviseBrief(authorityInput: unknown, input: unknown): Promise<ReviseBriefResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);
    return authorization.ok
      ? this.#briefs.revise(authorization.authority, input)
      : deniedBrief(authorization.code);
  }

  listBriefs(authorityInput: unknown, input: unknown): ListBriefsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);
    return authorization.ok ? this.#briefs.list(input) : deniedBrief(authorization.code);
  }

  inspectBrief(authorityInput: unknown, input: unknown): InspectBriefResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);
    return authorization.ok ? this.#briefs.inspect(input) : deniedBrief(authorization.code);
  }

  async readBrief(authorityInput: unknown, input: unknown): Promise<ReadBriefResult> {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);
    return authorization.ok ? this.#briefs.read(input) : deniedBrief(authorization.code);
  }

  async deleteBrief(authorityInput: unknown, input: unknown): Promise<DeleteBriefResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);
    return authorization.ok
      ? this.#briefs.delete(authorization.authority, input)
      : deniedBrief(authorization.code);
  }

  listAgentBlueprints(authorityInput: unknown, input: unknown): ListAgentBlueprintsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok
      ? this.#agentBlueprints.list(input)
      : deniedAgentBlueprint(authorization.code);
  }

  getAgentBlueprint(authorityInput: unknown, input: unknown): GetAgentBlueprintResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok
      ? this.#agentBlueprints.get(input)
      : deniedAgentBlueprint(authorization.code);
  }

  async publishAgentBlueprint(
    authorityInput: unknown,
    input: unknown,
  ): Promise<PublishAgentBlueprintResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentBlueprints.publish(authorization.authority, input)
      : deniedAgentBlueprint(authorization.code);
  }

  async instantiateAgentBlueprint(
    authorityInput: unknown,
    input: unknown,
  ): Promise<InstantiateAgentBlueprintResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentBlueprints.instantiate(authorization.authority, input)
      : deniedAgentBlueprint(authorization.code);
  }

  async retireAgentBlueprint(
    authorityInput: unknown,
    input: unknown,
  ): Promise<RetireAgentBlueprintResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentBlueprints.retire(authorization.authority, input)
      : deniedAgentBlueprint(authorization.code);
  }

  recordAiGatewayCall(input: unknown): Promise<void> {
    return this.#migrationReady ? this.#aiGatewayUsage.record(input) : Promise.resolve();
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
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);

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

  releaseRunBriefContext(input: unknown): Promise<boolean> {
    return this.#migrationReady
      ? this.#runAdmissions.releaseBriefContext(input)
      : Promise.resolve(false);
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
      return Promise.resolve(deniedToolExecutionEvaluation("admission_unavailable"));
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

  reserveRuntimeToolExecution(input: unknown): Promise<ReserveRuntimeToolExecutionResult> {
    return this.#migrationReady
      ? this.#runtimeToolExecutions.reserve(input)
      : Promise.resolve({
          error: { code: "invalid_execution", message: "Runtime tool execution denied." },
          ok: false,
        });
  }

  dispatchRuntimeToolExecution(input: unknown): Promise<DispatchRuntimeToolExecutionResult> {
    return this.#migrationReady
      ? this.#runtimeToolExecutions.dispatch(input)
      : Promise.resolve({
          error: { code: "invalid_execution", message: "Runtime tool execution denied." },
          ok: false,
        });
  }

  completeRuntimeToolExecution(input: unknown): Promise<CompleteRuntimeToolExecutionResult> {
    return this.#migrationReady
      ? this.#runtimeToolExecutions.complete(input)
      : Promise.resolve({
          error: { code: "invalid_execution", message: "Runtime tool execution denied." },
          ok: false,
        });
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

  batchDisableAgents(authorityInput: unknown, input: unknown): BatchDisableAgentsResult {
    const request = batchDisableAgentsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedBatchAgentDisable("invalid_request");
    }

    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#authorityControls.disableAgents(authorization.authority, request.data)
      : deniedBatchAgentDisable(authorization.code);
  }

  reconcileToolExecution(authorityInput: unknown, input: unknown): ReconcileToolExecutionResult {
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);

    return authorization.ok
      ? this.#toolExecutions.reconcile(authorization.authority, input)
      : deniedToolExecutionReconciliation(authorization.code);
  }

  listUnresolvedToolEffects(
    authorityInput: unknown,
    input: unknown,
  ): ListUnresolvedToolEffectsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    return authorization.ok
      ? this.#toolExecutions.listUnresolved(input)
      : deniedUnresolvedToolEffects(authorization.code);
  }

  listAuditEvents(authorityInput: unknown, input: unknown): ListAuditEventsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return {
        error: { code: authorization.code, message: "Audit request denied." },
        ok: false,
      };
    }

    const request = listAuditEventsInputSchema.safeParse(input);

    if (!request.success) {
      return {
        error: { code: "invalid_request", message: "Audit request denied." },
        ok: false,
      };
    }

    const rows = this.#database
      .select()
      .from(auditEvents)
      .where(
        and(
          request.data.action === undefined
            ? undefined
            : eq(auditEvents.action, request.data.action),
          request.data.cursor === undefined
            ? undefined
            : lt(auditEvents.eventId, request.data.cursor),
          request.data.occurredAfter === undefined
            ? undefined
            : gte(auditEvents.occurredAt, Date.parse(request.data.occurredAfter)),
          request.data.subjectId === undefined
            ? undefined
            : eq(auditEvents.subjectId, request.data.subjectId),
        ),
      )
      .orderBy(desc(auditEvents.eventId))
      .limit(request.data.limit + 1)
      .all();
    const hasMore = rows.length > request.data.limit;
    const events = rows.slice(0, request.data.limit).map((event) => ({
      action: event.action,
      actor:
        event.clientId === "crewhelm:scheduler"
          ? ("scheduler" as const)
          : event.clientId.startsWith("crewhelm:")
            ? ("runtime" as const)
            : ("owner_client" as const),
      eventId: event.eventId,
      occurredAt: new Date(event.occurredAt).toISOString(),
      subjectId: event.subjectId,
    }));

    return listAuditEventsResultSchema.parse({
      events,
      nextCursor: hasMore ? (events.at(-1)?.eventId ?? null) : null,
      ok: true,
    });
  }

  redeemRunReceiverCapability(input: unknown): RedeemRunReceiverCapabilityResult {
    return this.#migrationReady ? this.#agentChannel.redeem(input) : INVALID_RUN_ADMISSION;
  }

  async startRun(authorityInput: unknown, input: unknown): Promise<StartRunResult> {
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);
    const request = startRunInputSchema.safeParse(input);

    if (authorization.ok && request.success && request.data.conversation !== undefined) {
      const conversationAuthorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);
      if (!conversationAuthorization.ok) return deniedStartRun(conversationAuthorization.code);
    }

    if (authorization.ok && request.success && (request.data.briefs?.length ?? 0) > 0) {
      const briefAuthorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);
      if (!briefAuthorization.ok) return deniedStartRun(briefAuthorization.code);
    }

    return authorization.ok
      ? this.#agentChannel.start(authorization.authority, input)
      : deniedStartRun(authorization.code);
  }

  async startAgentWorkflow(
    authorityInput: unknown,
    input: unknown,
  ): Promise<StartAgentWorkflowResult> {
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);
    const request = startAgentWorkflowInputSchema.safeParse(input);

    if (authorization.ok && request.success && (request.data.briefs?.length ?? 0) > 0) {
      const briefAuthorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);
      if (!briefAuthorization.ok) {
        return {
          error: { code: briefAuthorization.code, message: "Agent workflow request denied." },
          ok: false,
        };
      }
    }

    return authorization.ok
      ? this.#workflows.start(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Agent workflow request denied." },
          ok: false,
        };
  }

  listAgentWorkflows(authorityInput: unknown, input: unknown): ListAgentWorkflowsResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#workflows.list(input)
      : {
          error: { code: authorization.code, message: "Agent workflow request denied." },
          ok: false,
        };
  }

  inspectAgentWorkflow(
    authorityInput: unknown,
    input: unknown,
  ): Promise<InspectAgentWorkflowResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#workflows.inspect(input)
      : Promise.resolve({
          error: { code: authorization.code, message: "Agent workflow request denied." },
          ok: false,
        });
  }

  async cancelAgentWorkflow(
    authorityInput: unknown,
    input: unknown,
  ): Promise<CancelAgentWorkflowResult> {
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);

    return authorization.ok
      ? this.#workflows.cancel(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Agent workflow request denied." },
          ok: false,
        };
  }

  async deleteAgentWorkflow(
    authorityInput: unknown,
    input: unknown,
  ): Promise<DeleteAgentWorkflowResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#workflows.delete(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Agent workflow request denied." },
          ok: false,
        };
  }

  dispatchAgentWorkflowStage(input: unknown): Promise<DispatchAgentWorkflowStageResult> {
    return this.#migrationReady
      ? this.#workflows.dispatch(input)
      : Promise.resolve({
          error: { code: "incompatible_schema", message: "Agent workflow request denied." },
          ok: false,
        });
  }

  completeAgentWorkflowStage(input: unknown): Promise<CompleteAgentWorkflowStageResult> {
    return this.#migrationReady
      ? this.#workflows.complete(input)
      : Promise.resolve({
          error: { code: "incompatible_schema", message: "Agent workflow request denied." },
          ok: false,
        });
  }

  markAgentWorkflowStageWaiting(input: unknown): boolean {
    return this.#migrationReady && this.#workflows.markWaiting(input);
  }

  verifyAgentWorkflowRuntime(input: unknown): boolean {
    return this.#migrationReady && this.#workflows.verifyRuntime(input);
  }

  async failAgentWorkflowRuntime(input: unknown): Promise<boolean> {
    return this.#migrationReady ? this.#workflows.failRuntime(input) : false;
  }

  async cancelRun(authorityInput: unknown, input: unknown): Promise<CancelRunResult> {
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);

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

  async listAgentRuns(authorityInput: unknown, input: unknown): Promise<ListAgentRunsResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentChannel.listRuns(authorization.authority, input)
      : deniedListAgentRuns(authorization.code);
  }

  async listAgentSessions(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ListAgentSessionsResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentChannel.listSessions(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Session request denied." },
          ok: false,
        };
  }

  async inspectAgentSession(
    authorityInput: unknown,
    input: unknown,
  ): Promise<InspectAgentSessionResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentChannel.inspectSession(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Session request denied." },
          ok: false,
        };
  }

  async deleteAgentSession(
    authorityInput: unknown,
    input: unknown,
  ): Promise<DeleteAgentSessionResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    return authorization.ok
      ? this.#agentChannel.deleteSession(authorization.authority, input)
      : {
          error: { code: authorization.code, message: "Session deletion denied." },
          ok: false,
        };
  }

  async agentInbox(authorityInput: unknown, input: unknown): Promise<AgentInboxResult> {
    const request = agentInboxInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentInbox("invalid_request");
    }

    const requiredScope =
      request.data.action === "acknowledge" ? RUNS_WRITE_SCOPE : AGENTS_READ_SCOPE;
    const authorization = this.#authorize(authorityInput, requiredScope);

    return authorization.ok
      ? this.#agentChannel.inbox(authorization.authority, request.data)
      : deniedAgentInbox(authorization.code);
  }

  recordAgentInboxRun(input: unknown): Promise<RecordAgentInboxRunResult> {
    return this.#migrationReady
      ? this.#agentChannel.recordInboxRun(input)
      : Promise.resolve({
          error: {
            code: "invalid_admission",
            message: "Agent inbox projection denied.",
          },
          ok: false,
        });
  }

  async configureAgentSchedule(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ConfigureAgentScheduleResult> {
    const authorization = this.#authorize(authorityInput, AUTONOMY_WRITE_SCOPE);

    if (!authorization.ok) {
      return deniedAgentSchedule(authorization.code);
    }

    const request = configureAgentScheduleInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentSchedule("invalid_request");
    }

    return this.#agentSchedules.configure(authorization.authority, request.data);
  }

  getAgentSchedule(authorityInput: unknown, input: unknown): GetAgentScheduleResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentSchedules.get(input)
      : deniedAgentSchedule(authorization.code);
  }

  listAgentSchedules(authorityInput: unknown, input: unknown): ListAgentSchedulesResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    return authorization.ok
      ? this.#agentSchedules.list(input)
      : deniedAgentSchedule(authorization.code);
  }

  async agentWatches(authorityInput: unknown, input: unknown): Promise<AgentWatchesRpcResult> {
    const request = agentWatchesInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentWatch("invalid_request");
    }

    const requiredScope = ["create", "update", "pause", "resume", "delete"].includes(
      request.data.action,
    )
      ? AUTONOMY_WRITE_SCOPE
      : request.data.action === "sources"
        ? OWNER_READ_SCOPE
        : AGENTS_READ_SCOPE;
    const authorization = this.#authorize(authorityInput, requiredScope);

    if (
      authorization.ok &&
      ((request.data.action === "sources" && request.data.connectionId !== undefined) ||
        ((request.data.action === "create" || request.data.action === "update") &&
          request.data.watch.source.kind === "connection_event") ||
        ("watchId" in request.data && request.data.watchId.startsWith("watch_"))) &&
      !authorization.authority.scopes.includes(CONNECTIONS_READ_SCOPE)
    ) {
      return deniedAgentWatch("insufficient_scope");
    }

    return authorization.ok
      ? this.#agentWatches.execute(authorization.authority, request.data)
      : deniedAgentWatch(authorization.code);
  }

  async ensureComposioWebhookIngress(): Promise<boolean> {
    return this.#composioWebhookIngress.ensure();
  }

  async receiveComposioWebhook(input: unknown): Promise<ComposioWebhookIngressResult> {
    const body = typeof input === "object" && input !== null ? Reflect.get(input, "body") : null;
    const headers =
      typeof input === "object" && input !== null ? Reflect.get(input, "headers") : null;
    const id = typeof headers === "object" && headers !== null ? Reflect.get(headers, "id") : null;
    const signature =
      typeof headers === "object" && headers !== null ? Reflect.get(headers, "signature") : null;
    const timestamp =
      typeof headers === "object" && headers !== null ? Reflect.get(headers, "timestamp") : null;

    if (
      !(body instanceof Uint8Array) ||
      body.byteLength > 256 * 1_024 ||
      typeof id !== "string" ||
      typeof signature !== "string" ||
      typeof timestamp !== "string"
    ) {
      return { error: "invalid_webhook", ok: false };
    }

    return this.#composioWebhookIngress.receive({
      body,
      headers: { id, signature, timestamp },
    });
  }

  async deliverVerifiedComposioEvent(input: unknown): Promise<boolean> {
    const event = verifiedComposioTriggerEventSchema.safeParse(input);

    if (!event.success || event.data.ownerKey !== this.#objectName) {
      return false;
    }

    await this.#agentEventWatches.receive(event.data, Date.now());
    return true;
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
    const authorization = this.#authorize(authorityInput, RUNS_WRITE_SCOPE);

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
    await this.#aiGatewayUsage.reconcilePending(currentTime);
    const expiredExecutionRuns = this.#toolExecutions.reconcileExpired(currentTime);
    const expiredRuntimeToolRuns = this.#runtimeToolExecutions.reconcileExpired(currentTime);
    await this.#runtimeToolExecutions.reconcileCleanup(currentTime);

    for (const runId of [...expiredExecutionRuns, ...expiredRuntimeToolRuns]) {
      this.#agentChannel.repairFailedRun(runId);
    }
    this.#runAdmissions.cleanup(currentTime);
    await this.#workflows.cleanup(currentTime);
    await this.#workflows.recoverQueued();
    await this.#workflows.recoverCancelling();
    await this.#workflows.recoverActive();
    await this.#agentEventWatches.recoverOne();
    const dueSchedules = this.#agentSchedules.claimDue(currentTime);
    const dispatches = await Promise.allSettled(
      dueSchedules.map((schedule) => this.#dispatchScheduledRun(schedule, currentTime)),
    );

    for (const [index, dispatch] of dispatches.entries()) {
      const schedule = dueSchedules[index];

      if (dispatch.status === "rejected" && schedule !== undefined) {
        this.#agentSchedules.recordPendingRetry(schedule, currentTime, "dispatch_exception");
        this.#recordScheduledDeferral(
          { ...schedule, retryAt: currentTime + 60_000 },
          currentTime,
          "dispatch_exception",
        );
        recordScheduleEvent({
          agentId: schedule.agentId,
          outcome: "failed",
          reason: "dispatch_exception",
        });
      }
    }

    const dueEvents = this.#agentEventWatches.claimDue(currentTime);
    const eventDispatches = await Promise.allSettled(
      dueEvents.map((watch) => this.#dispatchEventWatchRun(watch, currentTime)),
    );

    for (const [index, dispatch] of eventDispatches.entries()) {
      const watch = dueEvents[index];

      if (dispatch.status === "rejected" && watch !== undefined) {
        this.#agentEventWatches.recordRetry(watch, currentTime);
      }
    }

    const nextConnectionCleanup = this.#connections.cleanup(currentTime);
    const nextRunCleanup = this.#runAdmissions.nextCleanupAt();
    const nextScheduledRun = this.#agentSchedules.nextAlarmAt();
    const nextEventWatch = this.#agentEventWatches.nextAlarmAt();
    const nextToolReconciliation = this.#toolExecutions.nextReconciliationAt();
    const nextRuntimeToolReconciliation = this.#runtimeToolExecutions.nextReconciliationAt();
    const nextWorkflowAction = this.#workflows.nextAlarmAt();
    const nextAiUsageReconciliation = this.#aiGatewayUsage.nextReconciliationAt();
    const nextAlarm =
      [
        nextAiUsageReconciliation,
        nextConnectionCleanup,
        nextEventWatch,
        nextRunCleanup,
        nextRuntimeToolReconciliation,
        nextScheduledRun,
        nextToolReconciliation,
        nextWorkflowAction,
      ]
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

    const request = completeAgentConnectionConfigurationInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionAttachment("invalid_request");
    }

    if (
      request.data.tools.some(({ authorization: mode }) => mode === "standing") &&
      !authorization.authority.scopes.includes(AUTONOMY_WRITE_SCOPE)
    ) {
      return deniedConnectionAttachment("insufficient_scope");
    }

    return this.#agents.configureConnection(authorization.authority, request.data);
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

  async #dispatchScheduledRun(schedule: DueAgentSchedule, currentTime: number): Promise<void> {
    if (this.#objectName === undefined) {
      return;
    }

    const authority: OwnerAuthority = {
      clientId: "crewhelm:scheduler",
      ownerKey: this.#objectName,
      scopes: [AGENTS_READ_SCOPE, RUNS_WRITE_SCOPE],
    };

    if (schedule.lastRunId !== null) {
      const previous = await this.#agentChannel.inspect(authority, {
        runId: schedule.lastRunId,
      });

      if (!previous.ok) {
        if (previous.error.code === "run_not_found") {
          // Completed run admissions eventually age out of the control plane.
        } else {
          this.#agentSchedules.recordSkipped(schedule, currentTime, "run_unavailable");
          this.#recordScheduledDeferral(schedule, currentTime, "run_unavailable");
          recordScheduleEvent({
            agentId: schedule.agentId,
            outcome: "skipped_unavailable",
          });
          return;
        }
      } else if (!["cancelled", "completed", "failed"].includes(previous.run.status)) {
        this.#agentSchedules.recordSkipped(schedule, currentTime, "active_run");
        this.#recordScheduledDeferral(schedule, currentTime, "active_run");
        recordScheduleEvent({
          agentId: schedule.agentId,
          outcome: "skipped_active",
        });
        return;
      }
    }

    const started = await this.#agentChannel.start(
      authority,
      {
        agentId: schedule.agentId,
        expectedRevision: schedule.agentRevision,
        idempotencyKey: `schedule.${schedule.scheduleId}.${schedule.scheduleRevision}.${schedule.scheduledAt}`,
        ...(schedule.outputContract === undefined
          ? {}
          : { outputContract: schedule.outputContract }),
        prompt: schedule.prompt,
      },
      "schedule",
      schedule.scheduleRevision,
    );

    if (!started.ok) {
      this.#agentSchedules.recordSkipped(schedule, currentTime, "agent_unavailable");
      this.#recordScheduledDeferral(
        schedule,
        currentTime,
        scheduledRunFailureReason(started.error.code),
      );
      recordScheduleEvent({
        agentId: schedule.agentId,
        outcome: "failed",
        reason: started.error.code,
      });
      return;
    }

    const recorded = this.#agentSchedules.recordDispatch({
      dispatchedAt: Date.now(),
      runId: started.run.runId,
      scheduleId: schedule.scheduleId,
      scheduleRevision: schedule.scheduleRevision,
      scheduledAt: schedule.scheduledAt,
    });

    if (!recorded) {
      await this.#agentChannel.cancel(authority, { runId: started.run.runId });
      this.#agentSchedules.recordSkipped(schedule, currentTime, "record_dispatch_conflict");
      this.#recordScheduledDeferral(schedule, currentTime, "record_dispatch_conflict");
      recordScheduleEvent({
        agentId: schedule.agentId,
        outcome: "failed",
        reason: "record_dispatch_conflict",
      });
      return;
    }

    this.#agentChannel.clearScheduledDeferral(schedule.scheduleId);
    recordScheduleEvent({
      agentId: schedule.agentId,
      outcome: "dispatched",
      runId: started.run.runId,
    });
  }

  async #dispatchEventWatchRun(watch: DueAgentEventWatch, currentTime: number): Promise<void> {
    if (this.#objectName === undefined) {
      return;
    }

    const authority: OwnerAuthority = {
      clientId: "crewhelm:watcher",
      ownerKey: this.#objectName,
      scopes: [AGENTS_READ_SCOPE, RUNS_WRITE_SCOPE],
    };

    if (watch.lastRunId !== null) {
      const previous = await this.#agentChannel.inspect(authority, { runId: watch.lastRunId });

      if (previous.ok && !["cancelled", "completed", "failed"].includes(previous.run.status)) {
        this.#agentEventWatches.recordRetry(watch, currentTime);
        return;
      }

      if (!previous.ok && previous.error.code !== "run_not_found") {
        this.#agentEventWatches.recordRetry(watch, currentTime);
        return;
      }
    }

    const prompt = eventWatchPrompt(watch);

    if (prompt === null) {
      this.#agentEventWatches.recordSkipped(watch, currentTime, "event_too_large");
      return;
    }

    const started = await this.#agentChannel.start(
      authority,
      {
        agentId: watch.agentId,
        expectedRevision: watch.agentRevision,
        idempotencyKey: await eventWatchIdempotencyKey(watch),
        ...(watch.outputContract === undefined ? {} : { outputContract: watch.outputContract }),
        prompt,
      },
      "watch",
      null,
      null,
      {
        eventId: watch.eventId,
        id: watch.watchId,
        revision: watch.watchRevision,
        sourceKind: "connection_event",
      },
    );

    if (!started.ok) {
      this.#agentEventWatches.recordSkipped(
        watch,
        currentTime,
        started.error.code === "revision_conflict" ? "agent_changed" : "agent_unavailable",
      );
      return;
    }

    const recorded = this.#agentEventWatches.recordDispatch({
      dispatchedAt: Date.now(),
      eventId: watch.eventId,
      runId: started.run.runId,
      watchId: watch.watchId,
      watchRevision: watch.watchRevision,
    });
    if (!recorded) {
      await this.#agentChannel.cancel(authority, { runId: started.run.runId });
      this.#agentEventWatches.recordSkipped(watch, currentTime, "record_dispatch_conflict");
    }
  }

  #recordScheduledDeferral(
    schedule: DueAgentSchedule,
    occurredAt: number,
    reason: AgentInboxDeferredReason,
  ): void {
    this.#agentChannel.recordScheduledDeferral({
      agentId: schedule.agentId,
      agentRevision: schedule.agentRevision,
      fleetRevision: this.#fleetConfigurations.current().revision,
      occurredAt,
      prompt: schedule.prompt,
      reason,
      retryAt: schedule.retryAt,
      scheduleId: schedule.scheduleId,
      scheduleRevision: schedule.scheduleRevision,
      scheduledAt: schedule.scheduledAt,
    });
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

  #deniedStatus(code: AuthorityErrorCode | "invalid_request"): ControlPlaneStatusResult {
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
