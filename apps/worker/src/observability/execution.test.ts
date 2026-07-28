import { afterEach, describe, expect, it, vi } from "vitest";

import { recordExecutionEvent } from "./execution.js";

const runId = "run_00000000-0000-4000-8000-000000000001";
const toolCallId = "tool_call_00000000-0000-4000-8000-000000000002";

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
      phase: "tool.completion",
      runId,
      toolCallId,
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
});
