import * as z from "zod";

import { agentCapabilityConfigurationsSchema, SKILLS_CAPABILITY_ID } from "./agent-capabilities.js";
import {
  agentBlueprintParameterNameSchema,
  agentBlueprintParameterSchema,
} from "./agent-blueprints.js";
import { agentWorkflowStagePlanSchema } from "./agent-workflows.js";
import {
  agentScheduleWeekdaySchema,
  MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT,
} from "./agent-schedules.js";
import {
  agentExecutionLimitsSchema,
  agentInstructionsSchema,
  agentNameSchema,
} from "./control-plane.js";
import {
  capabilityEffectSchema,
  composioToolLimitsSchema,
  sha256DigestSchema,
  toolAuthorizationModeSchema,
} from "./capabilities.js";
import {
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolSlugSchema,
} from "./integrations.js";
import {
  outputContractSchema,
  publicJsonObjectSchema,
  validateJsonOutput,
} from "./output-contracts.js";
import {
  remoteMcpAuthKindSchema,
  remoteMcpEndpointSchema,
  remoteMcpOAuthScopesSchema,
  remoteMcpToolNameSchema,
} from "./remote-mcp.js";
import {
  MAXIMUM_SKILL_PACKAGE_BYTES,
  skillDescriptionSchema,
  skillFilesSchema,
  skillNameSchema,
  skillProvenanceSchema,
} from "./skills.js";
import { runPromptSchema } from "./run-admission.js";

export const MAXIMUM_RECIPE_BYTES = 128 * 1_024;
export const MAXIMUM_RECIPE_BOUNDARIES = 16;
export const MAXIMUM_RECIPE_CONNECTIONS = 8;
export const MAXIMUM_RECIPE_INPUTS = 16;
export const MAXIMUM_RECIPE_SKILLS = 8;
export const MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS =
  MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT;
export const MAXIMUM_RECIPE_SAMPLE_CHARACTERS = 16 * 1_024;

const encoder = new TextEncoder();
const parameterToken = /\{\{([a-z][a-z0-9-]{0,39})\}\}/g;

function serializedBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function referencedParameters(value: string): string[] {
  return [...value.matchAll(parameterToken)].map((match) => match[1] ?? "");
}

function uniqueInCanonicalOrder(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function isDeniedIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

const safePublicUrlSchema = z
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
  }, "Expected an HTTPS URL without credentials, query, or fragment.");

export const recipeRegistryOriginSchema = safePublicUrlSchema.refine((value) => {
  const url = new URL(value);
  const encodedHostname = url.hostname.toLowerCase();
  const hostname = encodedHostname.replace(/\.+$/, "");
  return (
    url.pathname === "/" &&
    (url.port === "" || url.port === "443") &&
    hostname.includes(".") &&
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    !hostname.endsWith(".internal") &&
    !hostname.endsWith(".home.arpa") &&
    !hostname.endsWith(".onion") &&
    !isDeniedIpv4Literal(hostname) &&
    !encodedHostname.startsWith("[") &&
    url.toString() === value
  );
}, "Expected a canonical public HTTPS Registry origin without a path or nonstandard port.");

export const recipePublisherNamespaceSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(
    /^(?!-)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Expected a lowercase publisher namespace without leading or trailing hyphens.",
  );
export const recipeNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Recipe name.");
export const recipeVersionSchema = z.number().int().positive().safe();
export const recipeLicenseSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9().+ -]+$/, "Expected a bounded declared license expression.");
export const recipeOperationNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase operation name.");
export const recipeInputNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Recipe input name.");
export const recipeConnectionSlotSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Connection slot.");

export const registryArtifactKindSchema = z.enum(["recipe", "skill"]);
export const registryArtifactCoordinateSchema = z.strictObject({
  kind: registryArtifactKindSchema,
  name: recipeNameSchema,
  namespace: recipePublisherNamespaceSchema,
  version: recipeVersionSchema,
});
export const registryArtifactDescriptorSchema = z.strictObject({
  digest: sha256DigestSchema,
  sizeBytes: z.number().int().positive().max(MAXIMUM_RECIPE_BYTES),
});

