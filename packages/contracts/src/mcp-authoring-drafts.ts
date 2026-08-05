import * as z from "zod";

import { agentMutationIdempotencyKeySchema } from "./control-plane.js";
import { jsonValueSchema } from "./output-contracts.js";
import { sha256DigestSchema } from "./capabilities.js";

export const MAXIMUM_MCP_AUTHORING_DRAFTS = 8;
export const MAXIMUM_MCP_AUTHORING_DRAFT_BYTES = 160 * 1_024;
export const MCP_AUTHORING_DRAFT_TTL_SECONDS = 24 * 60 * 60;

export const mcpAuthoringDraftKindSchema = z.enum([
  "agent-blueprint-package",
  "recipe-installation",
  "recipe-publication",
  "skill-package",
]);
export const mcpAuthoringDraftIdSchema = z
  .string()
  .regex(
    /^mcp_draft_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque MCP authoring draft ID.",
  );
export const mcpAuthoringDraftLocatorSchema = z
  .looseObject({
    digest: sha256DigestSchema,
    id: mcpAuthoringDraftIdSchema,
    kind: mcpAuthoringDraftKindSchema,
    revision: z.number().int().positive().safe(),
  })
  .describe("Copy-ready owner-scoped authoring draft locator returned by Crewhelm.");
export const mcpAuthoringDraftReferenceSchema = mcpAuthoringDraftLocatorSchema
  .extend({ expiresAt: z.iso.datetime() })
  .describe("Copy-ready owner-scoped authoring draft reference returned by Crewhelm.");

export const mcpAuthoringDraftInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("create"),
    content: jsonValueSchema,
    idempotencyKey: agentMutationIdempotencyKeySchema,
    kind: mcpAuthoringDraftKindSchema,
  }),
  z.strictObject({
    action: z.literal("read"),
    draft: mcpAuthoringDraftLocatorSchema,
  }),
  z.strictObject({
    action: z.literal("replace"),
    content: jsonValueSchema,
    draft: mcpAuthoringDraftLocatorSchema,
    idempotencyKey: agentMutationIdempotencyKeySchema,
  }),
  z.strictObject({
    action: z.literal("discard"),
    draft: mcpAuthoringDraftLocatorSchema,
  }),
]);

const mcpAuthoringDraftErrorSchema = z.strictObject({
  code: z.enum([
    "draft_limit_exceeded",
    "draft_not_found",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "revision_conflict",
    "storage_unavailable",
  ]),
  message: z.literal("MCP authoring draft request denied."),
});

export const mcpAuthoringDraftResultSchema = z.union([
  z.strictObject({
    action: z.literal("list"),
    drafts: z.array(mcpAuthoringDraftReferenceSchema).max(MAXIMUM_MCP_AUTHORING_DRAFTS),
    ok: z.literal(true),
  }),
  z.strictObject({
    action: z.enum(["create", "replace"]),
    draft: mcpAuthoringDraftReferenceSchema,
    ok: z.literal(true),
    replayed: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("read"),
    content: jsonValueSchema,
    draft: mcpAuthoringDraftReferenceSchema,
    ok: z.literal(true),
  }),
  z.strictObject({
    action: z.literal("discard"),
    discarded: z.boolean(),
    draftId: mcpAuthoringDraftIdSchema,
    ok: z.literal(true),
  }),
  z.strictObject({ error: mcpAuthoringDraftErrorSchema, ok: z.literal(false) }),
]);

export type McpAuthoringDraftInput = z.infer<typeof mcpAuthoringDraftInputSchema>;
export type McpAuthoringDraftKind = z.infer<typeof mcpAuthoringDraftKindSchema>;
export type McpAuthoringDraftLocator = z.infer<typeof mcpAuthoringDraftLocatorSchema>;
export type McpAuthoringDraftReference = z.infer<typeof mcpAuthoringDraftReferenceSchema>;
export type McpAuthoringDraftResult = z.infer<typeof mcpAuthoringDraftResultSchema>;
