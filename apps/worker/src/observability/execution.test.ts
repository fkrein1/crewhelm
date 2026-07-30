import { afterEach, describe, expect, it, vi } from "vitest";

import { recordExecutionEvent, recordExecutionProviderResponse } from "./execution.js";

const runId = "run_00000000-0000-4000-8000-000000000001";
const toolCallId = "tool_call_00000000-0000-4000-8000-000000000002";
const agentId = "agent_00000000-0000-4000-8000-000000000003";
const connectionId = "connection_00000000-0000-4000-8000-000000000004";
const grantId = "grant_00000000-0000-4000-8000-000000000005";

describe("execution observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only the allowlisted execution fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordExecutionEvent({
      outcome: "completed",
      outputBytes: 42,
      phase: "tool.completion",
      runId,
      toolCallId,
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.execution",
      outcome: "completed",
      outputBytes: 42,
      parentSpanId: runId,
      phase: "tool.completion",
      runId,
      spanId: toolCallId,
      toolCallId,
      traceId: runId,
    });
  });

  it("rejects extra fields without reflecting their values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = "provider-secret-that-must-not-be-logged";

    recordExecutionEvent({
      outcome: "completed",
      outputBytes: 42,
      phase: "tool.completion",
      runId,
      secret,
      toolCallId,
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.execution.telemetry_rejected",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it("emits bounded provider diagnostics with run and tool correlation", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordExecutionProviderResponse({
      durationMs: 157,
      operation: "execute",
      outcome: "provider_rejected",
      providerErrorCode: 4001,
      runId,
      status: 403,
      toolCallId,
      toolSlug: "DISCORD_GET_MY_USER",
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.execution.provider_response",
      durationMs: 157,
      operation: "execute",
      outcome: "provider_rejected",
      parentSpanId: runId,
      providerErrorCode: 4001,
      runId,
      spanId: toolCallId,
      status: 403,
      toolCallId,
      toolSlug: "DISCORD_GET_MY_USER",
      traceId: runId,
    });
  });

  it("records a safe authorization root cause as a correlated tool span", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordExecutionEvent({
      agentId,
      agentRevision: 2,
      authorization: "standing",
      checkpoint: "pre_execution",
      connectionId,
      durationMs: 12,
      effect: "write",
      grantId,
      integrationSlug: "todoist",
      outcome: "blocked",
      phase: "tool.authorization",
      reason: "budget_exhausted",
      runId,
      toolCallId,
      toolSlug: "TODOIST_CREATE_TASK",
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      agentId,
      agentRevision: 2,
      authorization: "standing",
      checkpoint: "pre_execution",
      connectionId,
      durationMs: 12,
      effect: "write",
      event: "crewhelm.execution",
      grantId,
      integrationSlug: "todoist",
      outcome: "blocked",
      parentSpanId: runId,
      phase: "tool.authorization",
      reason: "budget_exhausted",
      runId,
      spanId: toolCallId,
      toolCallId,
      toolSlug: "TODOIST_CREATE_TASK",
      traceId: runId,
    });
  });
});
