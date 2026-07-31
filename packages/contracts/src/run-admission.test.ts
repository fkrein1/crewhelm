import { describe, expect, it } from "vitest";

import { MAXIMUM_RUN_TIMELINE_EVENTS } from "./run-admission.js";

describe("run timeline budget", () => {
  it("retains the legal worst-case run envelope", () => {
    const runStateEvents = 4;
    const inferenceEvents = 100;
    const toolCalls = 100;
    const eventsPerToolCall = 9;

    expect(MAXIMUM_RUN_TIMELINE_EVENTS).toBeGreaterThanOrEqual(
      runStateEvents + inferenceEvents + toolCalls * eventsPerToolCall,
    );
  });
});
