import * as z from "zod";

export const OWNER_READ_SCOPE = "control:read";

export const ownerKeySchema = z
  .string()
  .regex(/^owner_[A-Za-z0-9_-]{43}$/, "Expected an opaque Crewhelm owner key.");

export const verifiedOwnerIdentitySchema = z.strictObject({
  issuer: z.url().max(2_048),
  subject: z.string().min(1).max(255),
  tenant: z.string().min(1).max(255).optional(),
});

export const ownerAuthoritySchema = z.strictObject({
  clientId: z.string().min(1).max(2_048),
  ownerKey: ownerKeySchema,
  scopes: z.array(z.literal(OWNER_READ_SCOPE)).min(1).max(1),
});

export const controlPlaneStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("ready"),
});

export const controlPlaneStatusResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    status: controlPlaneStatusSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["incompatible_schema", "invalid_authority", "owner_mismatch"]),
      message: z.literal("Control-plane request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type ControlPlaneStatus = z.infer<typeof controlPlaneStatusSchema>;
export type ControlPlaneStatusResult = z.infer<typeof controlPlaneStatusResultSchema>;
export type OwnerAuthority = z.infer<typeof ownerAuthoritySchema>;
export type VerifiedOwnerIdentity = z.infer<typeof verifiedOwnerIdentitySchema>;
