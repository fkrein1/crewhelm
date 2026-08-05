import * as z from "zod";

import { connectionIdSchema, connectionStatusSchema } from "./connections.js";

export const MAXIMUM_REMOTE_MCP_CATALOG_BYTES = 512 * 1_024;
export const MAXIMUM_REMOTE_MCP_DESCRIPTION_CHARACTERS = 16 * 1_024;
export const MAXIMUM_REMOTE_MCP_ENDPOINT_CHARACTERS = 2_048;
export const MAXIMUM_REMOTE_MCP_SCHEMA_BYTES = 64 * 1_024;
export const MAXIMUM_REMOTE_MCP_TOOLS = 100;
export const MAXIMUM_REMOTE_MCP_OAUTH_SCOPES = 32;
export const MAXIMUM_REMOTE_MCP_API_KEY_HEADER_NAME_CHARACTERS = 64;

const encoder = new TextEncoder();
const remoteMcpSha256DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest.");

const RESERVED_REMOTE_MCP_API_KEY_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "referer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

export const remoteMcpApiKeyHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_REMOTE_MCP_API_KEY_HEADER_NAME_CHARACTERS)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Expected one HTTP header field name.")
  .transform((value) => value.toLowerCase())
  .refine(
    (value) =>
      !RESERVED_REMOTE_MCP_API_KEY_HEADERS.has(value) &&
      !["cf-", "content-", "mcp-", "proxy-", "sec-", "x-forwarded-"].some((prefix) =>
        value.startsWith(prefix),
      ),
    "Expected a non-reserved API-key header name.",
  )
  .describe(
    "Exact HTTP header name for API-key authentication. Enter the credential only in the returned browser setup.",
  );
export const remoteMcpApiKeyValueSchema = z
  .string()
  .min(1)
  .max(8 * 1_024)
  .regex(/^[\x21-\x7e]+$/, "Expected API-key credential material without whitespace.");
export const remoteMcpApiKeyCredentialSchema = z.strictObject({
  headerName: remoteMcpApiKeyHeaderNameSchema,
  value: remoteMcpApiKeyValueSchema,
});
export const remoteMcpAuthKindSchema = z.enum(["public", "api_key", "bearer", "oauth"]);
export const remoteMcpOAuthScopeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, "Expected one OAuth scope token.");
export const remoteMcpOAuthScopesSchema = z
  .array(remoteMcpOAuthScopeSchema)
  .max(MAXIMUM_REMOTE_MCP_OAUTH_SCOPES)
  .refine(
    (scopes) => scopes.every((scope, index) => index === 0 || (scopes[index - 1] ?? "") < scope),
    "Expected unique OAuth scopes in canonical order.",
  );
export const remoteMcpConnectionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[ -~]+$/, "Expected a printable ASCII Connection name.");
export const remoteMcpEndpointSchema = z
  .url()
  .max(MAXIMUM_REMOTE_MCP_ENDPOINT_CHARACTERS)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Expected a safe remote MCP HTTPS endpoint.");
export const remoteMcpToolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/, "Expected a bounded remote MCP tool name.");
export const remoteMcpToolSchema = z.strictObject({
  annotations: z
    .strictObject({
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
      readOnlyHint: z.boolean().optional(),
      title: z.string().trim().min(1).max(256).optional(),
    })
    .optional(),
  description: z.string().trim().min(1).max(MAXIMUM_REMOTE_MCP_DESCRIPTION_CHARACTERS).optional(),
  inputSchema: z
    .record(z.string(), z.unknown())
    .and(z.object({ type: z.literal("object") }))
    .refine(
      (schema) =>
        encoder.encode(JSON.stringify(schema)).byteLength <= MAXIMUM_REMOTE_MCP_SCHEMA_BYTES,
      "Remote MCP tool schema exceeds its byte limit.",
    ),
  name: remoteMcpToolNameSchema,
});
export const remoteMcpCatalogSchema = z
  .array(remoteMcpToolSchema)
  .max(MAXIMUM_REMOTE_MCP_TOOLS)
  .refine(
    (tools) =>
      tools.every((tool, index) => index === 0 || (tools[index - 1]?.name ?? "") < tool.name),
    "Expected unique remote MCP tools in canonical name order.",
  )
  .refine(
    (tools) => encoder.encode(JSON.stringify(tools)).byteLength <= MAXIMUM_REMOTE_MCP_CATALOG_BYTES,
    "Remote MCP catalog exceeds its byte limit.",
  );
