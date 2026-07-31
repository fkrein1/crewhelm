import * as z from "zod";

import {
  agentCapabilityConfigurationsSchema,
  agentCapabilityPrerequisiteSchema,
} from "./agent-capabilities.js";
import {
  agentExecutionLimitsSchema,
  agentInstructionsSchema,
  agentMutationIdempotencyKeySchema,
  agentNameSchema,
  agentSchema,
} from "./control-plane.js";
import {
  agentBlueprintIdSchema,
  agentBlueprintProvenanceSchema,
  agentBlueprintVersionSchema,
} from "./agent-blueprint-identity.js";
import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";
import { agentRuntimePlanSchema } from "./agent-runtime.js";
import { sha256DigestSchema } from "./capabilities.js";
import { skillProvenanceSchema } from "./skills.js";

export const MAXIMUM_AGENT_BLUEPRINTS = 100;
export const MAXIMUM_AGENT_BLUEPRINT_VERSIONS = 50;
export const MAXIMUM_AGENT_BLUEPRINT_PARAMETERS = 16;
export const MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES = 32 * 1_024;
export const MAXIMUM_AGENT_BLUEPRINT_LIBRARY_BYTES = 16 * 1_024 * 1_024;

const textEncoder = new TextEncoder();
const parameterToken = /\{\{([a-z][a-z0-9-]{0,39})\}\}/g;

function serializedBytes(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function referencedParameters(value: string): string[] {
  return [...value.matchAll(parameterToken)].map((match) => match[1] ?? "");
}

export const agentBlueprintNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Agent blueprint name.");
export const agentBlueprintDescriptionSchema = z.string().trim().min(1).max(320);
export const agentBlueprintStatusSchema = z.enum(["active", "retired"]);
export const agentBlueprintParameterNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase parameter name.");
const parameterDescriptionSchema = z.string().trim().min(1).max(160);
const stringParameterSchema = z.strictObject({
  default: z.string().max(1_024).optional(),
  description: parameterDescriptionSchema,
  name: agentBlueprintParameterNameSchema,
  type: z.literal("string"),
});
const integerParameterSchema = z
  .strictObject({
    default: z.number().int().safe().optional(),
    description: parameterDescriptionSchema,
    maximum: z.number().int().safe().optional(),
    minimum: z.number().int().safe().optional(),
    name: agentBlueprintParameterNameSchema,
    type: z.literal("integer"),
  })
  .superRefine((parameter, context) => {
    if (
      parameter.minimum !== undefined &&
      parameter.maximum !== undefined &&
      parameter.minimum > parameter.maximum
    ) {
      context.addIssue({ code: "custom", message: "Parameter minimum exceeds maximum." });
    }

    if (
      parameter.default !== undefined &&
      ((parameter.minimum !== undefined && parameter.default < parameter.minimum) ||
        (parameter.maximum !== undefined && parameter.default > parameter.maximum))
    ) {
      context.addIssue({ code: "custom", message: "Parameter default is outside its bounds." });
    }
  });
const booleanParameterSchema = z.strictObject({
  default: z.boolean().optional(),
  description: parameterDescriptionSchema,
  name: agentBlueprintParameterNameSchema,
  type: z.literal("boolean"),
});
export const agentBlueprintParameterSchema = z.discriminatedUnion("type", [
  stringParameterSchema,
  integerParameterSchema,
  booleanParameterSchema,
]);
export const agentBlueprintParameterValueSchema = z.union([
  z.string().max(1_024),
  z.number().int().safe(),
  z.boolean(),
]);
export const agentBlueprintParameterValuesSchema = z
  .record(agentBlueprintParameterNameSchema, agentBlueprintParameterValueSchema)
  .refine(
    (parameters) => Object.keys(parameters).length <= MAXIMUM_AGENT_BLUEPRINT_PARAMETERS,
    "Too many Agent blueprint parameter values.",
  );

const safePublisherUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Expected an HTTPS publisher URL without credentials, query, or fragment.");
export const agentBlueprintPublisherSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  url: safePublisherUrlSchema.optional(),
});
export const agentBlueprintPackageSchema = z
  .strictObject({
    agent: z.strictObject({
      capabilities: agentCapabilityConfigurationsSchema,
      executionLimits: agentExecutionLimitsSchema.optional(),
      instructions: agentInstructionsSchema,
      name: agentNameSchema,
    }),
    description: agentBlueprintDescriptionSchema,
    name: agentBlueprintNameSchema,
    parameters: z.array(agentBlueprintParameterSchema).max(MAXIMUM_AGENT_BLUEPRINT_PARAMETERS),
    provenance: skillProvenanceSchema,
    publisher: agentBlueprintPublisherSchema,
    schemaVersion: z.literal(1),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Agent blueprint tag."),
      )
      .max(12),
  })
  .superRefine((blueprint, context) => {
    const names = blueprint.parameters.map(({ name }) => name);
    const references = [
      ...referencedParameters(blueprint.agent.name),
      ...referencedParameters(blueprint.agent.instructions),
    ];

    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "Parameter names must be unique." });
    }

    if (new Set(blueprint.tags).size !== blueprint.tags.length) {
      context.addIssue({ code: "custom", message: "Agent blueprint tags must be unique." });
    }

    if (references.some((reference) => !names.includes(reference))) {
      context.addIssue({
        code: "custom",
        message: "Agent blueprint references an unknown parameter.",
      });
    }

    if (names.some((name) => !references.includes(name))) {
      context.addIssue({
        code: "custom",
        message: "Every Agent blueprint parameter must be used.",
      });
    }

    if (serializedBytes(blueprint) > MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Agent blueprint package exceeds its serialized byte budget.",
      });
    }
  })
  .describe("A bounded, untrusted Agent blueprint package. Parameters use {{name}} tokens.");

