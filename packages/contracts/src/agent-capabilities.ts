import * as z from "zod";

export const MAXIMUM_AGENT_CAPABILITY_MODULES = 16;
export const MAXIMUM_AGENT_CAPABILITY_CONFIGURATION_BYTES = 8 * 1_024;
export const MAXIMUM_AGENT_CAPABILITY_CONFIGURATIONS_BYTES = 32 * 1_024;
export const WORKERS_AI_CAPABILITY_ID = "inference.workers-ai";
export const WORKERS_AI_CAPABILITY_SCHEMA_VERSION = 1;

export const agentCapabilityModuleIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "Expected a stable lowercase capability module ID.");
export const agentCapabilitySchemaVersionSchema = z.number().int().min(1).max(1_000);

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const agentCapabilityConfigurationPrimitiveSchema = z.union([
  z.string().max(2_048),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const agentCapabilityConfigurationValueSchema = z.union([
  agentCapabilityConfigurationPrimitiveSchema,
  z.array(agentCapabilityConfigurationPrimitiveSchema).max(64),
  z
    .record(z.string().min(1).max(80), agentCapabilityConfigurationPrimitiveSchema)
    .refine((value) => Object.keys(value).length <= 64, "Capability object has too many fields."),
]);

export const agentCapabilityConfigurationDataSchema = z
  .record(z.string().min(1).max(80), agentCapabilityConfigurationValueSchema)
  .superRefine((configuration, context) => {
    if (Object.keys(configuration).length > 32) {
      context.addIssue({
        code: "custom",
        message: "Capability configuration has too many fields.",
      });
    }

    if (serializedBytes(configuration) > MAXIMUM_AGENT_CAPABILITY_CONFIGURATION_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Capability configuration exceeds its serialized response budget.",
      });
    }
  });

export const agentCapabilityConfigurationSchema = z.strictObject({
  configuration: agentCapabilityConfigurationDataSchema,
  id: agentCapabilityModuleIdSchema,
  schemaVersion: agentCapabilitySchemaVersionSchema,
});

export const agentCapabilityConfigurationsSchema = z
  .array(agentCapabilityConfigurationSchema)
  .min(1)
  .max(MAXIMUM_AGENT_CAPABILITY_MODULES)
  .superRefine((capabilities, context) => {
    if (
      !capabilities.every(
        (capability, index) => index === 0 || (capabilities[index - 1]?.id ?? "") < capability.id,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected unique capability modules in canonical ID order.",
      });
    }

    if (serializedBytes(capabilities) > MAXIMUM_AGENT_CAPABILITY_CONFIGURATIONS_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Agent capability configuration exceeds its serialized response budget.",
      });
    }
  });

export const agentCapabilityPrerequisiteSchema = z.strictObject({
  description: z.string().min(1).max(240),
  id: z.string().min(1).max(80),
  kind: z.enum(["binding", "grant", "resource"]),
});

export const agentCapabilityConfigurationFieldSchema = z.strictObject({
  description: z.string().min(1).max(240),
  enum: z.array(z.string().min(1).max(160)).min(1).max(64).optional(),
  name: z.string().min(1).max(80),
  required: z.boolean(),
  type: z.enum(["boolean", "integer", "list", "number", "object", "string"]),
});

export const agentCapabilityDescriptorSchema = z.strictObject({
  availability: z.strictObject({
    missingPrerequisites: z.array(z.string().min(1).max(80)).max(16),
    state: z.enum(["available", "unavailable"]),
  }),
  configurationFields: z.array(agentCapabilityConfigurationFieldSchema).max(32),
  description: z.string().min(1).max(320),
  id: agentCapabilityModuleIdSchema,
  prerequisites: z.array(agentCapabilityPrerequisiteSchema).max(16),
  schemaVersion: agentCapabilitySchemaVersionSchema,
  title: z.string().min(1).max(80),
  trust: z.strictObject({
    configuration: z.literal("untrusted-until-validated"),
    runtimeContribution: z.literal("module-validated"),
  }),
});

export const getAgentCapabilityCatalogInputSchema = z.strictObject({
  target: z.strictObject({
    id: agentCapabilityModuleIdSchema.optional(),
    kind: z.literal("agent-capability"),
  }),
});

const agentCapabilityCatalogErrorSchema = z.strictObject({
  code: z.enum(["capability_not_found", "insufficient_scope", "invalid_request"]),
  message: z.literal("Agent capability request denied."),
});

export const getAgentCapabilityCatalogResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    capabilities: z.array(agentCapabilityDescriptorSchema).max(MAXIMUM_AGENT_CAPABILITY_MODULES),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: agentCapabilityCatalogErrorSchema,
    ok: z.literal(false),
  }),
]);

export type AgentCapabilityConfiguration = z.infer<typeof agentCapabilityConfigurationSchema>;
export type AgentCapabilityConfigurations = z.infer<typeof agentCapabilityConfigurationsSchema>;
export type AgentCapabilityDescriptor = z.infer<typeof agentCapabilityDescriptorSchema>;
export type GetAgentCapabilityCatalogResult = z.infer<typeof getAgentCapabilityCatalogResultSchema>;