export const remoteMcpConnectionSchema = z
  .strictObject({
    apiKeyHeaderName: remoteMcpApiKeyHeaderNameSchema.optional(),
    authKind: remoteMcpAuthKindSchema,
    catalog: remoteMcpCatalogSchema,
    catalogBytes: z.number().int().min(2).max(MAXIMUM_REMOTE_MCP_CATALOG_BYTES),
    connectionId: connectionIdSchema,
    createdAt: z.iso.datetime(),
    endpoint: remoteMcpEndpointSchema,
    name: remoteMcpConnectionNameSchema,
    oauthScopes: remoteMcpOAuthScopesSchema,
    server: z.strictObject({
      name: z.string().trim().min(1).max(160),
      version: z.string().trim().min(1).max(160),
    }),
    snapshotDigest: remoteMcpSha256DigestSchema,
    status: connectionStatusSchema,
  })
  .refine(
    ({ apiKeyHeaderName, authKind }) =>
      (authKind === "api_key") === (apiKeyHeaderName !== undefined),
    {
      message: "Only API-key Connections must expose one named authentication header.",
      path: ["apiKeyHeaderName"],
    },
  );
export const createRemoteMcpConnectionInputSchema = z
  .strictObject({
    apiKey: remoteMcpApiKeyCredentialSchema.optional(),
    authKind: z.enum(["public", "api_key", "bearer"]),
    bearerToken: z
      .string()
      .min(1)
      .max(8 * 1_024)
      .regex(/^[\x21-\x7e]+$/, "Expected bearer credential material without whitespace.")
      .optional(),
    catalog: remoteMcpCatalogSchema,
    catalogBytes: remoteMcpConnectionSchema.shape.catalogBytes,
    endpoint: remoteMcpEndpointSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    name: remoteMcpConnectionSchema.shape.name,
    server: remoteMcpConnectionSchema.shape.server,
    snapshotDigest: remoteMcpSha256DigestSchema,
  })
  .superRefine((input, context) => {
    if ((input.authKind === "bearer") !== (input.bearerToken !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Bearer authentication must include exactly one bearer token.",
        path: ["bearerToken"],
      });
    }
    if ((input.authKind === "api_key") !== (input.apiKey !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "API-key authentication must include exactly one named-header credential.",
        path: ["apiKey"],
      });
    }
  });