export const recipeSkillDependencySchema = z.strictObject({
  digest: sha256DigestSchema,
  name: skillNameSchema,
  namespace: recipePublisherNamespaceSchema,
  registry: recipeRegistryOriginSchema,
  requirement: z.enum(["optional", "required"]),
  version: recipeVersionSchema,
});
export const recipeSkillDependenciesSchema = z
  .array(recipeSkillDependencySchema)
  .max(MAXIMUM_RECIPE_SKILLS)
  .refine(
    (dependencies) =>
      uniqueInCanonicalOrder(
        dependencies.map(({ name, namespace, registry }) => `${registry}:${namespace}:${name}`),
      ),
    "Expected one pinned version per Skill identity in canonical Registry, namespace, and name order.",
  );

export const registrySkillPackageSchema = z
  .strictObject({
    description: skillDescriptionSchema,
    files: skillFilesSchema.refine(
      (files) => files.every(({ path }) => !path.startsWith("scripts/")),
      "Public Skill packages do not accept scripts.",
    ),
    license: recipeLicenseSchema,
    name: skillNameSchema,
    provenance: skillProvenanceSchema,
    schemaVersion: z.literal(1),
  })
  .refine(
    (skillPackage) => serializedBytes(skillPackage) <= MAXIMUM_SKILL_PACKAGE_BYTES,
    "Public Skill package exceeds its serialized byte budget.",
  )
  .describe(
    "An immutable untrusted public Skill package containing bounded UTF-8 instructions, references, and text assets without scripts.",
  );

export const recipeSetupParameterSchema = agentBlueprintParameterSchema;
export const recipeSetupParametersSchema = z.array(recipeSetupParameterSchema).max(16);

export const recipeInputSchema = z.strictObject({
  description: z.string().trim().min(1).max(240),
  kind: z.enum(["brief", "invocation"]),
  name: recipeInputNameSchema,
  required: z.boolean(),
});
export const recipeInputsSchema = z
  .array(recipeInputSchema)
  .max(MAXIMUM_RECIPE_INPUTS)
  .refine(
    (inputs) => uniqueInCanonicalOrder(inputs.map(({ name }) => name)),
    "Expected unique Recipe inputs in canonical name order.",
  );

const requestedConnectionBoundsSchema = z.strictObject({
  expiresAfterSeconds: z
    .number()
    .int()
    .min(60)
    .max(365 * 24 * 60 * 60)
    .nullable(),
  limits: composioToolLimitsSchema,
});

const recipeComposioToolRequirementSchema = z
  .strictObject({
    authorization: toolAuthorizationModeSchema,
    effect: capabilityEffectSchema,
    slug: integrationToolSlugSchema,
    version: integrationToolkitVersionSchema,
  })
  .refine(
    ({ authorization, effect }) =>
      effect !== "destructive" || authorization === "approval_required",
    "Destructive tools must request approval-required authority.",
  );
export const recipeComposioConnectionRequirementSchema = requestedConnectionBoundsSchema.extend({
  description: z.string().trim().min(1).max(240),
  integration: integrationSlugSchema,
  kind: z.literal("composio"),
  slot: recipeConnectionSlotSchema,
  tools: z
    .array(recipeComposioToolRequirementSchema)
    .min(1)
    .max(20)
    .refine(
      (tools) => uniqueInCanonicalOrder(tools.map(({ slug, version }) => `${slug}:${version}`)),
      "Expected unique Composio tools in canonical slug and version order.",
    ),
});