export const agentBlueprintPackageDescriptorSchema = z.strictObject({
  digest: sha256DigestSchema,
  sizeBytes: z.number().int().positive().max(MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES),
});
export const agentBlueprintSummarySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  currentVersion: agentBlueprintVersionSchema,
  description: agentBlueprintDescriptionSchema,
  id: agentBlueprintIdSchema,
  name: agentBlueprintNameSchema,
  package: agentBlueprintPackageDescriptorSchema,
  publisher: agentBlueprintPublisherSchema,
  status: agentBlueprintStatusSchema,
  tags: z.array(z.string().min(1).max(40)).max(12),
  updatedAt: z.iso.datetime(),
  versionCount: z.number().int().positive().max(MAXIMUM_AGENT_BLUEPRINT_VERSIONS),
});
export const agentBlueprintVersionRecordSchema = z.strictObject({
  contentTrust: z.literal("untrusted"),
  createdAt: z.iso.datetime(),
  id: agentBlueprintIdSchema,
  metadataTrust: z.literal("unverified"),
  package: agentBlueprintPackageSchema,
  packageDescriptor: agentBlueprintPackageDescriptorSchema,
  version: agentBlueprintVersionSchema,
});

export const listAgentBlueprintsInputSchema = z.strictObject({
  target: z.strictObject({
    cursor: agentBlueprintIdSchema.optional(),
    kind: z.literal("agent-blueprint-catalog"),
    limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(25),
    name: agentBlueprintNameSchema.optional(),
    status: agentBlueprintStatusSchema.optional(),
    tag: z.string().min(1).max(40).optional(),
  }),
});
export const getAgentBlueprintInputSchema = z.strictObject({
  target: z.strictObject({
    id: agentBlueprintIdSchema,
    kind: z.literal("agent-blueprint-package"),
    version: agentBlueprintVersionSchema.optional(),
  }),
});
const changeModeSchema = z.enum(["preview", "apply"]);
export const publishAgentBlueprintInputSchema = z
  .strictObject({
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: changeModeSchema,
    target: z
      .strictObject({
        expectedVersion: agentBlueprintVersionSchema.optional(),
        id: agentBlueprintIdSchema.optional(),
        kind: z.literal("agent-blueprint-package"),
        package: agentBlueprintPackageSchema,
      })
      .superRefine((target, context) => {
        if ((target.id === undefined) !== (target.expectedVersion === undefined)) {
          context.addIssue({
            code: "custom",
            message: "Publishing a new version requires blueprint ID and expected version.",
          });
        }
      }),
  })
  .superRefine((input, context) => {
    if ((input.mode === "apply") !== (input.idempotencyKey !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Apply requires an idempotency key; preview forbids one.",
      });
    }
  });
export const retireAgentBlueprintInputSchema = z
  .strictObject({
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: changeModeSchema,
    target: z.strictObject({
      expectedVersion: agentBlueprintVersionSchema,
      id: agentBlueprintIdSchema,
      kind: z.literal("agent-blueprint-retirement"),
    }),
  })
  .superRefine((input, context) => {
    if ((input.mode === "apply") !== (input.idempotencyKey !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Apply requires an idempotency key; preview forbids one.",
      });
    }
  });
export const instantiateAgentBlueprintInputSchema = z
  .strictObject({
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: changeModeSchema,
    target: z.strictObject({
      id: agentBlueprintIdSchema,
      kind: z.literal("agent-blueprint-instance"),
      parameters: agentBlueprintParameterValuesSchema.default({}),
      version: agentBlueprintVersionSchema.optional(),
    }),
  })
  .superRefine((input, context) => {
    if ((input.mode === "apply") !== (input.idempotencyKey !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Apply requires an idempotency key; preview forbids one.",
      });
    }
  });

