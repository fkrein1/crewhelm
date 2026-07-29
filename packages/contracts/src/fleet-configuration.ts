import * as z from "zod";

import {
  MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS,
  MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS,
} from "./agent-schedules.js";
import { agentExecutionLimitsSchema, agentMutationIdempotencyKeySchema } from "./control-plane.js";
import {
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  RUNNABLE_AGENT_MODELS,
  runIntegrationLimitsSchema,
  runnableAgentModelSchema,
} from "./run-admission.js";

export const DEFAULT_FLEET_AI_DAILY_SPEND_MICROUSD = 1_000_000;
export const DEFAULT_FLEET_AI_RUN_RESERVATION_MICROUSD = 50_000;
export const DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY = 300;
export const DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS = 8_000;
export const DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT = 2;
export const DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN = 8;
export const DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN = 2;
export const DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT = 1;
export const DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS = 60;
export const MAXIMUM_FLEET_CONFIGURATION_REVISIONS = 1_000;
export const MAXIMUM_FLEET_INTEGRATION_CALLS_PER_WINDOW = 1_000_000;
export const MAXIMUM_FLEET_SPEND_MICROUSD = 1_000_000_000_000;

export const defaultFleetExecutionLimits = {
  maxDurationSeconds: 300,
  maxModelTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  maxToolCalls: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
  maxTurns: 8,
} as const;

const fleetSpendMicrousdSchema = z
  .number()
  .int()
  .min(1)
  .max(MAXIMUM_FLEET_SPEND_MICROUSD)
  .safe()
  .describe("Whole micro-US dollars; 1 USD equals 1,000,000 microUSD.");
const fleetIntegrationCallLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAXIMUM_FLEET_INTEGRATION_CALLS_PER_WINDOW);
const fleetExecutionLimitsSchema = z.strictObject({
  maxDurationSeconds: agentExecutionLimitsSchema.shape.maxDurationSeconds.describe(
    "Maximum wall-clock seconds for one run.",
  ),
  maxModelTokens: agentExecutionLimitsSchema.shape.maxModelTokens
    .max(MAXIMUM_RUN_MODEL_OUTPUT_TOKENS)
    .describe("Maximum model output tokens for one run."),
  maxToolCalls: agentExecutionLimitsSchema.shape.maxToolCalls.describe(
    "Maximum integration tool executions for one run.",
  ),
  maxTurns: agentExecutionLimitsSchema.shape.maxTurns.describe("Maximum model turns for one run."),
});
const allowedFleetModelsSchema = z
  .array(runnableAgentModelSchema)
  .min(1)
  .max(RUNNABLE_AGENT_MODELS.length)
  .refine(
    (models) => models.every((model, index) => index === 0 || (models[index - 1] ?? "") < model),
    "Expected unique supported models in canonical order.",
  )
  .describe("Allowed supported model IDs, unique and sorted in ascending order.");

