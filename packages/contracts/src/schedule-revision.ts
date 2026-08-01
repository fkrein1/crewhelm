import * as z from "zod";

export const agentScheduleIdSchema = z
  .string()
  .regex(
    /^schedule_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm schedule ID.",
  );
export const agentScheduleRevisionNumberSchema = z.number().int().positive().safe();