const reauthenticateRemoteMcpConnectionFields = {
  catalog: remoteMcpCatalogSchema,
  catalogBytes: remoteMcpConnectionSchema.shape.catalogBytes,
  connectionId: connectionIdSchema,
  idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
  server: remoteMcpConnectionSchema.shape.server,
  snapshotDigest: remoteMcpSha256DigestSchema,
};
export const reauthenticateRemoteMcpConnectionInputSchema = z.discriminatedUnion("authKind", [
  z.strictObject({
    ...reauthenticateRemoteMcpConnectionFields,
    apiKey: remoteMcpApiKeyCredentialSchema,
    authKind: z.literal("api_key"),
  }),
  z.strictObject({
    ...reauthenticateRemoteMcpConnectionFields,
    authKind: z.literal("bearer"),
    bearerToken: createRemoteMcpConnectionInputSchema.shape.bearerToken.unwrap(),
  }),
]);
export const remoteMcpConnectionRequestErrorSchema = z.strictObject({
  code: z.enum([
    "connection_limit_exceeded",
    "connection_not_found",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "remote_mcp_unavailable",
    "revision_conflict",
  ]),
  message: z.literal("Remote MCP Connection request denied."),
});
export const remoteMcpOAuthRequestIdSchema = z
  .string()
  .regex(/^remote_mcp_oauth_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const beginRemoteMcpOAuthInputSchema = z.strictObject({
  requestId: remoteMcpOAuthRequestIdSchema,
});
export const beginRemoteMcpOAuthResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authorizationUrl: z.url().max(8 * 1_024),
    ok: z.literal(true),
  }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const completeRemoteMcpOAuthInputSchema = beginRemoteMcpOAuthInputSchema.extend({
  authorizationCode: z
    .string()
    .min(1)
    .max(4_096)
    .regex(/^[\x21-\x7e]+$/),
  authorizationServerIssuer: z.url().max(MAXIMUM_REMOTE_MCP_ENDPOINT_CHARACTERS).optional(),
});
export const completeRemoteMcpOAuthResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connection: remoteMcpConnectionSchema,
    ok: z.literal(true),
    operation: z.enum(["created", "reauthenticated"]),
  }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const failRemoteMcpOAuthInputSchema = beginRemoteMcpOAuthInputSchema;
export const failRemoteMcpOAuthResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ failed: z.boolean(), ok: z.literal(true) }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const createRemoteMcpConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connection: remoteMcpConnectionSchema,
    created: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const reauthenticateRemoteMcpConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connection: remoteMcpConnectionSchema,
    ok: z.literal(true),
    reauthenticated: z.boolean(),
  }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const inspectRemoteMcpConnectionInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
});
export const inspectRemoteMcpConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ connection: remoteMcpConnectionSchema, ok: z.literal(true) }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const deleteRemoteMcpConnectionInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._~-]+$/),
  snapshotDigest: remoteMcpSha256DigestSchema,
});
export const deleteRemoteMcpConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ deleted: z.boolean(), ok: z.literal(true) }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);

export const remoteMcpConnectionOperationInputSchema = z.union([
  z.discriminatedUnion("authKind", [
    z.strictObject({
      action: z.literal("connect"),
      authKind: z.literal("public"),
      endpoint: remoteMcpEndpointSchema,
      idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
      name: remoteMcpConnectionNameSchema,
    }),
    z.strictObject({
      action: z.literal("connect"),
      apiKeyHeaderName: remoteMcpApiKeyHeaderNameSchema,
      authKind: z.literal("api_key"),
      endpoint: remoteMcpEndpointSchema,
      idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
      name: remoteMcpConnectionNameSchema,
    }),
    z.strictObject({
      action: z.literal("connect"),
      authKind: z.literal("bearer"),
      endpoint: remoteMcpEndpointSchema,
      idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
      name: remoteMcpConnectionNameSchema,
    }),
    z.strictObject({
      action: z.literal("connect"),
      authKind: z.literal("oauth"),
      endpoint: remoteMcpEndpointSchema,
      idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
      name: remoteMcpConnectionNameSchema,
      oauthScopes: remoteMcpOAuthScopesSchema.default([]),
    }),
  ]),
  inspectRemoteMcpConnectionInputSchema.extend({ action: z.literal("inspect") }),
  deleteRemoteMcpConnectionInputSchema.extend({ action: z.literal("delete") }),
  deleteRemoteMcpConnectionInputSchema.extend({ action: z.literal("reauthenticate") }),
]);
export const remoteMcpConnectionToolInputSchema = z
  .strictObject({
    action: z.enum(["connect", "delete", "inspect", "reauthenticate"]),
    apiKeyHeaderName: remoteMcpApiKeyHeaderNameSchema.optional(),
    authKind: remoteMcpAuthKindSchema.optional(),
    connectionId: connectionIdSchema.optional(),
    endpoint: remoteMcpEndpointSchema.optional(),
    idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey.optional(),
    name: remoteMcpConnectionNameSchema.optional(),
    oauthScopes: remoteMcpOAuthScopesSchema.optional(),
    snapshotDigest: remoteMcpSha256DigestSchema.optional(),
  })
  .superRefine((input, context) => {
    const parsed = remoteMcpConnectionOperationInputSchema.safeParse(input);
    if (parsed.success) return;
    context.addIssue({
      code: "custom",
      message: "Fields must match the selected remote MCP Connection action.",
    });
  });