const recipeRemoteMcpToolRequirementSchema = z.strictObject({
  effect: z.enum(["write", "destructive"]),
  name: remoteMcpToolNameSchema,
});
export const recipeRemoteMcpConnectionRequirementSchema = requestedConnectionBoundsSchema
  .extend({
    authKind: remoteMcpAuthKindSchema,
    authorization: toolAuthorizationModeSchema,
    description: z.string().trim().min(1).max(240),
    endpoint: remoteMcpEndpointSchema,
    kind: z.literal("remote_mcp"),
    oauthScopes: remoteMcpOAuthScopesSchema,
    requiredTools: z
      .array(recipeRemoteMcpToolRequirementSchema)
      .min(1)
      .max(100)
      .refine(
        (tools) => uniqueInCanonicalOrder(tools.map(({ name }) => name)),
        "Expected unique remote MCP tools in canonical name order.",
      ),
    reviewedSnapshotDigest: sha256DigestSchema,
    reviewedToolCount: z.number().int().min(1).max(100),
    slot: recipeConnectionSlotSchema,
  })
  .refine(({ authKind, oauthScopes }) => authKind === "oauth" || oauthScopes.length === 0, {
    message: "Only OAuth remote MCP requirements may request OAuth scopes.",
    path: ["oauthScopes"],
  })
  .refine(
    ({ requiredTools, reviewedToolCount }) => reviewedToolCount >= requiredTools.length,
    "The reviewed remote MCP catalog must contain every required tool.",
  );

export const recipeConnectionRequirementSchema = z.discriminatedUnion("kind", [
  recipeComposioConnectionRequirementSchema,
  recipeRemoteMcpConnectionRequirementSchema,
]);
export const recipeConnectionRequirementsSchema = z
  .array(recipeConnectionRequirementSchema)
  .max(MAXIMUM_RECIPE_CONNECTIONS)
  .refine(
    (connections) => uniqueInCanonicalOrder(connections.map(({ slot }) => slot)),
    "Expected unique Connection requirements in canonical slot order.",
  );

export const recipeAgentCapabilitiesSchema = agentCapabilityConfigurationsSchema.superRefine(
  (capabilities, context) => {
    if (capabilities.some(({ id }) => id === SKILLS_CAPABILITY_ID)) {
      context.addIssue({
        code: "custom",
        message:
          "Recipe Skills must use public Skill dependencies instead of local capability references.",
      });
    }

    if (capabilities.filter(({ id }) => id.startsWith("inference.")).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A Recipe requires exactly one inference capability.",
      });
    }
  },
);
export const recipeAgentSchema = z.strictObject({
  capabilities: recipeAgentCapabilitiesSchema,
  executionLimits: agentExecutionLimitsSchema,
  instructions: agentInstructionsSchema,
  suggestedName: agentNameSchema,
});

const recipeOperationInputNamesSchema = z
  .array(recipeInputNameSchema)
  .max(MAXIMUM_RECIPE_INPUTS)
  .refine(uniqueInCanonicalOrder, "Expected unique operation input names in canonical order.");
export const recipeRunOperationSchema = z.strictObject({
  inputNames: recipeOperationInputNamesSchema,
  kind: z.literal("run"),
  name: recipeOperationNameSchema,
  outputContract: outputContractSchema,
  prompt: runPromptSchema,
});
export const recipeWorkflowOperationSchema = z.strictObject({
  inputNames: recipeOperationInputNamesSchema,
  kind: z.literal("workflow"),
  name: recipeOperationNameSchema,
  objective: z
    .string()
    .trim()
    .min(1)
    .max(4 * 1_024),
  outputContract: outputContractSchema,
  stages: z.array(agentWorkflowStagePlanSchema).min(2).max(8),
});
export const recipePrimaryOperationSchema = z.discriminatedUnion("kind", [
  recipeRunOperationSchema,
  recipeWorkflowOperationSchema,
]);

const recipeScheduleTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour local time in HH:mm form.");
const recipeScheduleTriggerSchema = z.union([
  z.strictObject({
    intervalSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60),
    type: z.literal("interval"),
  }),
  z.strictObject({
    at: recipeScheduleTimeSchema,
    frequency: z.literal("daily"),
    timeZone: z.literal("owner-selected"),
    type: z.literal("calendar"),
  }),
  z.strictObject({
    at: recipeScheduleTimeSchema,
    daysOfWeek: z
      .array(agentScheduleWeekdaySchema)
      .min(1)
      .max(7)
      .refine(
        (days) =>
          days.every(
            (day, index) =>
              index === 0 ||
              agentScheduleWeekdaySchema.options.indexOf(days[index - 1] ?? "monday") <
                agentScheduleWeekdaySchema.options.indexOf(day),
          ),
        "Expected unique weekdays in Monday-to-Sunday order.",
      ),
    frequency: z.literal("weekly"),
    timeZone: z.literal("owner-selected"),
    type: z.literal("calendar"),
  }),
  z.strictObject({
    at: recipeScheduleTimeSchema,
    dayOfMonth: z.number().int().min(1).max(31),
    frequency: z.literal("monthly"),
    timeZone: z.literal("owner-selected"),
    type: z.literal("calendar"),
  }),
]);

const recipeEventFilterValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(2_048),
  z.strictObject({ parameter: agentBlueprintParameterNameSchema }),
]);
const recipeEventFiltersSchema = z
  .record(z.string().min(1).max(128), recipeEventFilterValueSchema)
  .refine((filters) => Object.keys(filters).length <= 32, "Too many Recipe event filters.");

export const recipeScheduleSchema = z.strictObject({
  instruction: runPromptSchema,
  name: recipeOperationNameSchema,
  outputContract: outputContractSchema,
  trigger: recipeScheduleTriggerSchema,
});
export const recipeEventTriggerSchema = z.strictObject({
  connectionSlot: recipeConnectionSlotSchema,
  delivery: z.enum(["provider_polling", "realtime"]),
  eventSlug: integrationToolSlugSchema,
  eventVersion: integrationToolkitVersionSchema,
  filters: recipeEventFiltersSchema,
  instruction: runPromptSchema,
  integration: integrationSlugSchema,
  name: recipeOperationNameSchema,
  outputContract: outputContractSchema,
});
export const recipeOperationsSchema = z.strictObject({
  eventTriggers: z
    .array(recipeEventTriggerSchema)
    .max(MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS)
    .refine(
      (eventTriggers) => uniqueInCanonicalOrder(eventTriggers.map(({ name }) => name)),
      "Expected unique Recipe Event Triggers in canonical name order.",
    ),
  primary: recipePrimaryOperationSchema,
  schedules: z
    .array(recipeScheduleSchema)
    .max(MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS)
    .refine(
      (schedules) => uniqueInCanonicalOrder(schedules.map(({ name }) => name)),
      "Expected unique Recipe Schedules in canonical name order.",
    ),
});

export const recipeSampleDeliverableSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    content: z.string().min(1).max(MAXIMUM_RECIPE_SAMPLE_CHARACTERS),
    kind: z.literal("markdown"),
  }),
  z.strictObject({ content: publicJsonObjectSchema, kind: z.literal("json") }),
]);

export const recipeResponsibilitySchema = z.strictObject({
  boundaries: z
    .array(z.string().trim().min(1).max(320))
    .max(MAXIMUM_RECIPE_BOUNDARIES)
    .refine((boundaries) => new Set(boundaries).size === boundaries.length, "Duplicate boundary."),
  outcome: z.string().trim().min(1).max(2_048),
  summary: z.string().trim().min(1).max(320),
  title: z.string().trim().min(1).max(80),
});

export const recipeDiscoverySchema = z.strictObject({
  description: z.string().trim().min(1).max(320),
  license: recipeLicenseSchema,
  provenance: skillProvenanceSchema,
  tags: z
    .array(
      z
        .string()
        .min(1)
        .max(40)
        .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Recipe tag."),
    )
    .max(12)
    .refine(uniqueInCanonicalOrder, "Expected unique Recipe tags in canonical order."),
});

