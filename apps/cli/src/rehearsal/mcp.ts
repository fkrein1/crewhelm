import * as z from "zod";

import { mcpControlPlaneStatusResultSchema } from "../mcp-result-schemas.js";
import {
  parseMcpToolResult,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolCallResponseSchema,
  type TemporaryOwnerMcpSession,
} from "../temporary-owner-session.js";

interface RehearsalToolCallOptions {
  acceptErrorResult?: boolean;
  timeoutMs?: number;
}

interface FacadeToolCall {
  arguments: Record<string, unknown>;
  name: string;
}

function objectInput(input: unknown): Record<string, unknown> {
  const parsed = z.looseObject({}).safeParse(input);
  return parsed.success ? parsed.data : {};
}

function withRequestKey(input: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey, ...fields } = input;
  return typeof idempotencyKey === "string" ? { ...fields, requestKey: idempotencyKey } : fields;
}

function facadeOperation(
  tool: string,
  kind: string,
  fields: Record<string, unknown>,
): FacadeToolCall {
  return {
    arguments: { operation: { kind, ...fields } },
    name: tool,
  };
}

/**
 * Rehearsals retain command-shaped fixtures so upgrade evidence stays comparable, but every live
 * call uses the public intent facade. This is a client adapter, not a server compatibility alias.
 */
export function facadeRehearsalToolCall(name: string, arguments_: unknown): FacadeToolCall {
  const input = objectInput(arguments_);
  const operation = (tool: string, kind: string, fields = input) =>
    facadeOperation(tool, kind, fields);

  switch (name) {
    case "crewhelm_list_agents":
      return operation("crewhelm_inspect_agents", "list");
    case "crewhelm_get_agent":
      return operation("crewhelm_inspect_agents", "inspect");
    case "crewhelm_list_agent_revisions":
      return operation("crewhelm_inspect_agents", "list_revisions");
    case "crewhelm_get_agent_revision":
      return operation("crewhelm_inspect_agents", "inspect_revision");
    case "crewhelm_create_agent":
      return operation("crewhelm_change_agents", "create", withRequestKey(input));
    case "crewhelm_batch_disable_agents": {
      const fields = withRequestKey(input);
      return operation("crewhelm_change_agents", "disable", {
        ...fields,
        agents: Array.isArray(fields.agents)
          ? fields.agents.map((agent) => {
              const value = objectInput(agent);
              return { id: value.agentId, revision: value.expectedRevision };
            })
          : [],
      });
    }
    case "crewhelm_inspect_run":
      return operation("crewhelm_inspect_work", "inspect_run");
    case "crewhelm_list_agent_runs":
      return operation("crewhelm_inspect_work", "list_runs");
    case "crewhelm_cancel_run":
      return operation("crewhelm_change_work", "cancel_run", withRequestKey(input));
    case "crewhelm_start_run": {
      const fields = withRequestKey(input);
      const { agentId, continuation: _continuation, expectedRevision, prompt, ...run } = fields;
      return operation("crewhelm_change_work", "run", {
        ...run,
        agent: { id: agentId, revision: expectedRevision },
        message: prompt,
      });
    }
    case "crewhelm_agent_workflows": {
      const fields = withRequestKey(input);
      const { action, agentId, expectedRevision, workflowId, ...workflow } = fields;
      if (action === "start") {
        return operation("crewhelm_change_work", "start_workflow", {
          ...workflow,
          agent: { id: agentId, revision: expectedRevision },
        });
      }
      if (action === "cancel" || action === "delete") {
        return operation("crewhelm_change_work", `${action}_workflow`, {
          ...workflow,
          workflow: { revision: expectedRevision, workflowId },
        });
      }
      return operation(
        "crewhelm_inspect_work",
        action === "list" ? "list_workflows" : "inspect_workflow",
        action === "list" ? workflow : { ...workflow, workflowId },
      );
    }
    case "crewhelm_agent_inbox": {
      const { action, ...fields } = input;
      return operation(
        action === "acknowledge" ? "crewhelm_change_work" : "crewhelm_inspect_work",
        action === "acknowledge"
          ? "acknowledge_inbox"
          : action === "overview"
            ? "inbox_overview"
            : "list_inbox",
        fields,
      );
    }
    case "crewhelm_get_config": {
      const { target, ...fields } = input;
      const targetFields = objectInput(target);
      const { kind, ...coordinates } = targetFields;
      const operationKind =
        {
          "agent-blueprint-catalog": "list_blueprints",
          "agent-blueprint-package": "inspect_blueprint",
          "agent-capability": "inspect_capabilities",
          fleet: "inspect_fleet",
          "skill-catalog": "list_skills",
          "skill-package": "inspect_skill",
        }[String(kind)] ?? "inspect_fleet";
      return operation("crewhelm_inspect_context", operationKind, { ...fields, ...coordinates });
    }
    case "crewhelm_list_agent_schedules": {
      const { agentId, ...fields } = input;
      return operation("crewhelm_inspect_automations", "list_schedules", {
        ...fields,
        agent: { id: agentId, revision: 1 },
      });
    }
    case "crewhelm_get_agent_schedule": {
      const { agentId, scheduleId, ...fields } = input;
      return operation("crewhelm_inspect_automations", "inspect_schedule", {
        ...fields,
        schedule: { agentId, agentRevision: 1, id: scheduleId, revision: 1 },
      });
    }
    case "crewhelm_configure_agent_schedule": {
      const fields = withRequestKey(input);
      const {
        agentId,
        expectedAgentRevision,
        expectedScheduleRevision,
        schedule,
        scheduleId,
        ...rest
      } = fields;
      if (scheduleId === null) {
        return operation("crewhelm_change_automations", "create_schedule", {
          ...rest,
          agent: { id: agentId, revision: expectedAgentRevision },
          schedule,
        });
      }
      const reference = {
        agentId,
        agentRevision: expectedAgentRevision,
        id: scheduleId,
        revision: expectedScheduleRevision,
      };
      return operation(
        "crewhelm_change_automations",
        schedule === null ? "pause_schedule" : "update_schedule",
        schedule === null
          ? { ...rest, schedule: reference }
          : { ...rest, definition: schedule, schedule: reference },
      );
    }
    case "crewhelm_inspect_integration_tool":
      return operation("crewhelm_inspect_connections", "inspect_action");
    case "crewhelm_list_connections": {
      const { connectionId, ...fields } = input;
      return connectionId === undefined
        ? operation("crewhelm_inspect_connections", "list_connections", fields)
        : operation("crewhelm_change_connections", "inspect_provider_connection", {
            ...fields,
            connection: { connectionId },
          });
    }
    case "crewhelm_configure_agent_connection": {
      const fields = withRequestKey(input);
      const { agentId, connectionId, expectedRevision, ...grant } = fields;
      return operation("crewhelm_change_connections", "grant_provider_actions", {
        ...grant,
        agent: { id: agentId, revision: expectedRevision },
        connection: { connectionId },
      });
    }
    case "crewhelm_list_unresolved_tool_effects":
      return operation("crewhelm_inspect_recovery", "unresolved_effects");
    case "crewhelm_revoke_authority": {
      const { agentId, connectionId, grantId, target } = input;
      return operation(
        "crewhelm_recover",
        target === "agent"
          ? "disable_agent"
          : target === "connection"
            ? "revoke_connection"
            : "revoke_capability",
        target === "agent"
          ? { agent: { id: agentId, revision: 1 } }
          : target === "connection"
            ? { connection: { connectionId } }
            : { grant: { grantId } },
      );
    }
    default:
      return { arguments: input, name };
  }
}

