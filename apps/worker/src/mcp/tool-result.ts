import { INTEGRATIONS_READ_SCOPE, type OwnerAuthority } from "@crewhelm/contracts";
import type * as z from "zod";

export const CONTROL_PLANE_UNAVAILABLE_BODY = JSON.stringify({
  error: {
    code: "control_plane_unavailable",
    message: "Control-plane request denied.",
  },
});

export async function controlPlaneToolResult<Result extends { ok: boolean }>(
  operation: () => Promise<unknown>,
  schema: z.ZodType<Result>,
) {
  let result: Result;

  try {
    result = schema.parse(await operation());
  } catch {
    return {
      content: [
        {
          text: CONTROL_PLANE_UNAVAILABLE_BODY,
          type: "text" as const,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        text: JSON.stringify(result),
        type: "text" as const,
      },
    ],
    isError: !result.ok,
  };
}

export async function integrationReadToolResult<Result extends { ok: boolean }>(
  authority: OwnerAuthority,
  operation: () => Promise<unknown>,
  schema: z.ZodType<Result>,
) {
  const result = schema.parse(
    authority.scopes.includes(INTEGRATIONS_READ_SCOPE)
      ? await operation()
      : {
          error: {
            code: "insufficient_scope",
            message: "Integration catalog request denied.",
          },
          ok: false,
        },
  );

  return {
    content: [
      {
        text: JSON.stringify(result),
        type: "text" as const,
      },
    ],
    isError: !result.ok,
  };
}