export const agentBlueprintPrerequisiteStateSchema = z.union([
  agentCapabilityPrerequisiteSchema.extend({
    state: z.enum(["available", "missing"]),
  }),
  z.strictObject({
    description: z.string().min(1).max(240),
    id: z.string().min(1).max(160),
    kind: z.literal("skill"),
    state: z.enum(["available", "missing"]),
  }),
]);
export const agentBlueprintPreviewSchema = z.strictObject({
  agent: z.strictObject({
    capabilities: agentCapabilityConfigurationsSchema,
    executionLimits: agentExecutionLimitsSchema,
    instructions: agentInstructionsSchema,
    name: agentNameSchema,
  }),
  authority: z.strictObject({
    createsGrants: z.literal(false),
    requestedGrants: z
      .array(
        z.strictObject({
          description: z.string().min(1).max(240),
          id: z.string().min(1).max(80),
        }),
      )
      .max(16),
  }),
  budget: agentExecutionLimitsSchema.extend({
    maxModelCalls: z.number().int().min(1).max(100),
    pricing: z.literal("provider-metered"),
  }),
  prerequisites: z.array(agentBlueprintPrerequisiteStateSchema).max(32),
  profile: agentRuntimePlanSchema.shape.inference,
  provenance: agentBlueprintProvenanceSchema,
  ready: z.boolean(),
});

const agentBlueprintRequestErrorSchema = z.strictObject({
  code: z.enum([
    "blueprint_limit_exceeded",
    "blueprint_not_found",
    "blueprint_retired",
    "agent_limit_exceeded",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "library_capacity_exceeded",
    "name_conflict",
    "no_changes",
    "owner_mismatch",
    "prerequisite_unavailable",
    "version_conflict",
    "version_limit_exceeded",
  ]),
  message: z.literal("Agent blueprint request denied."),
});
export const listAgentBlueprintsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    blueprints: z.array(agentBlueprintSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
    nextCursor: agentBlueprintIdSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({ error: agentBlueprintRequestErrorSchema, ok: z.literal(false) }),
]);
export const getAgentBlueprintResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    blueprint: agentBlueprintSummarySchema,
    ok: z.literal(true),
    version: agentBlueprintVersionRecordSchema,
  }),
  z.strictObject({ error: agentBlueprintRequestErrorSchema, ok: z.literal(false) }),
]);
export const publishAgentBlueprintResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    blueprint: agentBlueprintSummarySchema.optional(),
    ok: z.literal(true),
    package: agentBlueprintPackageDescriptorSchema,
    version: agentBlueprintVersionSchema,
  }),
  z.strictObject({ error: agentBlueprintRequestErrorSchema, ok: z.literal(false) }),
]);
export const retireAgentBlueprintResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    blueprint: agentBlueprintSummarySchema,
    ok: z.literal(true),
  }),
  z.strictObject({ error: agentBlueprintRequestErrorSchema, ok: z.literal(false) }),
]);
export const instantiateAgentBlueprintResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agent: agentSchema.optional(),
    created: z.boolean(),
    ok: z.literal(true),
    preview: agentBlueprintPreviewSchema,
  }),
  z.strictObject({ error: agentBlueprintRequestErrorSchema, ok: z.literal(false) }),
]);

export type AgentBlueprintPackage = z.infer<typeof agentBlueprintPackageSchema>;
export type AgentBlueprintPreview = z.infer<typeof agentBlueprintPreviewSchema>;
export type AgentBlueprintSummary = z.infer<typeof agentBlueprintSummarySchema>;
export type GetAgentBlueprintResult = z.infer<typeof getAgentBlueprintResultSchema>;
export type InstantiateAgentBlueprintInput = z.infer<typeof instantiateAgentBlueprintInputSchema>;
export type InstantiateAgentBlueprintResult = z.infer<typeof instantiateAgentBlueprintResultSchema>;
export type ListAgentBlueprintsResult = z.infer<typeof listAgentBlueprintsResultSchema>;
export type PublishAgentBlueprintInput = z.infer<typeof publishAgentBlueprintInputSchema>;
export type PublishAgentBlueprintResult = z.infer<typeof publishAgentBlueprintResultSchema>;
export type RetireAgentBlueprintInput = z.infer<typeof retireAgentBlueprintInputSchema>;
export type RetireAgentBlueprintResult = z.infer<typeof retireAgentBlueprintResultSchema>;
