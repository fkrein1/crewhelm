import * as z from "zod";

export const DEFAULT_FLEET_MAX_AGENTS = 100;
export const DEFAULT_FLEET_MAX_CONNECTIONS = 100;
export const DEFAULT_FLEET_MAX_CONCURRENT_RUNS = 25;
export const MAXIMUM_FLEET_AGENTS = 1_000;
export const MAXIMUM_FLEET_CONNECTIONS = 1_000;
export const MAXIMUM_FLEET_CONCURRENT_RUNS = 1_000;

export const DEFAULT_FLEET_RUN_RETENTION_SECONDS = 24 * 60 * 60;
export const DEFAULT_FLEET_INBOX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const MINIMUM_FLEET_RETENTION_SECONDS = 60 * 60;
export const MAXIMUM_FLEET_RETENTION_SECONDS = 365 * 24 * 60 * 60;

export const MAXIMUM_FLEET_LIST_ITEMS = 25;
export const MAXIMUM_FLEET_LIST_RESPONSE_BYTES = 16 * 1_024;

export const fleetCapacitySchema = z.strictObject({
  maxAgents: z.number().int().min(1).max(MAXIMUM_FLEET_AGENTS),
  maxConcurrentRuns: z.number().int().min(1).max(MAXIMUM_FLEET_CONCURRENT_RUNS),
  maxConnections: z.number().int().min(1).max(MAXIMUM_FLEET_CONNECTIONS),
});

export const fleetRetentionSchema = z.strictObject({
  inboxSeconds: z
    .number()
    .int()
    .min(MINIMUM_FLEET_RETENTION_SECONDS)
    .max(MAXIMUM_FLEET_RETENTION_SECONDS),
  runSeconds: z
    .number()
    .int()
    .min(MINIMUM_FLEET_RETENTION_SECONDS)
    .max(MAXIMUM_FLEET_RETENTION_SECONDS),
});

export const defaultFleetCapacity = {
  maxAgents: DEFAULT_FLEET_MAX_AGENTS,
  maxConcurrentRuns: DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
  maxConnections: DEFAULT_FLEET_MAX_CONNECTIONS,
} as const;

export const defaultFleetRetention = {
  inboxSeconds: DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
  runSeconds: DEFAULT_FLEET_RUN_RETENTION_SECONDS,
} as const;

export type FleetCapacity = z.infer<typeof fleetCapacitySchema>;
export type FleetRetention = z.infer<typeof fleetRetentionSchema>;
