import { describe, expect, it } from "vitest";
import * as z from "zod";

import { FACADE_TOOL_DEFINITIONS } from "./facade-definitions.js";
import {
  FACADE_OPERATION_DESCRIPTIONS,
  facadeOperationDescription,
} from "./facade-operation-descriptions.js";

const EXPECTED_FACADE_OPERATIONS = {
  crewhelm_change_agents: ["create", "replace", "disable"],
  crewhelm_change_automations: [
    "create_schedule",
    "update_schedule",
    "pause_schedule",
    "create_event_trigger",
    "update_event_trigger",
    "pause_event_trigger",
    "resume_event_trigger",
    "delete_event_trigger",
  ],
  crewhelm_change_connections: [
    "enable_provider",
    "authorize_provider",
    "connect_provider",
    "inspect_provider_connection",
    "grant_provider_actions",
    "connect_remote_mcp",
    "inspect_remote_mcp",
    "reauthenticate_remote_mcp",
    "delete_remote_mcp",
    "grant_remote_mcp",
  ],
  crewhelm_change_context: [
    "preview_fleet_change",
    "prepare_skill",
    "retire_skill",
    "prepare_blueprint",
    "retire_blueprint",
    "create_from_blueprint",
    "preview_package",
    "apply_package",
    "discard_package_draft",
    "create_brief",
    "revise_brief",
    "delete_brief",
  ],
  crewhelm_change_recipes: [
    "prepare_install",
    "set_setup",
    "bind_connection",
    "bind_brief",
    "select_optional_skill",
    "select_operations",
    "preview_install",
    "install",
    "discard_install_draft",
    "recover_install",
  ],
  crewhelm_change_work: [
    "run",
    "cancel_run",
    "decide_approval",
    "acknowledge_inbox",
    "start_workflow",
    "cancel_workflow",
    "delete_workflow",
    "delete_conversation",
  ],
  crewhelm_inspect_agents: ["list", "inspect", "list_revisions", "inspect_revision"],
  crewhelm_inspect_automations: [
    "list_schedules",
    "inspect_schedule",
    "event_sources",
    "list_event_triggers",
    "inspect_event_trigger",
    "event_history",
  ],
  crewhelm_inspect_connections: [
    "search_providers",
    "search_actions",
    "inspect_action",
    "inspect_provider_auth",
    "list_auth_configs",
    "list_connections",
  ],
  crewhelm_inspect_context: [
    "inspect_fleet",
    "inspect_capabilities",
    "list_skills",
    "inspect_skill",
    "list_blueprints",
    "inspect_blueprint",
    "list_briefs",
    "inspect_brief",
    "inspect_brief_revision",
    "read_brief",
  ],
  crewhelm_inspect_recipes: ["search", "inspect", "read_skill"],
  crewhelm_inspect_recovery: ["unresolved_effects"],
  crewhelm_inspect_work: [
    "inspect_run",
    "list_runs",
    "list_approvals",
    "list_conversations",
    "inspect_conversation",
    "list_workflows",
    "inspect_workflow",
    "list_inbox",
    "inbox_overview",
  ],
  crewhelm_publish_recipe: [
    "prepare",
    "inspect_section",
    "set_connections",
    "set_discovery",
    "set_inputs",
    "set_name",
    "set_event_triggers",
    "set_primary_operation",
    "set_schedules",
    "set_responsibility",
    "set_sample_deliverable",
    "set_setup_parameters",
    "set_skill_decision",
    "authorize",
    "preview_or_publish",
    "discard_publish_draft",
  ],
  crewhelm_recover: ["reconcile_effect", "disable_agent", "revoke_connection", "revoke_capability"],
} as const;

function operation(toolName: string, operationName: string) {
  const definition = FACADE_TOOL_DEFINITIONS.find(({ name }) => name === toolName);
  const selected = definition?.operations.find(({ kind }) => kind === operationName);

  if (selected === undefined) throw new Error(`Missing ${toolName}.${operationName}`);
  return selected;
}

