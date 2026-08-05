export const FACADE_OPERATION_DESCRIPTIONS = {
  acknowledge_inbox: "Acknowledge one exact non-approval inbox item version.",
  apply_fleet_change: "Apply one bounded fleet policy patch against its exact current revision.",
  apply_package: "Apply one confirmed Skill or Agent blueprint package draft.",
  authorize: "Create a short-lived GitHub authorization for one Recipe publication draft.",
  authorize_provider: "Create an authorization link for one enabled provider integration.",
  bind_brief: "Bind one exact Brief revision to a named Recipe input.",
  bind_connection: "Bind one provider Connection to a required Recipe slot.",
  browse_models:
    "Browse compact, pageable models and facets across Cloudflare-hosted and third-party providers.",
  cancel_run: "Cancel one Run before it dispatches an external tool effect.",
  cancel_workflow: "Stop future stages of one exact active Workflow revision.",
  connect_provider:
    "Resolve provider auth and return a Composio authorization link or, when required, a Crewhelm setup link for reusable app credentials.",
  connect_remote_mcp: "Create a public, API-key, bearer, or OAuth remote MCP Connection.",
  create: "Create an Agent from one bounded definition.",
  create_brief: "Create one bounded owner-provided text Brief.",
  add_model: "Inspect, preview, or enable one exact Cloudflare model ID.",
  create_event_trigger:
    "Create an Event Trigger that starts Runs from matching connected-app events for one exact Agent revision.",
  create_from_blueprint: "Preview or create a disabled Agent from one exact blueprint version.",
  create_schedule: "Create a recurring Schedule that starts Runs for one exact Agent revision.",
  decide_approval: "Approve or reject one exact sensitive tool action waiting in a Run.",
  delete_brief: "Delete one exact unreferenced Brief revision.",
  delete_conversation:
    "Delete one idle conversation and redact its retained prompts and inbox projections.",
  delete_event_trigger: "Permanently delete one exact Event Trigger revision.",
  delete_remote_mcp: "Delete one exact remote MCP Connection.",
  delete_workflow: "Delete one exact terminal Workflow revision and its isolated conversation.",
  disable: "Disable up to 25 exact Agent revisions.",
  disable_agent: "Immediately disable one exact Agent.",
  discard_install_draft: "Discard one Recipe installation draft.",
  discard_package_draft: "Discard one Skill or Agent blueprint package draft.",
  discard_publish_draft: "Discard one Recipe publication draft.",
  enable_provider:
    "Resolve auth readiness, reuse an owner-held config, create credential-free or managed auth, or return a Crewhelm setup link for reusable app credentials.",
  event_history: "List bounded delivery history for one exact Event Trigger.",
  event_sources: "List Event Trigger sources available through one exact Connection.",
  grant_provider_actions: "Grant one Agent revision selected actions from one provider Connection.",
  grant_remote_mcp:
    "Grant one Agent revision selected tools from one remote MCP Connection snapshot.",
  inbox_overview: "Summarize matching inbox items without returning individual previews.",
  inspect_action: "Inspect the exact parameter schema for one provider action version.",
  inspect_blueprint: "Inspect one exact Agent blueprint package version.",
  inspect_brief: "Inspect current metadata for one exact Brief without reading its content.",
  inspect_brief_revision: "Inspect metadata for one exact immutable Brief revision.",
  inspect_capabilities: "Inspect the available Agent capability modules and configuration schemas.",
  inspect_conversation: "Inspect one exact retained Agent conversation.",
  inspect_event_trigger: "Inspect one exact Event Trigger.",
  inspect_fleet: "Inspect current fleet policy, capacity, retention, and execution defaults.",
  inspect_model: "Inspect one exact current Cloudflare model ID.",
  inspect_provider_auth:
    "Inspect whether one provider is ready, requires an auth-config choice, or needs owner setup without reserving an effect.",
  inspect_provider_connection: "Inspect one exact provider Connection.",
  inspect_remote_mcp: "Inspect one exact remote MCP Connection and tool snapshot.",
  inspect_revision: "Inspect one exact immutable Agent revision.",
  inspect_run: "Inspect one exact Run and its bounded retained detail.",
  inspect_schedule: "Inspect one exact Schedule.",
  inspect_section: "Inspect one named section of a Recipe publication draft.",
  inspect_skill: "Inspect one exact owner-local Skill package version.",
  inspect_workflow:
    "Inspect one exact Workflow without fetching prompts or deliverable content by default.",
  install: "Install one confirmed Recipe draft and create its disabled Agent.",
  list: "List Agents with compact current-revision metadata.",
  list_approvals: "List sensitive tool actions waiting for an owner decision.",
  list_auth_configs:
    "List bounded owner-held auth-config references; inspect provider auth for current activity.",
  list_blueprints: "List available owner-local Agent blueprints.",
  list_briefs: "List compact Brief metadata without reading content.",
  list_connections: "List compact provider and remote MCP Connection metadata.",
  list_conversations: "List retained conversations for one exact Agent.",
  list_event_triggers: "List Event Triggers for one exact Agent.",
  list_inbox: "List bounded matching inbox items with compact untrusted previews.",
  list_revisions: "List immutable revisions for one exact Agent.",
  list_runs: "List bounded Runs, optionally filtered by Agent, state, or creation time.",
  list_schedules: "List Schedules for one exact Agent.",
  list_skills: "List available owner-local Skills.",
  list_enabled_models: "List owner-enabled model IDs and the default.",
  list_workflows: "List bounded Workflows, optionally filtered by Agent or state.",
  pause_event_trigger:
    "Stop an existing Event Trigger from starting Runs without deleting its definition.",
  pause_schedule: "Stop an existing Schedule from starting Runs without deleting its definition.",
  prepare: "Copy one exact Agent revision into a reviewable Recipe publication draft.",
  prepare_blueprint: "Create or replace a bounded Agent blueprint package draft for review.",
  prepare_install: "Create a reviewable installation draft for one exact public Recipe.",
  prepare_skill: "Create or replace a bounded Skill package draft for review.",
  preview_fleet_change: "Preview one bounded fleet policy patch without applying it.",
  preview_install:
    "Preview the Agent, authority, bindings, and limits produced by one installation draft.",
  preview_or_publish:
    "Preview one exact public Recipe package, then publish the unchanged digest immediately when the owner already requested publication.",
  preview_package:
    "Preview one Skill or Agent blueprint package draft and its confirmation digest.",
  read_brief: "Read the content of one exact immutable Brief revision.",
  read_skill: "Read one text file from an exact public Skill package.",
  remove_model: "Preview impacted Agents, then disable one model without rewriting history.",
  reauthenticate_remote_mcp:
    "Create a new authentication setup for one exact remote MCP Connection snapshot.",
  reconcile_effect:
    "Record an independently verified external tool effect as applied or not applied.",
  recover_install: "Recover the state of one exact Recipe installation attempt.",
  replace: "Replace one exact Agent revision with a new immutable definition.",
  resume_event_trigger:
    "Resume a paused Event Trigger so matching connected-app events can start Runs again.",
  retire_blueprint: "Preview or retire one exact Agent blueprint version.",
  retire_skill: "Preview or retire one exact Skill version.",
  revoke_capability: "Permanently revoke one exact Agent capability grant.",
  revoke_connection: "Permanently revoke one exact provider or remote MCP Connection.",
  revise_brief: "Create a new immutable revision of one exact Brief.",
  run: "Start or continue one owner-private conversation with an exact Agent revision.",
  search: "Search immutable public Recipes by bounded text query.",
  search_actions: "Search provider actions, optionally within one known integration.",
  search_models: "Search detailed Workers AI metadata by name, provider, task, or capability.",
  search_providers: "Search the complete integration provider catalog.",
  select_operations:
    "Choose the Schedule and Event Trigger operations for one Recipe installation draft.",
  select_optional_skill:
    "Include or exclude one optional public Skill in a Recipe installation draft.",
  set_connections: "Replace the portable Connection requirements in a Recipe publication draft.",
  set_discovery: "Replace the public discovery metadata in a Recipe publication draft.",
  set_event_triggers: "Replace the Event Trigger declarations in a Recipe publication draft.",
  set_inputs: "Replace the named public inputs in a Recipe publication draft.",
  set_name: "Replace the public Recipe name in a publication draft.",
  set_default_model: "Preview or change the owner's default model.",
  set_primary_operation: "Replace the primary operation in a Recipe publication draft.",
  set_responsibility: "Replace the Agent responsibility in a Recipe publication draft.",
  set_sample_deliverable: "Replace the sample deliverable in a Recipe publication draft.",
  set_schedules: "Replace the Schedule declarations in a Recipe publication draft.",
  set_setup: "Set one declared setup parameter in a Recipe installation draft.",
  set_setup_parameters: "Replace the setup parameter declarations in a Recipe publication draft.",
  set_skill_decision:
    "Choose how to publish, reference, or remove one Skill already attached to the source Agent.",
  start_workflow: "Start two to eight ordered Agent Runs under one durable objective.",
  unresolved_effects:
    "List unresolved external tool effects that require independent verification.",
  update_event_trigger:
    "Replace an existing Event Trigger definition using its current Agent and trigger revisions.",
  update_schedule:
    "Replace an existing Schedule's timing, instruction, Briefs, or output contract using its current revisions.",
} as const;

export type FacadeOperationKind = keyof typeof FACADE_OPERATION_DESCRIPTIONS | "inspect";

export function facadeOperationDescription(toolName: string, kind: FacadeOperationKind): string {
  if (kind !== "inspect") return FACADE_OPERATION_DESCRIPTIONS[kind];

  switch (toolName) {
    case "crewhelm_inspect_agents":
      return "Inspect the current definition and exact immutable revision of one Agent.";
    case "crewhelm_inspect_recipes":
      return "Inspect one exact immutable public Recipe.";
    default:
      throw new Error("Crewhelm inspect operation is missing a facade-specific description.");
  }
}