export const recipePackageSchema = z
  .strictObject({
    agent: recipeAgentSchema,
    connections: recipeConnectionRequirementsSchema,
    discovery: recipeDiscoverySchema,
    inputs: recipeInputsSchema,
    name: recipeNameSchema,
    operations: recipeOperationsSchema,
    responsibility: recipeResponsibilitySchema,
    sampleDeliverable: recipeSampleDeliverableSchema,
    schemaVersion: z.literal(1),
    setupParameters: recipeSetupParametersSchema,
    skills: recipeSkillDependenciesSchema,
  })
  .superRefine((recipe, context) => {
    const parameterNames = recipe.setupParameters.map(({ name }) => name);
    const templatedStrings = [
      recipe.agent.suggestedName,
      recipe.agent.instructions,
      ...(recipe.operations.primary.kind === "run"
        ? [recipe.operations.primary.prompt]
        : [
            recipe.operations.primary.objective,
            ...recipe.operations.primary.stages.map(({ name, prompt }) => `${name}\n${prompt}`),
          ]),
      ...recipe.operations.eventTriggers.map(({ instruction }) => instruction),
      ...recipe.operations.schedules.map(({ instruction }) => instruction),
    ];
    const parameterReferences = templatedStrings.flatMap(referencedParameters);

    for (const eventTrigger of recipe.operations.eventTriggers) {
      for (const filter of Object.values(eventTrigger.filters)) {
        if (typeof filter === "object") parameterReferences.push(filter.parameter);
      }
    }

    if (new Set(parameterNames).size !== parameterNames.length) {
      context.addIssue({ code: "custom", message: "Recipe setup parameter names must be unique." });
    }
    if (parameterReferences.some((reference) => !parameterNames.includes(reference))) {
      context.addIssue({
        code: "custom",
        message: "Recipe references an unknown setup parameter.",
      });
    }
    if (parameterNames.some((name) => !parameterReferences.includes(name))) {
      context.addIssue({ code: "custom", message: "Every Recipe setup parameter must be used." });
    }

    const inputNames = new Set(recipe.inputs.map(({ name }) => name));
    if (recipe.operations.primary.inputNames.some((name) => !inputNames.has(name))) {
      context.addIssue({
        code: "custom",
        message: "Primary operation references an unknown input.",
      });
    }
    if (recipe.inputs.some(({ name }) => !recipe.operations.primary.inputNames.includes(name))) {
      context.addIssue({ code: "custom", message: "Every Recipe input must be used." });
    }

    const recurringOperationNames = [
      ...recipe.operations.eventTriggers.map(({ name }) => name),
      ...recipe.operations.schedules.map(({ name }) => name),
    ];
    if (
      recurringOperationNames.includes(recipe.operations.primary.name) ||
      new Set(recurringOperationNames).size !== recurringOperationNames.length
    ) {
      context.addIssue({ code: "custom", message: "Recipe operation names must be unique." });
    }
    if (
      recipe.operations.eventTriggers.length + recipe.operations.schedules.length >
      MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS
    ) {
      context.addIssue({
        code: "custom",
        message: `A Recipe may declare at most ${MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS} Schedules and Event Triggers in total.`,
      });
    }

    const primaryOutputKind = recipe.operations.primary.outputContract.kind;
    if (recipe.sampleDeliverable.kind !== primaryOutputKind) {
      context.addIssue({
        code: "custom",
        message: "Sample deliverable kind must match the primary operation output contract.",
      });
    }
    if (
      recipe.sampleDeliverable.kind === "json" &&
      recipe.operations.primary.outputContract.kind === "json" &&
      !validateJsonOutput(
        recipe.operations.primary.outputContract.schema.jsonSchema,
        recipe.sampleDeliverable.content,
      ).ok
    ) {
      context.addIssue({
        code: "custom",
        message: "Sample deliverable must satisfy the primary JSON output contract.",
      });
    }

    const composioConnections = new Map(
      recipe.connections
        .filter((connection) => connection.kind === "composio")
        .map((connection) => [connection.slot, connection.integration]),
    );
    for (const eventTrigger of recipe.operations.eventTriggers) {
      if (composioConnections.get(eventTrigger.connectionSlot) !== eventTrigger.integration) {
        context.addIssue({
          code: "custom",
          message: "Event Trigger must reference a matching Composio Connection slot.",
        });
      }
    }

    if (serializedBytes(recipe) > MAXIMUM_RECIPE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Recipe package exceeds its serialized byte budget.",
      });
    }
  })
  .describe(
    "An immutable bounded untrusted Recipe declaration without credentials, owner-local IDs, grants, private Briefs, history, telemetry, or executable code.",
  );