export const fleetConfigurationDataSchema = z
  .strictObject({
    ai: z.strictObject({
      dailySpendMicrousd: fleetSpendMicrousdSchema.describe(
        "Maximum estimated AI spend in one day, bounded by the installation AI Gateway ceiling.",
      ),
      runReservationMicrousd: fleetSpendMicrousdSchema.describe(
        "Amount reserved before admitting one run and replaced by settled Gateway cost.",
      ),
    }),
    execution: fleetExecutionLimitsSchema.describe(
      "Fleet ceilings applied to every run; lower Agent limits continue to win.",
    ),
    integrations: runIntegrationLimitsSchema.extend({
      callsPerDay: fleetIntegrationCallLimitSchema.describe(
        "Maximum integration executions across the fleet in a rolling day.",
      ),
      callsPerThirtyDays: fleetIntegrationCallLimitSchema.describe(
        "Maximum integration executions across the fleet in a rolling thirty-day window.",
      ),
      duplicateToolCallLimit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Maximum executions of identical tool arguments within one run."),
      maxCallsPerRun: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Maximum integration executions across all tools in one run."),
      maxCallsPerToolPerRun: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Maximum executions of one granted tool in one run."),
      maxConcurrencyPerGrant: z
        .number()
        .int()
        .min(1)
        .max(16)
        .describe("Maximum simultaneous executions using one tool grant."),
    }),
    models: z.strictObject({
      allowed: allowedFleetModelsSchema.describe(
        "Supported models that Agents in this fleet may select.",
      ),
      default: runnableAgentModelSchema.describe("Model used when Agent creation omits a model."),
    }),
    schedules: z.strictObject({
      minimumIntervalSeconds: z
        .number()
        .int()
        .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
        .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
        .describe("Smallest interval that a newly configured recurring Agent schedule may use."),
    }),
  })
  .refine(
    (configuration) =>
      configuration.ai.runReservationMicrousd <= configuration.ai.dailySpendMicrousd,
    "Run reservation must not exceed the daily AI spend limit.",
  )
  .refine(
    (configuration) =>
      configuration.integrations.callsPerDay <= configuration.integrations.callsPerThirtyDays,
    "Daily integration calls must not exceed the thirty-day limit.",
  )
  .refine(
    (configuration) =>
      configuration.integrations.maxCallsPerToolPerRun <= configuration.integrations.maxCallsPerRun,
    "Per-tool calls must not exceed total calls per run.",
  )
  .refine(
    (configuration) =>
      configuration.execution.maxToolCalls <= configuration.integrations.maxCallsPerRun,
    "Agent tool calls must not exceed the fleet tool-call limit.",
  )
  .refine(
    (configuration) => configuration.models.allowed.includes(configuration.models.default),
    "The default model must be allowed.",
  );

export const fleetConfigurationPatchSchema = z
  .strictObject({
    ai: z
      .strictObject({
        dailySpendMicrousd: fleetSpendMicrousdSchema
          .describe(
            "New rolling daily AI spend limit in microUSD; 1 USD is 1,000,000. Cannot exceed the installation AI Gateway ceiling.",
          )
          .optional(),
        runReservationMicrousd: fleetSpendMicrousdSchema
          .describe(
            "New provisional microUSD reservation per admitted run; settled Gateway cost replaces it.",
          )
          .optional(),
      })
      .describe("AI spend controls.")
      .optional(),
    execution: fleetExecutionLimitsSchema
      .partial()
      .describe("Fleet-wide per-run ceilings; lower Agent-specific limits still win.")
      .optional(),
    integrations: z
      .strictObject({
        callsPerDay: fleetIntegrationCallLimitSchema
          .describe("New maximum integration executions across the fleet in a rolling day.")
          .optional(),
        callsPerThirtyDays: fleetIntegrationCallLimitSchema
          .describe(
            "New maximum integration executions across the fleet in a rolling thirty-day window.",
          )
          .optional(),
        duplicateToolCallLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe(
            "New maximum executions of identical tool arguments within one run; bounds accidental loops.",
          )
          .optional(),
        maxCallsPerRun: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe("New maximum integration executions across all tools in one run.")
          .optional(),
        maxCallsPerToolPerRun: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe("New maximum executions of one granted integration tool in one run.")
          .optional(),
        maxConcurrencyPerGrant: z
          .number()
          .int()
          .min(1)
          .max(16)
          .describe("New maximum simultaneous executions using one tool grant.")
          .optional(),
      })
      .describe("Integration usage and loop controls.")
      .optional(),
    models: z
      .strictObject({
        allowed: allowedFleetModelsSchema.optional(),
        default: runnableAgentModelSchema
          .describe("New model used when Agent creation omits a model.")
          .optional(),
      })
      .describe("Fleet model selection defaults and allowlist.")
      .optional(),
    schedules: z
      .strictObject({
        minimumIntervalSeconds: z
          .number()
          .int()
          .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
          .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
          .describe("New minimum interval in seconds for recurring Agent schedules.")
          .optional(),
      })
      .describe("Recurring schedule controls.")
      .optional(),
  })
  .refine(
    (patch) =>
      patch.ai !== undefined ||
      patch.execution !== undefined ||
      patch.integrations !== undefined ||
      patch.models !== undefined ||
      patch.schedules !== undefined,
    "Expected at least one configuration section.",
  );

