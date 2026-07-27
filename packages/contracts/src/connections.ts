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
  expiresAt: z.iso.datetime(),
  providerConnectionId: composioConnectedAccountIdSchema,
  reservationId: connectionLinkReservationIdSchema,
  url: connectionLinkUrlSchema,
});

export type CompleteConnectionLinkInput = z.infer<typeof completeConnectionLinkInputSchema>;
export type CreateConnectionLinkInput = z.infer<typeof createConnectionLinkInputSchema>;
export type CreateConnectionLinkResult = z.infer<typeof createConnectionLinkResultSchema>;
export type ReserveConnectionLinkResult = z.infer<typeof reserveConnectionLinkResultSchema>;
