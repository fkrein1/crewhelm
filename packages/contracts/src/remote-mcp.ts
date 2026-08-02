import * as z from "zod";

import { connectionIdSchema, connectionStatusSchema } from "./connections.js";

export const MAXIMUM_REMOTE_MCP_CATALOG_BYTES = 512 * 1_024;
export const MAXIMUM_REMOTE_MCP_DESCRIPTION_CHARACTERS = 16 * 1_024;
export const MAXIMUM_REMOTE_MCP_ENDPOINT_CHARACTERS = 2_048;
export const MAXIMUM_REMOTE_MCP_SCHEMA_BYTES = 64 * 1_024;
export const MAXIMUM_REMOTE_MCP_TOOLS = 100;

const encoder = new TextEncoder();
const remoteMcpSha256DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest.");

export const remoteMcpAuthKindSchema = z.enum(["public", "bearer"]);
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
export const remoteMcpConnectionSchema = z.strictObject({
  authKind: remoteMcpAuthKindSchema,
  catalog: remoteMcpCatalogSchema,
  catalogBytes: z.number().int().min(2).max(MAXIMUM_REMOTE_MCP_CATALOG_BYTES),
  connectionId: connectionIdSchema,
  createdAt: z.iso.datetime(),
  endpoint: remoteMcpEndpointSchema,
  name: remoteMcpConnectionNameSchema,
  server: z.strictObject({
    name: z.string().trim().min(1).max(160),
    version: z.string().trim().min(1).max(160),
  }),
  snapshotDigest: remoteMcpSha256DigestSchema,
  status: connectionStatusSchema,
});
export const createRemoteMcpConnectionInputSchema = z
  .strictObject({
    authKind: remoteMcpAuthKindSchema,
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
  });
const remoteMcpConnectionRequestErrorSchema = z.strictObject({
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
export const createRemoteMcpConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connection: remoteMcpConnectionSchema,
    created: z.boolean(),
    ok: z.literal(true),
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

export const remoteMcpConnectionOperationInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("connect"),
    authKind: remoteMcpAuthKindSchema,
    endpoint: remoteMcpEndpointSchema,
    idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
    name: remoteMcpConnectionNameSchema,
  }),
  inspectRemoteMcpConnectionInputSchema.extend({ action: z.literal("inspect") }),
  deleteRemoteMcpConnectionInputSchema.extend({ action: z.literal("delete") }),
]);
export const remoteMcpConnectionToolInputSchema = z
  .strictObject({
    action: z.enum(["connect", "delete", "inspect"]),
    authKind: remoteMcpAuthKindSchema.optional(),
    connectionId: connectionIdSchema.optional(),
    endpoint: remoteMcpEndpointSchema.optional(),
    idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey.optional(),
    name: remoteMcpConnectionNameSchema.optional(),
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
export const lookupRemoteMcpConnectionCreationInputSchema = z.strictObject({
  authKind: remoteMcpAuthKindSchema,
  endpoint: remoteMcpEndpointSchema,
  idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
  name: remoteMcpConnectionNameSchema,
});
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
