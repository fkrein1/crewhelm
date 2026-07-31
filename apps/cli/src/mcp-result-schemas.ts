import { controlPlaneStatusResultSchema } from "@crewhelm/contracts";
import * as z from "zod";

// MCP may add presentation-only fields around the authoritative status projection. CLI clients do
// not consume those fields, but must remain forward-compatible with them while continuing to
// validate the exact control-plane status they use.
export const mcpControlPlaneStatusResultSchema = z.discriminatedUnion("ok", [
  controlPlaneStatusResultSchema.options[0].loose(),
  controlPlaneStatusResultSchema.options[1],
]);
