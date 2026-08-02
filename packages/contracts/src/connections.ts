import * as z from "zod";

export const MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER = 5_000;
export const CONNECTION_LINK_UNKNOWN_RECOVERY_MS = 30 * 60 * 1_000;
export const MAXIMUM_CONNECTION_LIST_ITEMS = 20;

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
export const connectionStatusSchema = z.enum(["initiated", "active", "revoked", "unavailable"]);
function isPrintableAccountLabel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint === undefined || codePoint < 32 || codePoint > 126) {
      return false;
    }
  }

  return true;
}
export const connectionSummarySchema = z.strictObject({
  accountLabel: z
    .string()
    .min(1)
    .max(160)
    .refine(isPrintableAccountLabel, "Expected a printable ASCII connection account label.")
    .nullable(),
  authorizationOutcome: connectionAuthorizationOutcomeSchema,
  authConfigId: connectionAuthConfigIdSchema,
  connectionId: connectionIdSchema,
  createdAt: z.iso.datetime(),
  integrationSlug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, "Expected a Composio integration slug.")
    .nullable(),
  providerConnectionId: composioConnectedAccountIdSchema,
  status: connectionStatusSchema,
});
export const listConnectionsInputSchema = z.strictObject({
  authorizationOutcome: connectionAuthorizationOutcomeSchema
    .optional()
    .describe("Return connections with this latest owner-local authorization outcome."),
  cursor: connectionIdSchema.optional(),
  connectionId: connectionIdSchema
    .optional()
    .describe("Inspect one exact connection, including its bounded safe lifecycle timeline."),
  integration: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, "Expected a Composio integration slug.")
    .optional()
    .describe("Return connections created for this enabled integration."),
  limit: z.number().int().min(1).max(MAXIMUM_CONNECTION_LIST_ITEMS).default(20),
  status: connectionStatusSchema.optional().describe("Return connections in this lifecycle state."),
});
export const inspectConnectionInputSchema = z.strictObject({
  connectionId: connectionIdSchema,
});
export const activateVerifiedConnectionInputSchema = z.strictObject({
  accountLabel: connectionSummarySchema.shape.accountLabel,
  connectionId: connectionIdSchema,
  providerConnectionId: composioConnectedAccountIdSchema,
  verifiedIntegrationSlug: connectionSummarySchema.shape.integrationSlug.unwrap(),
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
  operation: z
    .strictObject({
      nextAction: z.literal("retry_same_request"),
      recoverAfter: z.iso.datetime(),
      reservationId: connectionLinkReservationIdSchema,
    })
    .optional(),
});
const connectionReadRequestErrorSchema = z.strictObject({
  code: z.enum([
    "connection_not_found",
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
    recoverAfter: z.iso.datetime(),
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
    connections: z.array(connectionSummarySchema).max(MAXIMUM_CONNECTION_LIST_ITEMS),
    detail: z
      .strictObject({
        nextAction: z.enum(["none", "reconnect", "review_authorization", "wait"]),
        timeline: z
          .array(
            z.strictObject({
              action: z
                .string()
                .min(1)
                .max(120)
                .regex(/^[a-z0-9._-]+$/),
              eventId: z.number().int().positive().safe(),
              occurredAt: z.iso.datetime(),
            }),
          )
          .max(25),
      })
      .optional(),
    nextCursor: connectionIdSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: connectionReadRequestErrorSchema,
    ok: z.literal(false),
  }),
]);
export const inspectConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    connection: connectionSummarySchema,
    nextAction: z.enum(["none", "reconnect", "review_authorization", "wait"]),
    ok: z.literal(true),
    timeline: z
      .array(
        z.strictObject({
          action: z
            .string()
            .min(1)
            .max(120)
            .regex(/^[a-z0-9._-]+$/),
          eventId: z.number().int().positive().safe(),
          occurredAt: z.iso.datetime(),
        }),
      )
      .max(25),
  }),
  z.strictObject({
    error: connectionReadRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export type CompleteConnectionLinkInput = z.infer<typeof completeConnectionLinkInputSchema>;
export type ActivateVerifiedConnectionInput = z.infer<typeof activateVerifiedConnectionInputSchema>;
export type ConnectionAuthorizationOutcome = z.infer<typeof connectionAuthorizationOutcomeSchema>;
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;
export type CreateConnectionLinkInput = z.infer<typeof createConnectionLinkInputSchema>;
export type CreateConnectionLinkResult = z.infer<typeof createConnectionLinkResultSchema>;
export type ListConnectionsInput = z.infer<typeof listConnectionsInputSchema>;
export type ListConnectionsResult = z.infer<typeof listConnectionsResultSchema>;
export type InspectConnectionResult = z.infer<typeof inspectConnectionResultSchema>;
export type RecordConnectionAuthorizationReturnInput = z.infer<
  typeof recordConnectionAuthorizationReturnInputSchema
>;
export type RecordConnectionAuthorizationReturnResult = z.infer<
  typeof recordConnectionAuthorizationReturnResultSchema
>;
export type ReserveConnectionLinkResult = z.infer<typeof reserveConnectionLinkResultSchema>;
