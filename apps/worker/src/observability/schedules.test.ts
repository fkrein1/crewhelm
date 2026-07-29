import { afterEach, describe, expect, it, vi } from "vitest";

import { recordScheduleEvent } from "./schedules.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";

describe("schedule observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the bounded scheduler failure reason", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    recordScheduleEvent({
      agentId,
      outcome: "failed",
      reason: "budget_exhausted",
    });

    expect(info).toHaveBeenCalledExactlyOnceWith({
      agentId,
      event: "crewhelm.schedule",
      outcome: "failed",
      reason: "budget_exhausted",
    });
  });

  it("rejects unbounded failure details", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    recordScheduleEvent({
      agentId,
      outcome: "failed",
      reason: "provider response contained user data",
    });

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "crewhelm.schedule.telemetry_rejected",
    });
  });
});
