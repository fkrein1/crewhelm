import * as z from "zod";

export const MAXIMUM_CONNECTIONS_PER_OWNER = 1_000;
export const MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER = 5_000;
export const CONNECTION_LINK_UNKNOWN_RECOVERY_MS = 30 * 60 * 1_000;

export const connectionAuthConfigIdSchema = z
  .string()
  .regex(/^ac_[A-Za-z0-9_-]{1,124}$/, "Expected an opaque Composio auth configuration ID.");
export const connectionIdSchema = z
  .string()
  .regex(
    /^connection_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm connection ID.",
  );
export const connectionLinkReservationIdSchema = z
  .string()
  .regex(
    /^connection_link_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm connection-link reservation ID.",
  );
export const connectionLinkIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque idempotency key.");
export const connectionAuthorizationTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected an opaque connection authorization token.");
export const connectionAuthorizationAuthenticatorSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected an opaque connection authorization authenticator.");
export const composioConnectedAccountIdSchema = z
  .string()
  .regex(/^ca_[A-Za-z0-9_-]{1,124}$/, "Expected an opaque Composio connected account ID.");
export const connectionLinkUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
    );
  }, "Expected a safe HTTPS connection link.");

export const createConnectionLinkInputSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  idempotencyKey: connectionLinkIdempotencyKeySchema,
});
export const connectionLinkSchema = z.strictObject({
  connectionId: connectionIdSchema,
  expiresAt: z.iso.datetime(),
  url: connectionLinkUrlSchema,
});
export const connectionAuthorizationOutcomeSchema = z.enum([
  "pending",
  "returned",
  "failed",
  "expired",
  "untracked",
]);
export const connectionStatusSchema = z.enum(["initiated"]);
export const connectionSummarySchema = z.strictObject({
  authorizationOutcome: connectionAuthorizationOutcomeSchema,
  authConfigId: connectionAuthConfigIdSchema,
  connectionId: connectionIdSchema,
  createdAt: z.iso.datetime(),
  status: connectionStatusSchema,
});
export const listConnectionsInputSchema = z.strictObject({
  cursor: connectionIdSchema.optional(),
  limit: z.number().int().min(1).max(50).default(25),
});

const connectionLinkRequestErrorSchema = z.strictObject({
  code: z.enum([
    "connection_limit_exceeded",
    "connection_link_expired",
    "connection_link_in_progress",
    "connection_link_outcome_unknown",
    "connection_link_request_limit_exceeded",
    "connection_link_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
  ]),
  message: z.literal("Connection link request denied."),
});
const connectionReadRequestErrorSchema = z.strictObject({
  code: z.enum([
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
  ]),
  message: z.literal("Connection request denied."),
});

export const createConnectionLinkResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connectionLink: connectionLinkSchema,
    created: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: connectionLinkRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export const reserveConnectionLinkResultSchema = z.union([
  z.strictObject({
    connectionLink: connectionLinkSchema,
    ok: z.literal(true),
    state: z.literal("replay"),
  }),
  z.strictObject({
    authorizationExpiresAt: z.iso.datetime(),
    authorizationToken: connectionAuthorizationTokenSchema,
    ok: z.literal(true),
    reservationId: connectionLinkReservationIdSchema,
    state: z.literal("dispatch"),
  }),
  z.strictObject({
    error: connectionLinkRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export const completeConnectionLinkInputSchema = z.strictObject({
  authorizationToken: connectionAuthorizationTokenSchema,
  expiresAt: z.iso.datetime(),
  providerConnectionId: composioConnectedAccountIdSchema,
  reservationId: connectionLinkReservationIdSchema,
  url: connectionLinkUrlSchema,
});
export const recordConnectionAuthorizationReturnInputSchema = z.strictObject({
  authorizationToken: connectionAuthorizationTokenSchema,
  providerConnectionId: composioConnectedAccountIdSchema.optional(),
  reservationId: connectionLinkReservationIdSchema,
  status: z.enum(["success", "failed"]),
});
export const recordConnectionAuthorizationReturnResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    outcome: z.enum(["returned", "failed"]),
    recorded: z.boolean(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.literal("invalid_return"),
      message: z.literal("Connection authorization return denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const listConnectionsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connections: z.array(connectionSummarySchema).max(50),
    nextCursor: connectionIdSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: connectionReadRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export type CompleteConnectionLinkInput = z.infer<typeof completeConnectionLinkInputSchema>;
export type ConnectionAuthorizationOutcome = z.infer<typeof connectionAuthorizationOutcomeSchema>;
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;
export type CreateConnectionLinkInput = z.infer<typeof createConnectionLinkInputSchema>;
export type CreateConnectionLinkResult = z.infer<typeof createConnectionLinkResultSchema>;
export type ListConnectionsInput = z.infer<typeof listConnectionsInputSchema>;
export type ListConnectionsResult = z.infer<typeof listConnectionsResultSchema>;
export type RecordConnectionAuthorizationReturnInput = z.infer<
  typeof recordConnectionAuthorizationReturnInputSchema
>;
export type RecordConnectionAuthorizationReturnResult = z.infer<
  typeof recordConnectionAuthorizationReturnResultSchema
>;
export type ReserveConnectionLinkResult = z.infer<typeof reserveConnectionLinkResultSchema>;
