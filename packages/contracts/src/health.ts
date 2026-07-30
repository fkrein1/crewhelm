import * as z from "zod";

export const HEALTH_PATH = "/health";
export const CREWHELM_DEPLOYMENT_PROTOCOL_VERSION = 1;
export const deploymentFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const deploymentIdentitySchema = z.strictObject({
  fingerprint: deploymentFingerprintSchema,
  protocolVersion: z.number().int().positive().safe(),
});

export const healthReportSchema = z.strictObject({
  deployment: deploymentIdentitySchema,
  service: z.literal("crewhelm"),
  status: z.literal("ok"),
});

export const legacyHealthReportSchema = z.strictObject({
  service: z.literal("crewhelm"),
  status: z.literal("ok"),
});

export type HealthReport = z.infer<typeof healthReportSchema>;