function exposedField(toolName: string, operationName: string, fieldName: string): z.ZodType {
  const selected = operation(toolName, operationName);
  const field = selected.publicSchema?.shape[fieldName] ?? selected.publicFields?.[fieldName];

  if (!(field instanceof z.ZodType)) {
    throw new Error(`Missing ${toolName}.${operationName}.${fieldName}`);
  }
  return field;
}

describe("MCP facade definitions", () => {
  it("requires an intentional test change for every facade operation addition or removal", () => {
    expect(
      Object.fromEntries(
        FACADE_TOOL_DEFINITIONS.map(({ name, operations }) => [
          name,
          operations.map(({ kind }) => kind),
        ]),
      ),
    ).toEqual(EXPECTED_FACADE_OPERATIONS);
  });

  it("has one complete, used, concise description for every operation kind", () => {
    const usedKinds = new Set<string>();

    for (const definition of FACADE_TOOL_DEFINITIONS) {
      const descriptions = definition.operations.map(({ kind }) => {
        if (kind !== "inspect") usedKinds.add(kind);
        return facadeOperationDescription(definition.name, kind);
      });

      expect(new Set(descriptions).size).toBe(descriptions.length);
      for (const description of descriptions) {
        expect(description.length).toBeLessThanOrEqual(160);
        expect(description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim()).toBe(description);
      }
    }

    expect([...usedKinds].toSorted()).toEqual(
      Object.keys(FACADE_OPERATION_DESCRIPTIONS).toSorted(),
    );
  });

  it("keeps every definition internally coherent", () => {
    const invalidAliases: string[] = [];
    const invalidFieldFilters: string[] = [];
    const invalidPrivateTools: string[] = [];

    expect(new Set(FACADE_TOOL_DEFINITIONS.map(({ name }) => name)).size).toBe(
      FACADE_TOOL_DEFINITIONS.length,
    );

    for (const definition of FACADE_TOOL_DEFINITIONS) {
      expect(definition.operations.length).toBeGreaterThan(0);
      expect(new Set(definition.operations.map(({ kind }) => kind)).size).toBe(
        definition.operations.length,
      );

      const operationKinds = new Set(definition.operations.map(({ kind }) => kind));
      for (const selected of definition.operations) {
        if (!selected.privateTool.startsWith("crewhelm_")) {
          invalidPrivateTools.push(`${definition.name}.${selected.kind}`);
        }
        if (
          selected.schemaAlias !== undefined &&
          ![...operationKinds].some((kind) => kind === selected.schemaAlias)
        ) {
          invalidAliases.push(`${definition.name}.${selected.kind} -> ${selected.schemaAlias}`);
        }
        if (selected.only !== undefined) {
          invalidFieldFilters.push(
            ...(selected.omit ?? [])
              .filter((field) => !selected.only?.includes(field))
              .map((field) => `${definition.name}.${selected.kind}.${field}`),
          );
        }
      }
    }

    expect(invalidAliases).toEqual([]);
    expect(invalidFieldFilters).toEqual([]);
    expect(invalidPrivateTools).toEqual([]);
  });

  it("exposes constructible schemas for every formerly opaque authoring value", () => {
    const fields = [
      ["crewhelm_change_automations", "create_schedule", "schedule"],
      ["crewhelm_change_automations", "create_event_trigger", "eventTrigger"],
      ["crewhelm_change_work", "start_workflow", "outputContract"],
      ["crewhelm_change_context", "preview_fleet_change", "patch"],
      ["crewhelm_change_context", "prepare_skill", "package"],
      ["crewhelm_change_context", "prepare_blueprint", "package"],
      ["crewhelm_publish_recipe", "set_event_triggers", "value"],
      ["crewhelm_publish_recipe", "set_primary_operation", "value"],
      ["crewhelm_publish_recipe", "set_schedules", "value"],
      ["crewhelm_publish_recipe", "set_sample_deliverable", "value"],
    ] as const;

    for (const [toolName, operationName, fieldName] of fields) {
      const schema = z.toJSONSchema(exposedField(toolName, operationName, fieldName), {
        io: "input",
      });
      const serialized = JSON.stringify(schema);

      expect(serialized).toMatch(/"(type|anyOf|oneOf)"/);
      expect(serialized).not.toContain("Crewhelm validates its exact contract");
    }
  });
});
