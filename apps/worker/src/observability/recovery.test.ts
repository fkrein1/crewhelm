import { afterEach, describe, expect, it, vi } from "vitest";

import { recordRecoveryEvent } from "./recovery.js";

describe("recovery observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only the allowlisted recovery fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordRecoveryEvent({
      operation: "tool.reconcile",
      outcome: "changed",
      resolution: "not_applied",
      runId: "run_00000000-0000-4000-8000-000000000001",
      toolCallId: "tool_call_00000000-0000-4000-8000-000000000002",
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.recovery",
      operation: "tool.reconcile",
      outcome: "changed",
      resolution: "not_applied",
      runId: "run_00000000-0000-4000-8000-000000000001",
      toolCallId: "tool_call_00000000-0000-4000-8000-000000000002",
    });
  });

  it("rejects extra fields without reflecting their values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = "provider-secret-that-must-not-be-logged";

    recordRecoveryEvent({
      agentId: "agent_00000000-0000-4000-8000-000000000001",
      operation: "agent.disable",
      outcome: "changed",
      secret,
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.recovery.telemetry_rejected",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it("does not mask recovery when unknown input cannot be inspected", () => {
    const hostileInput = new Proxy(
      {},
      {
        get() {
          throw new Error("Untrusted recovery input.");
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => recordRecoveryEvent(hostileInput)).not.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "crewhelm.recovery.telemetry_rejected" });
  });
});