export const fleetConfigurationRevisionNumberSchema = z.number().int().positive().safe();
export const fleetConfigurationSchema = z.strictObject({
  configuredAt: z.iso.datetime(),
  data: fleetConfigurationDataSchema,
  revision: fleetConfigurationRevisionNumberSchema,
});

export const getFleetConfigurationInputSchema = z.strictObject({
  target: z
    .strictObject({ kind: z.literal("fleet") })
    .describe('Use { kind: "fleet" } to read the authenticated owner\'s configuration.'),
});

export const configureFleetConfigurationInputSchema = z
  .strictObject({
    expectedRevision: fleetConfigurationRevisionNumberSchema.describe(
      "Current revision returned by crewhelm_get_config; stale revisions are rejected.",
    ),
    idempotencyKey: agentMutationIdempotencyKeySchema
      .describe(
        "Required in apply mode. Use a new stable key for this exact update; reuse it only for an identical retry.",
      )
      .optional(),
    mode: z
      .enum(["preview", "apply"])
      .describe("Use preview to validate without saving, then apply the same patch to persist it."),
    patch: fleetConfigurationPatchSchema.describe(
      "Only supplied fields change; omitted fields preserve their current values.",
    ),
    target: z
      .strictObject({ kind: z.literal("fleet") })
      .describe('Use { kind: "fleet" } to change the authenticated owner\'s configuration.'),
  })
  .superRefine((input, context) => {
    if (input.mode === "apply" && input.idempotencyKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Apply mode requires an idempotency key.",
        path: ["idempotencyKey"],
      });
    }

    if (input.mode === "preview" && input.idempotencyKey !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Preview mode does not accept an idempotency key.",
        path: ["idempotencyKey"],
      });
    }
  });

const fleetConfigurationErrorSchema = z.strictObject({
  code: z.enum([
    "budget_above_installation_limit",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "no_changes",
    "owner_mismatch",
    "revision_conflict",
    "revision_limit_exceeded",
  ]),
  message: z.literal("Fleet configuration request denied."),
});
const installationAiDailySpendLimitSchema = fleetSpendMicrousdSchema.describe(
  "Hard daily AI Gateway ceiling for this Crewhelm installation. Fleet configuration may lower it. To raise or replace it, rerun Crewhelm bootstrap with --ai-budget-usd <dollars>.",
);

export const getFleetConfigurationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    configuration: fleetConfigurationSchema,
    installationLimits: z.strictObject({
      aiDailySpendMicrousd: installationAiDailySpendLimitSchema,
    }),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: fleetConfigurationErrorSchema,
    ok: z.literal(false),
  }),
]);

export const configureFleetConfigurationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    configuration: fleetConfigurationSchema,
    installationLimits: z.strictObject({
      aiDailySpendMicrousd: installationAiDailySpendLimitSchema,
    }),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: fleetConfigurationErrorSchema,
    ok: z.literal(false),
  }),
]);

export type ConfigureFleetConfigurationInput = z.infer<
  typeof configureFleetConfigurationInputSchema
>;
export type ConfigureFleetConfigurationResult = z.infer<
  typeof configureFleetConfigurationResultSchema
>;
export type FleetConfiguration = z.infer<typeof fleetConfigurationSchema>;
export type FleetConfigurationData = z.infer<typeof fleetConfigurationDataSchema>;
export type FleetConfigurationPatch = z.infer<typeof fleetConfigurationPatchSchema>;
export type GetFleetConfigurationResult = z.infer<typeof getFleetConfigurationResultSchema>;
