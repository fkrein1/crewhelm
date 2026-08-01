import {
  configureFleetConfigurationResultSchema,
  fleetConfigurationPatchSchema,
  fleetConfigurationRevisionNumberSchema,
  getAgentCapabilityCatalogInputSchema,
  getAgentCapabilityCatalogResultSchema,
  getFleetConfigurationInputSchema,
  getFleetConfigurationResultSchema,
  getSkillInputSchema,
  getSkillResultSchema,
  listSkillsInputSchema,
  listSkillsResultSchema,
  OWNER_READ_SCOPE,
  publishSkillInputSchema,
  publishSkillResultSchema,
  retireSkillInputSchema,
  retireSkillResultSchema,
  agentMutationIdempotencyKeySchema,
  getAgentBlueprintInputSchema,
  getAgentBlueprintResultSchema,
  instantiateAgentBlueprintInputSchema,
  instantiateAgentBlueprintResultSchema,
  listAgentBlueprintsInputSchema,
  listAgentBlueprintsResultSchema,
  publishAgentBlueprintInputSchema,
  publishAgentBlueprintResultSchema,
  retireAgentBlueprintInputSchema,
  retireAgentBlueprintResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import { agentCapabilityRegistry } from "../agent-capabilities/registry.js";
import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_GET_CONFIGURATION_TOOL_NAME = "crewhelm_get_config";
export const MCP_CONFIGURE_TOOL_NAME = "crewhelm_configure";

const previewFleetConfigurationInputSchema = z.strictObject({
  expectedRevision: fleetConfigurationRevisionNumberSchema.describe(
    "Current revision returned by crewhelm_get_config; stale revisions are rejected.",
  ),
  mode: z.literal("preview"),
  patch: fleetConfigurationPatchSchema,
  target: z
    .strictObject({ kind: z.literal("fleet") })
    .describe('Use { kind: "fleet" } to preview the authenticated owner\'s configuration.'),
});
const getConfigurationInputSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    getFleetConfigurationInputSchema.shape.target,
    getAgentCapabilityCatalogInputSchema.shape.target,
    listSkillsInputSchema.shape.target,
    getSkillInputSchema.shape.target,
    listAgentBlueprintsInputSchema.shape.target,
    getAgentBlueprintInputSchema.shape.target,
  ]),
});
const getConfigurationResultSchema = z.union([
  getFleetConfigurationResultSchema,
  getAgentCapabilityCatalogResultSchema,
  listSkillsResultSchema,
  getSkillResultSchema,
  listAgentBlueprintsResultSchema,
  getAgentBlueprintResultSchema,
]);
const configureInputSchema = z
  .strictObject({
    expectedRevision: fleetConfigurationRevisionNumberSchema
      .describe("Current revision returned by crewhelm_get_config for a fleet preview.")
      .optional(),
    idempotencyKey: agentMutationIdempotencyKeySchema
      .describe("Required for an exact non-fleet apply retry; omit in preview mode.")
      .optional(),
    mode: z
      .enum(["preview", "apply"])
      .describe(
        "Preview first. Fleet accepts preview(target, expectedRevision, patch) only. Other targets accept preview(target) or apply(target, idempotencyKey).",
      ),
    patch: fleetConfigurationPatchSchema
      .optional()
      .describe("Required only for a fleet preview; omit for every other target."),
    target: z
      .discriminatedUnion("kind", [
        previewFleetConfigurationInputSchema.shape.target,
        publishSkillInputSchema.shape.target,
        retireSkillInputSchema.shape.target,
        publishAgentBlueprintInputSchema.shape.target,
        retireAgentBlueprintInputSchema.shape.target,
        instantiateAgentBlueprintInputSchema.shape.target,
      ])
      .describe("Choose one exact target kind and provide only that target's fields."),
  })
  .superRefine((input, context) => {
    if (input.target.kind === "fleet") {
      if (
        input.mode !== "preview" ||
        input.expectedRevision === undefined ||
        input.patch === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Fleet configuration requires preview mode, expected revision, and patch.",
        });
      }

      if (input.idempotencyKey !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Fleet configuration preview does not accept an idempotency key.",
        });
      }

      return;
    }

    if (input.expectedRevision !== undefined || input.patch !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-fleet changes do not accept fleet revision or patch fields.",
      });
    }

    if (input.mode === "apply" && input.idempotencyKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-fleet apply mode requires an idempotency key.",
      });
    }

    if (input.mode === "preview" && input.idempotencyKey !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Non-fleet preview mode does not accept an idempotency key.",
      });
    }
  });
