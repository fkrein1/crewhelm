import * as z from "zod";

export const agentScheduleRevisionNumberSchema = z.number().int().positive().safe();
