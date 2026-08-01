import type * as z from "zod";

import { mcpControlPlaneStatusResultSchema } from "../mcp-result-schemas.js";
import {
  parseMcpToolResult,
  TemporaryOwnerSessionError,
  toolCallResponseSchema,
  type TemporaryOwnerMcpSession,
} from "../temporary-owner-session.js";

interface RehearsalToolCallOptions {
  acceptErrorResult?: boolean;
  timeoutMs?: number;
}

export async function callRehearsalTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
  options: RehearsalToolCallOptions = {},
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: arguments_, name },
    toolCallResponseSchema,
    options.timeoutMs,
  );

  if (!options.acceptErrorResult) {
    return parseMcpToolResult(response, schema, invalidMessage);
  }

  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }
  return parsed.data;
}

export async function readRehearsalStatus(
  session: TemporaryOwnerMcpSession,
  options: Pick<RehearsalToolCallOptions, "timeoutMs"> = {},
) {
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