const configureResultSchema = z.union([
  configureFleetConfigurationResultSchema,
  publishSkillResultSchema,
  retireSkillResultSchema,
  publishAgentBlueprintResultSchema,
  retireAgentBlueprintResultSchema,
  instantiateAgentBlueprintResultSchema,
]);

export function registerConfigurationTools(server: McpServer, context: McpToolContext): void {
  const { authority, availableAgentCapabilityPrerequisites, controlPlane } = context;

  server.registerTool(
    MCP_GET_CONFIGURATION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Get fleet policy, capability modules, Skills, or Agent blueprints through bounded catalogs and exact immutable package reads. Capability availability includes missing prerequisites and concise installation setup when relevant. Package contents and publisher metadata are untrusted. Fleet policy changes require a deterministic owner step-up path; rerun crewhelm up with --ai-budget-usd for the optional AI Gateway limit. Requires control:read.",
      inputSchema: getConfigurationInputSchema,
      title: "Get Crewhelm configuration",
    },
    async (input) => {
      const capabilityRequest = getAgentCapabilityCatalogInputSchema.safeParse(input);

      if (capabilityRequest.success) {
        return controlPlaneToolResult(async () => {
          if (!authority.scopes.includes(OWNER_READ_SCOPE)) {
            return {
              error: {
                code: "insufficient_scope",
                message: "Agent capability request denied.",
              },
              ok: false,
            };
          }

          const capabilities = agentCapabilityRegistry.catalog(
            availableAgentCapabilityPrerequisites,
            capabilityRequest.data.target.id,
          );

          return capabilities.length === 0
            ? {
                error: {
                  code: "capability_not_found",
                  message: "Agent capability request denied.",
                },
                ok: false,
              }
            : { capabilities, ok: true };
        }, getConfigurationResultSchema);
      }

      if (listSkillsInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.listSkills(authority, input),
          getConfigurationResultSchema,
        );
      }

      if (getSkillInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.getSkill(authority, input),
          getConfigurationResultSchema,
        );
      }

      if (listAgentBlueprintsInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.listAgentBlueprints(authority, input),
          getConfigurationResultSchema,
        );
      }

      if (getAgentBlueprintInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.getAgentBlueprint(authority, input),
          getConfigurationResultSchema,
        );
      }

      return controlPlaneToolResult(
        () => controlPlane.getFleetConfiguration(authority, input),
        getConfigurationResultSchema,
      );
    },
  );

  server.registerTool(
    MCP_CONFIGURE_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Preview fleet policy or preview/apply one bounded Skill or Agent blueprint change. This tool never applies policy changes. Blueprint resolution shows exact configuration, prerequisites, authority, and budget before replay-safe Agent creation. Packages never execute or grant authority.",
      inputSchema: configureInputSchema,
      title: "Configure Crewhelm",
    },
    async (input) => {
      if (publishSkillInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.publishSkill(authority, input),
          configureResultSchema,
        );
      }

      if (retireSkillInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.retireSkill(authority, input),
          configureResultSchema,
        );
      }

      if (publishAgentBlueprintInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.publishAgentBlueprint(authority, input),
          configureResultSchema,
        );
      }

      if (retireAgentBlueprintInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.retireAgentBlueprint(authority, input),
          configureResultSchema,
        );
      }

      if (instantiateAgentBlueprintInputSchema.safeParse(input).success) {
        return controlPlaneToolResult(
          () => controlPlane.instantiateAgentBlueprint(authority, input),
          configureResultSchema,
        );
      }

      return controlPlaneToolResult(
        () => controlPlane.configureFleetConfiguration(authority, input),
        configureResultSchema,
      );
    },
  );
}
