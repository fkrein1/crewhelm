import { describe, expect, it } from "vitest";

import { MAXIMUM_FLEET_LIST_ITEMS, MAXIMUM_FLEET_LIST_RESPONSE_BYTES } from "./fleet-capacity.js";
import { listAgentRevisionsResultSchema, listAgentsResultSchema } from "./control-plane.js";
import { MAXIMUM_CONNECTION_LIST_ITEMS, listConnectionsResultSchema } from "./connections.js";
import {
  MAXIMUM_UNRESOLVED_TOOL_EFFECTS_RESPONSE_BYTES,
  listUnresolvedToolEffectsResultSchema,
} from "./recovery.js";
import { listAgentRunsInputSchema, listAgentRunsResultSchema } from "./run-admission.js";

const timestamp = "9999-12-31T23:59:59.999Z";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("fleet read response budgets", () => {
  it("compares run time filters chronologically across ISO precision variants", () => {
    expect(
      listAgentRunsInputSchema.safeParse({
        createdAfter: "2026-07-29T12:00:00.1Z",
        createdBefore: "2026-07-29T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("bounds worst-case compact Agent and revision pages", () => {
    const agents = Array.from({ length: MAXIMUM_FLEET_LIST_ITEMS }, (_, index) => ({
      createdAt: timestamp,
      id: `agent_${uuid(index)}`,
      model: `${"p".repeat(78)}/${"m".repeat(81)}`,
      name: "N".repeat(80),
      revision: Number.MAX_SAFE_INTEGER,
      status: "disabled" as const,
    }));
    const revisions = agents.map(({ id, model, name, revision }) => ({
      id,
      model,
      name,
      revisedAt: timestamp,
      revision,
    }));

    expect(
      serializedBytes(
        listAgentsResultSchema.parse({
          agents,
          nextCursor: agents.at(-1)?.id ?? null,
          ok: true,
        }),
      ),
    ).toBeLessThanOrEqual(MAXIMUM_FLEET_LIST_RESPONSE_BYTES);
    expect(
      serializedBytes(
        listAgentRevisionsResultSchema.parse({
          nextCursor: Number.MAX_SAFE_INTEGER,
          ok: true,
          revisions,
        }),
      ),
    ).toBeLessThanOrEqual(MAXIMUM_FLEET_LIST_RESPONSE_BYTES);
  });

  it("bounds worst-case compact connection and run pages", () => {
    const connections = Array.from({ length: MAXIMUM_CONNECTION_LIST_ITEMS }, (_, index) => ({
      accountLabel: "L".repeat(160),
      authorizationOutcome: "untracked" as const,
      authConfigId: `ac_${"a".repeat(124)}`,
      connectionId: `connection_${uuid(index)}`,
      createdAt: timestamp,
      integrationSlug: `i${"n".repeat(127)}`,
      providerConnectionId: `ca_${"p".repeat(124)}`,
      status: "unavailable" as const,
    }));
    const runs = Array.from({ length: MAXIMUM_FLEET_LIST_ITEMS }, (_, index) => ({
      agentId: `agent_${uuid(index)}`,
      agentRevision: Number.MAX_SAFE_INTEGER,
      completedAt: timestamp,
      createdAt: timestamp,
      runId: `run_${uuid(index)}`,
      startedAt: timestamp,
      status: "completed" as const,
      trigger: "schedule" as const,
    }));

    expect(
      serializedBytes(
        listConnectionsResultSchema.parse({
          connections,
          nextCursor: connections.at(-1)?.connectionId ?? null,
          ok: true,
        }),
      ),
    ).toBeLessThanOrEqual(MAXIMUM_FLEET_LIST_RESPONSE_BYTES);
    expect(
      serializedBytes(
        listAgentRunsResultSchema.parse({
          nextCursor: runs.at(-1)?.runId ?? null,
          ok: true,
          runs,
        }),
      ),
    ).toBeLessThanOrEqual(MAXIMUM_FLEET_LIST_RESPONSE_BYTES);
  });

  it("bounds worst-case unresolved provider-effect pages", () => {
    const effects = Array.from({ length: MAXIMUM_FLEET_LIST_ITEMS }, (_, index) => ({
      agentId: `agent_${uuid(index)}`,
      agentRevision: Number.MAX_SAFE_INTEGER,
      authorization: "standing" as const,
      connectionId: `connection_${uuid(index)}`,
      dispatchedAt: timestamp,
      effect: "destructive" as const,
      integrationSlug: `i${"n".repeat(127)}`,
      legacyWildcard: true,
      recordedAt: timestamp,
      runId: `run_${uuid(index)}`,
      toolCallId: `tool_call_${uuid(index)}`,
      toolkitVersion: "99991231_99",
      toolSlug: `T${"O".repeat(255)}`,
    }));

    expect(
      serializedBytes(
        listUnresolvedToolEffectsResultSchema.parse({
          effects,
          nextCursor: effects.at(-1)?.toolCallId ?? null,
          ok: true,
          total: effects.length,
        }),
      ),
    ).toBeLessThanOrEqual(MAXIMUM_UNRESOLVED_TOOL_EFFECTS_RESPONSE_BYTES);
  });
});
