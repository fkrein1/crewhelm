import {
  composioToolGateInputSchema,
  toolGateDecisionSchema,
  type ClassifiedComposioToolAction,
  type ComposioToolCapabilityGrant,
  type ToolGateDecision,
  type ToolGatePolicySnapshot,
} from "@crewhelm/contracts";

export { COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID } from "@crewhelm/contracts";

const LOCAL_DECISION_TTL_MS = 30 * 1_000;
const MAXIMUM_POLICY_SNAPSHOT_AGE_MS = 5 * 1_000;

function deny(reason: Extract<ToolGateDecision, { decision: "deny" }>["reason"]): ToolGateDecision {
  return { decision: "deny", reason };
}

function hasMatchingBinding(
  action: ClassifiedComposioToolAction,
  grant: ComposioToolCapabilityGrant,
): boolean {
  return (
    action.ownerKey === grant.ownerKey &&
    action.agentId === grant.agentId &&
    action.agentRevision === grant.agentRevision &&
    action.capabilityId === grant.capabilityId &&
    action.grantId === grant.grantId &&
    action.connectionId === grant.connectionId &&
    action.integrationSlug === grant.integrationSlug &&
    action.toolSlug === grant.toolSlug &&
    action.toolkitVersion === grant.toolkitVersion &&
    action.effect === grant.effect &&
    action.targetDigests.every((digest) => grant.targetDigests.includes(digest))
  );
}

function hasMatchingPolicySnapshot(
  action: ClassifiedComposioToolAction,
  grant: ComposioToolCapabilityGrant,
  policy: ToolGatePolicySnapshot,
): boolean {
  return (
    policy.ownerKey === action.ownerKey &&
    policy.ownerKey === grant.ownerKey &&
    policy.agentId === action.agentId &&
    policy.agentId === grant.agentId &&
    policy.currentAgentRevision === action.agentRevision &&
    policy.currentAgentRevision === grant.agentRevision &&
    policy.capabilityId === action.capabilityId &&
    policy.capabilityId === grant.capabilityId &&
    policy.grantId === action.grantId &&
    policy.grantId === grant.grantId &&
    policy.connectionId === action.connectionId &&
    policy.connectionId === grant.connectionId &&
    policy.runId === action.runId
  );
}

async function digestAction(action: ClassifiedComposioToolAction): Promise<string> {
  const canonicalAction = JSON.stringify({
    schemaVersion: 1,
    capabilityId: action.capabilityId,
    grantId: action.grantId,
    ownerKey: action.ownerKey,
    agentId: action.agentId,
    agentRevision: action.agentRevision,
    runId: action.runId,
    toolCallId: action.toolCallId,
    connectionId: action.connectionId,
    integrationSlug: action.integrationSlug,
    toolSlug: action.toolSlug,
    toolkitVersion: action.toolkitVersion,
    effect: action.effect,
    targetDigests: action.targetDigests,
    inputDigest: action.inputDigest,
    estimatedCostMicrousd: action.estimatedCostMicrousd,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalAction));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evaluateComposioToolAction(input: unknown): Promise<ToolGateDecision> {
  const request = composioToolGateInputSchema.safeParse(input);

  if (!request.success) {
    return deny("invalid_request");
  }

  const { action, grant, policy } = request.data;
  const currentTime = Date.now();
  const evaluatedAt = Date.parse(policy.evaluatedAt);

  if (!hasMatchingBinding(action, grant)) {
    return deny("grant_mismatch");
  }

  if (!hasMatchingPolicySnapshot(action, grant, policy)) {
    return deny("policy_mismatch");
  }

  if (evaluatedAt > currentTime || currentTime - evaluatedAt > MAXIMUM_POLICY_SNAPSHOT_AGE_MS) {
    return deny("policy_stale");
  }

  if (
    policy.killSwitchActive ||
    policy.agentStatus !== "active" ||
    policy.grantStatus !== "active" ||
    policy.connectionStatus !== "active"
  ) {
    return deny("policy_inactive");
  }

  const grantExpiresAt = grant.expiresAt === null ? null : Date.parse(grant.expiresAt);

  if (grantExpiresAt !== null && grantExpiresAt <= currentTime) {
    return deny("grant_expired");
  }

  if (action.estimatedCostMicrousd === null) {
    return deny("unknown_cost");
  }

  if (policy.activeGrantCalls >= grant.limits.maxConcurrency) {
    return deny("concurrency_exhausted");
  }

  if (
    policy.remainingToolCalls === 0 ||
    policy.grantCallsUsed >= grant.limits.maxCallsPerRun ||
    policy.remainingDurationMs === 0 ||
    policy.remainingOutputBytes === 0 ||
    action.estimatedCostMicrousd > policy.remainingCostMicrousd ||
    action.estimatedCostMicrousd > grant.limits.maxCostMicrousdPerCall
  ) {
    return deny("budget_exhausted");
  }

  if (action.effect !== "read") {
    const actionDigest = await digestAction(action);

    return toolGateDecisionSchema.parse({
      actionDigest,
      decision: "requires_approval",
      effect: action.effect,
      grantId: action.grantId,
    });
  }

  const localDecisionExpiresAt = Math.min(
    currentTime + LOCAL_DECISION_TTL_MS,
    evaluatedAt + LOCAL_DECISION_TTL_MS,
  );
  const expiresAt =
    grantExpiresAt === null
      ? localDecisionExpiresAt
      : Math.min(localDecisionExpiresAt, grantExpiresAt);

  return toolGateDecisionSchema.parse({
    action,
    actionDigest: await digestAction(action),
    constraints: {
      decisionExpiresAt: new Date(expiresAt).toISOString(),
      maxCostMicrousd: action.estimatedCostMicrousd,
      maxDurationMs: Math.min(grant.limits.maxDurationMs, policy.remainingDurationMs),
      maxOutputBytes: Math.min(grant.limits.maxOutputBytes, policy.remainingOutputBytes),
    },
    decision: "allow",
  });
}
