import { describe, expect, it } from "vitest";

import { MAXIMUM_FLEET_LIST_ITEMS, MAXIMUM_FLEET_LIST_RESPONSE_BYTES } from "./fleet-capacity.js";
import { listAgentRevisionsResultSchema, listAgentsResultSchema } from "./control-plane.js";
import { listConnectionsResultSchema } from "./connections.js";
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
      model: "m".repeat(160),
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
    const connections = Array.from({ length: MAXIMUM_FLEET_LIST_ITEMS }, (_, index) => ({
      authorizationOutcome: "untracked" as const,
      authConfigId: `ac_${"a".repeat(124)}`,
      connectionId: `connection_${uuid(index)}`,
      createdAt: timestamp,
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
});
