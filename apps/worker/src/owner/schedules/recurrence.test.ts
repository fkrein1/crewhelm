import { describe, expect, it } from "vitest";

import {
  minimumAgentScheduleIntervalSeconds,
  nextAgentScheduleOccurrence,
  nextAgentScheduleOccurrenceAfterClaim,
} from "./recurrence.js";

describe("Agent schedule recurrence", () => {
  it("retains fixed elapsed-time interval behavior", () => {
    const after = Date.parse("2026-08-01T10:00:00.000Z");

    expect(
      nextAgentScheduleOccurrence(
        { prompt: "Run on an interval.", trigger: { intervalSeconds: 3_600, type: "interval" } },
        after,
      ),
    ).toBe(Date.parse("2026-08-01T11:00:00.000Z"));
    expect(
      nextAgentScheduleOccurrenceAfterClaim(
        { prompt: "Run on an interval.", trigger: { intervalSeconds: 60, type: "interval" } },
        Date.parse("2026-08-01T10:00:00.000Z"),
        Date.parse("2026-08-01T10:01:10.000Z"),
      ),
    ).toBe(Date.parse("2026-08-01T10:02:00.000Z"));
  });

  it("selects the next daily local occurrence before and after its wall-clock time", () => {
    const configuration = {
      prompt: "Prepare the morning brief.",
      trigger: {
        at: "07:00",
        frequency: "daily" as const,
        timeZone: "America/Sao_Paulo",
        type: "calendar" as const,
      },
    };

    expect(nextAgentScheduleOccurrence(configuration, Date.parse("2026-08-01T09:30:00Z"))).toBe(
      Date.parse("2026-08-01T10:00:00Z"),
    );
    expect(nextAgentScheduleOccurrence(configuration, Date.parse("2026-08-01T10:30:00Z"))).toBe(
      Date.parse("2026-08-02T10:00:00Z"),
    );
  });

  it("preserves daily local time across daylight-saving changes", () => {
    const configuration = {
      prompt: "Prepare the morning brief.",
      trigger: {
        at: "07:00",
        frequency: "daily" as const,
        timeZone: "America/New_York",
        type: "calendar" as const,
      },
    };
    const first = nextAgentScheduleOccurrence(configuration, Date.parse("2026-03-07T12:01:00Z"));
    const second = first === null ? null : nextAgentScheduleOccurrence(configuration, first);

    expect(first).toBe(Date.parse("2026-03-08T11:00:00Z"));
    expect(second).toBe(Date.parse("2026-03-09T11:00:00Z"));
    expect(
      minimumAgentScheduleIntervalSeconds(configuration, Date.parse("2026-01-01T00:00:00Z")),
    ).toBe(23 * 60 * 60);
  });

  it("uses ordered weekdays and skips missing monthly dates", () => {
    expect(
      nextAgentScheduleOccurrence(
        {
          prompt: "Run on selected weekdays.",
          trigger: {
            at: "09:00",
            daysOfWeek: ["monday", "friday"],
            frequency: "weekly",
            timeZone: "UTC",
            type: "calendar",
          },
        },
        Date.parse("2026-08-01T00:00:00Z"),
      ),
    ).toBe(Date.parse("2026-08-03T09:00:00Z"));
    expect(
      nextAgentScheduleOccurrence(
        {
          prompt: "Run at month end.",
          trigger: {
            at: "09:00",
            dayOfMonth: 31,
            frequency: "monthly",
            timeZone: "UTC",
            type: "calendar",
          },
        },
        Date.parse("2026-02-01T00:00:00Z"),
      ),
    ).toBe(Date.parse("2026-03-31T09:00:00Z"));
  });

  it("rejects invalid zones and skips nonexistent local times", () => {
    expect(
      nextAgentScheduleOccurrence(
        {
          prompt: "Invalid zone.",
          trigger: {
            at: "07:00",
            frequency: "daily",
            timeZone: "Example/Nowhere",
            type: "calendar",
          },
        },
        Date.parse("2026-08-01T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      nextAgentScheduleOccurrence(
        {
          prompt: "Skip the missing spring-forward time.",
          trigger: {
            at: "02:30",
            frequency: "daily",
            timeZone: "America/New_York",
            type: "calendar",
          },
        },
        Date.parse("2026-03-08T00:00:00Z"),
      ),
    ).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });
});