export const registryArtifactLifecycleSchema = z.enum(["published", "restricted", "retired"]);
export const registryReviewStateSchema = z.enum(["featured", "reviewed", "unreviewed"]);
export const registryPublisherSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  namespace: recipePublisherNamespaceSchema,
  profileUrl: safePublicUrlSchema.optional(),
});

export const registrySkillWarningCountsSchema = z.strictObject({
  activeMarkdown: z.number().int().nonnegative().safe(),
  executableContent: z.number().int().nonnegative().safe(),
  hiddenText: z.number().int().nonnegative().safe(),
  obfuscatedContent: z.number().int().nonnegative().safe(),
  suspectedPrivateIdentifiers: z.number().int().nonnegative().safe(),
  suspectedSecrets: z.number().int().nonnegative().safe(),
});

const registryProjectionBase = {
  contentTrust: z.literal("untrusted"),
  lifecycle: registryArtifactLifecycleSchema,
  publishedAt: z.iso.datetime(),
  publisher: registryPublisherSchema,
  review: registryReviewStateSchema,
  updatedAt: z.iso.datetime(),
};

export const recipeRegistryProjectionSchema = z
  .strictObject({
    ...registryProjectionBase,
    artifact: registryArtifactCoordinateSchema.extend({ kind: z.literal("recipe") }),
    effectiveAuthority: z.strictObject({
      approvalRequired: z.strictObject({
        destructive: z.number().int().nonnegative().safe(),
        read: z.number().int().nonnegative().safe(),
        write: z.number().int().nonnegative().safe(),
      }),
      standing: z.strictObject({
        destructive: z.literal(0),
        read: z.number().int().nonnegative().safe(),
        write: z.number().int().nonnegative().safe(),
      }),
    }),
    description: recipeDiscoverySchema.shape.description,
    deliverables: z
      .array(z.enum(["json", "markdown"]))
      .min(1)
      .max(2)
      .refine(uniqueInCanonicalOrder, "Expected unique deliverable kinds in canonical order."),
    limits: agentExecutionLimitsSchema,
    operations: z.strictObject({
      eventTriggers: z
        .number()
        .int()
        .nonnegative()
        .max(MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS),
      primary: z.enum(["run", "workflow"]),
      schedules: z.number().int().nonnegative().max(MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS),
    }),
    outcome: recipeResponsibilitySchema.shape.outcome,
    package: registryArtifactDescriptorSchema,
    requirements: z.strictObject({
      capabilityIds: z
        .array(z.string().min(3).max(80))
        .max(16)
        .refine(uniqueInCanonicalOrder, "Expected canonical unique capability IDs."),
      integrations: z
        .array(integrationSlugSchema)
        .max(MAXIMUM_RECIPE_CONNECTIONS)
        .refine(uniqueInCanonicalOrder, "Expected canonical unique integration slugs."),
      remoteMcpServers: z
        .array(remoteMcpEndpointSchema)
        .max(MAXIMUM_RECIPE_CONNECTIONS)
        .refine(uniqueInCanonicalOrder, "Expected canonical unique remote MCP servers."),
      skills: z.strictObject({
        optional: z.number().int().nonnegative().max(MAXIMUM_RECIPE_SKILLS),
        required: z.number().int().nonnegative().max(MAXIMUM_RECIPE_SKILLS),
      }),
    }),
    summary: recipeResponsibilitySchema.shape.summary,
    tags: recipeDiscoverySchema.shape.tags,
    title: recipeResponsibilitySchema.shape.title,
  })
  .superRefine((projection, context) => {
    if (projection.artifact.namespace !== projection.publisher.namespace) {
      context.addIssue({
        code: "custom",
        message: "Recipe artifact namespace must match its publisher namespace.",
        path: ["artifact", "namespace"],
      });
    }
    if (
      projection.operations.eventTriggers + projection.operations.schedules >
      MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS
    ) {
      context.addIssue({
        code: "custom",
        message: `A Recipe projection may describe at most ${MAXIMUM_RECIPE_SCHEDULES_AND_EVENT_TRIGGERS} Schedules and Event Triggers.`,
        path: ["operations"],
      });
    }
    if (
      projection.requirements.skills.optional + projection.requirements.skills.required >
      MAXIMUM_RECIPE_SKILLS
    ) {
      context.addIssue({
        code: "custom",
        message: `A Recipe projection may describe at most ${MAXIMUM_RECIPE_SKILLS} Skills.`,
        path: ["requirements", "skills"],
      });
    }
    if (
      projection.requirements.integrations.length +
        projection.requirements.remoteMcpServers.length >
      MAXIMUM_RECIPE_CONNECTIONS
    ) {
      context.addIssue({
        code: "custom",
        message: `A Recipe projection may describe at most ${MAXIMUM_RECIPE_CONNECTIONS} Connection kinds.`,
        path: ["requirements"],
      });
    }
  });

