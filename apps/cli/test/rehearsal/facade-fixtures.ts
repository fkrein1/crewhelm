import * as z from "zod";

interface ToolCall {
  arguments: unknown;
  name: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = z.looseObject({}).safeParse(value);
  return parsed.success ? parsed.data : {};
}

function restoreRequestKey(fields: Record<string, unknown>): Record<string, unknown> {
  const { requestKey, ...rest } = fields;
  return requestKey === undefined ? rest : { ...rest, idempotencyKey: requestKey };
}

function commandFixture(name: string, arguments_: Record<string, unknown>): ToolCall {
  return { arguments: arguments_, name };
}

/** Restore the command-shaped fixture inputs used by the existing rehearsal harnesses. */
export function commandFixtureCall(call: ToolCall): ToolCall {
  const input = objectValue(call.arguments);
  const operation = objectValue(input.operation);
  const { kind, ...rawFields } = operation;
  const fields = restoreRequestKey(rawFields);
  const command = (name: string, arguments_ = fields) => commandFixture(name, arguments_);

  if (call.name === "crewhelm_inspect_agents") {
    return command(
      kind === "list"
        ? "crewhelm_list_agents"
        : kind === "inspect"
          ? "crewhelm_get_agent"
          : kind === "list_revisions"
            ? "crewhelm_list_agent_revisions"
            : "crewhelm_get_agent_revision",
    );
  }

  if (call.name === "crewhelm_change_agents") {
    if (kind === "create") return command("crewhelm_create_agent");
    const agents = Array.isArray(fields.agents)
      ? fields.agents.map((agent) => {
          const value = objectValue(agent);
          return { agentId: value.id, expectedRevision: value.revision };
        })
      : [];
    return command("crewhelm_batch_disable_agents", { ...fields, agents });
  }

  if (call.name === "crewhelm_inspect_work") {
    if (kind === "inspect_run") return command("crewhelm_inspect_run");
    if (kind === "list_runs") return command("crewhelm_list_agent_runs");
    if (kind === "list_approvals") return command("crewhelm_list_run_tool_approvals");
    if (kind === "list_inbox" || kind === "inbox_overview") {
      return command("crewhelm_agent_inbox", {
        action: kind === "inbox_overview" ? "overview" : "list",
        ...fields,
      });
    }
    if (kind === "list_workflows" || kind === "inspect_workflow") {
      return command("crewhelm_agent_workflows", {
        action: kind === "list_workflows" ? "list" : "inspect",
        ...fields,
      });
    }
  }

  if (call.name === "crewhelm_change_work") {
    if (kind === "cancel_run") return command("crewhelm_cancel_run");
    if (kind === "run") {
      const { agent, message, ...run } = fields;
      const reference = objectValue(agent);
      return command("crewhelm_start_run", {
        ...run,
        agentId: reference.id,
        expectedRevision: reference.revision,
        prompt: message,
      });
    }
    if (kind === "start_workflow") {
      const { agent, ...workflow } = fields;
      const reference = objectValue(agent);
      return command("crewhelm_agent_workflows", {
        action: "start",
        ...workflow,
        agentId: reference.id,
        expectedRevision: reference.revision,
      });
    }
    if (kind === "cancel_workflow" || kind === "delete_workflow") {
      const { workflow, ...rest } = fields;
      const reference = objectValue(workflow);
      return command("crewhelm_agent_workflows", {
        action: kind === "cancel_workflow" ? "cancel" : "delete",
        ...rest,
        expectedRevision: reference.revision,
        workflowId: reference.workflowId,
      });
    }
  }

  if (call.name === "crewhelm_inspect_context") {
    const targetKind = {
      inspect_blueprint: "agent-blueprint-package",
      inspect_capabilities: "agent-capability",
      inspect_fleet: "fleet",
      inspect_skill: "skill-package",
      list_blueprints: "agent-blueprint-catalog",
      list_skills: "skill-catalog",
    }[String(kind)];
    if (targetKind !== undefined) {
      return command("crewhelm_get_config", { target: { kind: targetKind, ...fields } });
    }
  }

  if (call.name === "crewhelm_inspect_automations") {
    if (kind === "list_schedules") {
      const { agent, ...rest } = fields;
      return command("crewhelm_list_agent_schedules", {
        ...rest,
        agentId: objectValue(agent).id,
      });
    }
    if (kind === "inspect_schedule") {
      const { schedule, ...rest } = fields;
      const reference = objectValue(schedule);
      return command("crewhelm_get_agent_schedule", {
        ...rest,
        agentId: reference.agentId,
        scheduleId: reference.id,
      });
    }
  }

  if (call.name === "crewhelm_change_automations") {
    if (kind === "create_schedule") {
      const { agent, schedule, ...rest } = fields;
      const reference = objectValue(agent);
      return command("crewhelm_configure_agent_schedule", {
        ...rest,
        agentId: reference.id,
        expectedAgentRevision: reference.revision,
        expectedScheduleRevision: null,
        schedule,
        scheduleId: null,
      });
    }
    if (kind === "pause_schedule" || kind === "update_schedule") {
      const { definition, schedule, ...rest } = fields;
      const reference = objectValue(schedule);
      return command("crewhelm_configure_agent_schedule", {
        ...rest,
        agentId: reference.agentId,
        expectedAgentRevision: reference.agentRevision,
        expectedScheduleRevision: reference.revision,
        schedule: kind === "pause_schedule" ? null : definition,
        scheduleId: reference.id,
      });
    }
  }

  if (call.name === "crewhelm_inspect_connections") {
    if (kind === "inspect_action") return command("crewhelm_inspect_integration_tool");
    if (kind === "list_connections") return command("crewhelm_list_connections");
  }

  if (call.name === "crewhelm_change_connections") {
    if (kind === "inspect_provider_connection") {
      const { connection, ...rest } = fields;
      return command("crewhelm_list_connections", {
        ...rest,
        connectionId: objectValue(connection).connectionId,
      });
    }
    if (kind === "grant_provider_actions") {
      const { agent, connection, ...grant } = fields;
      const agentReference = objectValue(agent);
      return command("crewhelm_configure_agent_connection", {
        ...grant,
        agentId: agentReference.id,
        connectionId: objectValue(connection).connectionId,
        expectedRevision: agentReference.revision,
      });
    }
  }

  if (call.name === "crewhelm_inspect_recovery" && kind === "unresolved_effects") {
    return command("crewhelm_list_unresolved_tool_effects");
  }

  if (call.name === "crewhelm_recover") {
    if (kind === "disable_agent") {
      return command("crewhelm_revoke_authority", {
        agentId: objectValue(fields.agent).id,
        target: "agent",
      });
    }
    if (kind === "revoke_connection") {
      return command("crewhelm_revoke_authority", {
        connectionId: objectValue(fields.connection).connectionId,
        target: "connection",
      });
    }
    if (kind === "revoke_capability") {
      return command("crewhelm_revoke_authority", {
        grantId: objectValue(fields.grant).grantId,
        target: "capability",
      });
    }
  }

  return call;
}