const rehearsalFailureSchema = z.object({
  code: temporaryOwnerSessionErrorCodeSchema,
  message: z.string().max(512),
});

export type RehearsalFailure = z.infer<typeof rehearsalFailureSchema>;

type RehearsalPayload<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "invalid_json" | "invalid_payload" };

function decodeRehearsalPayload<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
): RehearsalPayload<T> {
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: "invalid_payload" };
}

export function normalizeRehearsalFailure(
  error: unknown,
  fallbackMessage: string,
): RehearsalFailure {
  try {
    const parsed = rehearsalFailureSchema.safeParse(error);

    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A hostile thrown value must not escape diagnostic normalization.
  }

  return { code: "request_failed", message: fallbackMessage };
}

export async function callRehearsalTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
  options: RehearsalToolCallOptions = {},
): Promise<T> {
  const call = facadeRehearsalToolCall(name, arguments_);
  const response = await session.call(
    "tools/call",
    call,
    toolCallResponseSchema,
    options.timeoutMs,
  );

  if (!options.acceptErrorResult) {
    return parseMcpToolResult(response, schema, invalidMessage);
  }

  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  const payload = decodeRehearsalPayload(text, schema);

  if (!payload.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }

  return payload.value;
}

export async function readRehearsalStatus(
  session: TemporaryOwnerMcpSession,
  options: Pick<RehearsalToolCallOptions, "timeoutMs"> = {},
): Promise<Extract<z.infer<typeof mcpControlPlaneStatusResultSchema>, { ok: true }>["status"]> {
  const result = await callRehearsalTool(
    session,
    "crewhelm_status",
    {},
    mcpControlPlaneStatusResultSchema,
    "Fleet status returned an invalid payload.",
    options,
  );

  if (!result.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", "Fleet status request was denied.");
  }
  return result.status;
}
