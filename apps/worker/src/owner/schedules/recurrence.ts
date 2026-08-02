import type { AgentScheduleConfiguration, AgentScheduleTrigger } from "@crewhelm/contracts";

const CALENDAR_SEARCH_DAYS = 370;
const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

type CalendarTrigger = Extract<AgentScheduleTrigger, { type: "calendar" }>;
type LocalDateTime = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
};

function triggerFor(configuration: AgentScheduleConfiguration): AgentScheduleTrigger {
  return "intervalSeconds" in configuration
    ? { intervalSeconds: configuration.intervalSeconds, type: "interval" }
    : configuration.trigger;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    });
  } catch {
    return null;
  }
}

function localDateTime(formatter: Intl.DateTimeFormat, instant: number): LocalDateTime | null {
  const values = new Map(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const month = values.get("month");
  const year = values.get("year");

  if (
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    month === undefined ||
    year === undefined ||
    ![day, hour, minute, month, year].every((value) => Number.isInteger(value))
  ) {
    return null;
  }

  return { day, hour, minute, month, year };
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function unsupportedCalendarFrequency(frequency: never): never {
  throw new TypeError(`Unsupported calendar frequency: ${String(frequency)}`);
}

function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number | null {
  const local = localDateTime(formatter, instant);

  return local === null
    ? null
    : Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
        Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

function firstInstantForLocalDateTime(
  formatter: Intl.DateTimeFormat,
  local: LocalDateTime,
): number | null {
  const approximate = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set(
    [approximate - 36 * HOUR_MS, approximate, approximate + 36 * HOUR_MS]
      .map((instant) => offsetAt(formatter, instant))
      .filter((offset): offset is number => offset !== null),
  );
  const matches = [...offsets]
    .map((offset) => approximate - offset)
    .filter((instant) => {
      const represented = localDateTime(formatter, instant);
      return represented !== null && sameLocalDateTime(represented, local);
    })
    .toSorted((left, right) => left - right);

  // Ambiguous fall-back times execute once at the first matching instant.
  return matches[0] ?? null;
}

function matchesCalendarDate(trigger: CalendarTrigger, date: Date): boolean {
  const { frequency } = trigger;

  switch (frequency) {
    case "daily":
      return true;
    case "weekly":
      return trigger.daysOfWeek.includes(WEEKDAYS[date.getUTCDay()] ?? "sunday");
    case "monthly":
      return date.getUTCDate() === trigger.dayOfMonth;
  }

  return unsupportedCalendarFrequency(frequency);
}

function sampledOccurrenceCount(frequency: CalendarTrigger["frequency"]): number {
  switch (frequency) {
    case "daily":
      return 370;
    case "weekly":
      return 60;
    case "monthly":
      return 24;
  }

  return unsupportedCalendarFrequency(frequency);
}

function nextCalendarOccurrence(trigger: CalendarTrigger, after: number): number | null {
  const formatter = formatterFor(trigger.timeZone);
  const start = formatter === null ? null : localDateTime(formatter, after);

  if (formatter === null || start === null) {
    return null;
  }

  const [hour, minute] = trigger.at.split(":").map(Number);

  if (hour === undefined || minute === undefined) {
    return null;
  }

  for (let offsetDays = 0; offsetDays <= CALENDAR_SEARCH_DAYS; offsetDays += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offsetDays));

    if (!matchesCalendarDate(trigger, date)) {
      continue;
    }

    const candidate = firstInstantForLocalDateTime(formatter, {
      day: date.getUTCDate(),
      hour,
      minute,
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    });

    if (candidate !== null && candidate > after) {
      return candidate;
    }
  }

  return null;
}

export function nextAgentScheduleOccurrence(
  configuration: AgentScheduleConfiguration,
  after: number,
): number | null {
  const trigger = triggerFor(configuration);

  return trigger.type === "interval"
    ? after + trigger.intervalSeconds * 1_000
    : nextCalendarOccurrence(trigger, after);
}

export function nextAgentScheduleOccurrenceAfterClaim(
  configuration: AgentScheduleConfiguration,
  scheduledAt: number,
  claimedAt: number,
): number | null {
  const trigger = triggerFor(configuration);

  if (trigger.type === "calendar") {
    return nextCalendarOccurrence(trigger, claimedAt);
  }

  const intervalMilliseconds = trigger.intervalSeconds * 1_000;
  const elapsedIntervals = Math.floor(Math.max(0, claimedAt - scheduledAt) / intervalMilliseconds);

  return scheduledAt + (elapsedIntervals + 1) * intervalMilliseconds;
}

export function minimumAgentScheduleIntervalSeconds(
  configuration: AgentScheduleConfiguration,
  after: number,
): number | null {
  const trigger = triggerFor(configuration);

  if (trigger.type === "interval") {
    return trigger.intervalSeconds;
  }

  const occurrences = sampledOccurrenceCount(trigger.frequency);
  let previous = nextCalendarOccurrence(trigger, after);
  let minimum = Number.POSITIVE_INFINITY;

  if (previous === null) {
    return null;
  }

  for (let index = 1; index < occurrences; index += 1) {
    const next = nextCalendarOccurrence(trigger, previous);

    if (next === null) {
      return null;
    }

    minimum = Math.min(minimum, (next - previous) / 1_000);
    previous = next;
  }

  return Number.isFinite(minimum) ? minimum : null;
}
