import * as z from "zod";

export const agentBlueprintIdSchema = z
  .string()
  .regex(
    /^blueprint_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm Agent blueprint ID.",
  );
export const agentBlueprintVersionSchema = z.number().int().positive().safe();
const agentBlueprintDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest.");
export const agentBlueprintProvenanceSchema = z.strictObject({
  digest: agentBlueprintDigestSchema,
  id: agentBlueprintIdSchema,
  parameterDigest: agentBlueprintDigestSchema,
  version: agentBlueprintVersionSchema,
});

export type AgentBlueprintProvenance = z.infer<typeof agentBlueprintProvenanceSchema>;