export const lookupRemoteMcpConnectionCreationInputSchema = z
  .strictObject({
    apiKeyHeaderName: remoteMcpApiKeyHeaderNameSchema.optional(),
    authKind: remoteMcpAuthKindSchema,
    endpoint: remoteMcpEndpointSchema,
    idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
    name: remoteMcpConnectionNameSchema,
    oauthScopes: remoteMcpOAuthScopesSchema.default([]),
  })
  .refine(
    ({ apiKeyHeaderName, authKind }) =>
      (authKind === "api_key") === (apiKeyHeaderName !== undefined),
    {
      message: "Only API-key creation lookups must include the named authentication header.",
      path: ["apiKeyHeaderName"],
    },
  );
export const lookupRemoteMcpConnectionCreationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ connection: remoteMcpConnectionSchema.nullable(), ok: z.literal(true) }),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);
export const remoteMcpConnectionOperationResultSchema = z.discriminatedUnion("ok", [
  z.discriminatedUnion("state", [
    z.strictObject({
      connection: remoteMcpConnectionSchema,
      created: z.boolean(),
      ok: z.literal(true),
      state: z.literal("connected"),
    }),
    z.strictObject({
      ok: z.literal(true),
      setup: z.strictObject({
        expiresAt: z.iso.datetime(),
        url: z.url().max(8 * 1_024),
      }),
      state: z.literal("setup_required"),
    }),
    z.strictObject({
      connection: remoteMcpConnectionSchema,
      ok: z.literal(true),
      state: z.literal("inspected"),
    }),
    z.strictObject({
      deleted: z.boolean(),
      ok: z.literal(true),
      state: z.literal("deleted"),
    }),
  ]),
  z.strictObject({ error: remoteMcpConnectionRequestErrorSchema, ok: z.literal(false) }),
]);

export type CreateRemoteMcpConnectionInput = z.infer<typeof createRemoteMcpConnectionInputSchema>;
export type CreateRemoteMcpConnectionResult = z.infer<typeof createRemoteMcpConnectionResultSchema>;
export type ReauthenticateRemoteMcpConnectionResult = z.infer<
  typeof reauthenticateRemoteMcpConnectionResultSchema
>;
export type DeleteRemoteMcpConnectionResult = z.infer<typeof deleteRemoteMcpConnectionResultSchema>;
export type InspectRemoteMcpConnectionResult = z.infer<
  typeof inspectRemoteMcpConnectionResultSchema
>;
export type LookupRemoteMcpConnectionCreationResult = z.infer<
  typeof lookupRemoteMcpConnectionCreationResultSchema
>;
export type RemoteMcpAuthKind = z.infer<typeof remoteMcpAuthKindSchema>;
export type RemoteMcpCatalog = z.infer<typeof remoteMcpCatalogSchema>;
export type RemoteMcpConnection = z.infer<typeof remoteMcpConnectionSchema>;
export type RemoteMcpTool = z.infer<typeof remoteMcpToolSchema>;
export type RemoteMcpConnectionOperationInput = z.infer<
  typeof remoteMcpConnectionOperationInputSchema
>;
export type RemoteMcpConnectionOperationResult = z.infer<
  typeof remoteMcpConnectionOperationResultSchema
>;
export type BeginRemoteMcpOAuthResult = z.infer<typeof beginRemoteMcpOAuthResultSchema>;
export type CompleteRemoteMcpOAuthResult = z.infer<typeof completeRemoteMcpOAuthResultSchema>;
export type FailRemoteMcpOAuthResult = z.infer<typeof failRemoteMcpOAuthResultSchema>;