export const registrySkillProjectionSchema = z
  .strictObject({
    ...registryProjectionBase,
    artifact: registryArtifactCoordinateSchema.extend({ kind: z.literal("skill") }),
    description: skillDescriptionSchema,
    fileCount: z.number().int().min(1).max(64),
    license: recipeLicenseSchema,
    package: registryArtifactDescriptorSchema.extend({
      sizeBytes: z.number().int().positive().max(MAXIMUM_SKILL_PACKAGE_BYTES),
    }),
    warnings: registrySkillWarningCountsSchema,
  })
  .refine(({ artifact, publisher }) => artifact.namespace === publisher.namespace, {
    message: "Skill artifact namespace must match its publisher namespace.",
    path: ["artifact", "namespace"],
  });

export const registryArtifactVersionEnvelopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      contentTrust: z.literal("untrusted"),
      coordinate: registryArtifactCoordinateSchema.extend({ kind: z.literal("recipe") }),
      kind: z.literal("recipe"),
      lifecycle: registryArtifactLifecycleSchema,
      package: registryArtifactDescriptorSchema,
      publishedAt: z.iso.datetime(),
      publisher: registryPublisherSchema,
      review: registryReviewStateSchema,
    }),
    z.strictObject({
      contentTrust: z.literal("untrusted"),
      coordinate: registryArtifactCoordinateSchema.extend({ kind: z.literal("skill") }),
      kind: z.literal("skill"),
      lifecycle: registryArtifactLifecycleSchema,
      package: registryArtifactDescriptorSchema.extend({
        sizeBytes: z.number().int().positive().max(MAXIMUM_SKILL_PACKAGE_BYTES),
      }),
      publishedAt: z.iso.datetime(),
      publisher: registryPublisherSchema,
      review: registryReviewStateSchema,
    }),
  ])
  .refine(({ coordinate, publisher }) => coordinate.namespace === publisher.namespace, {
    message: "Artifact coordinate namespace must match its publisher namespace.",
    path: ["coordinate", "namespace"],
  });

export type RegistryArtifactCoordinate = z.infer<typeof registryArtifactCoordinateSchema>;
export type RegistryArtifactVersionEnvelope = z.infer<typeof registryArtifactVersionEnvelopeSchema>;
export type RecipePackage = z.infer<typeof recipePackageSchema>;
export type RecipeRegistryProjection = z.infer<typeof recipeRegistryProjectionSchema>;
export type RecipeSkillDependency = z.infer<typeof recipeSkillDependencySchema>;
export type RegistrySkillPackage = z.infer<typeof registrySkillPackageSchema>;
export type RegistrySkillProjection = z.infer<typeof registrySkillProjectionSchema>;
