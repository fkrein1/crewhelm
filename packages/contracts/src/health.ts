import * as z from "zod";

export const HEALTH_PATH = "/health";

export const healthReportSchema = z.strictObject({
  service: z.literal("crewhelm"),
  status: z.literal("ok"),
});

export type HealthReport = z.infer<typeof healthReportSchema>;
