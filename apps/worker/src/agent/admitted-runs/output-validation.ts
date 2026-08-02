import {
  MAXIMUM_OUTPUT_VALIDATION_ISSUES,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  admittedOutputContractSchema,
  canonicalJson,
  jsonDeliverableSchema,
  outputContractSchema,
  validateJsonOutput,
  type AdmittedOutputContract,
  type JsonDeliverable,
  type JsonValue,
  type OutputContract,
  type OutputValidationIssue,
} from "@crewhelm/contracts";

const encoder = new TextEncoder();

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function bindOutputContract(
  value: OutputContract | undefined,
): Promise<AdmittedOutputContract | undefined> {
  const contract = value === undefined ? undefined : outputContractSchema.parse(value);
  if (contract === undefined || contract.kind === "markdown") return contract;

  return admittedOutputContractSchema.parse({
    kind: "json",
    schema: {
      ...contract.schema,
      digest: await digest(canonicalJson(contract.schema.jsonSchema)),
    },
  });
}

export function outputContractInstruction(contract: AdmittedOutputContract | undefined): string {
  if (contract?.kind !== "json") return "";
  return [
    "Final deliverable contract:",
    `Return exactly one JSON object matching ${contract.schema.name} version ${contract.schema.version}.`,
    "Do not wrap it in Markdown or add explanatory text outside the JSON object.",
    canonicalJson(contract.schema.jsonSchema),
  ].join("\n");
}

export function parseJsonCandidate(
  contract: Extract<AdmittedOutputContract, { kind: "json" }>,
  candidate: string,
):
  | { canonical: string; ok: true; value: JsonValue }
  | { issues: OutputValidationIssue[]; ok: false } {
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { issues: [{ code: "invalid_json", path: "$" }], ok: false };
  }

  const validation = validateJsonOutput(contract.schema.jsonSchema, value);
  if (!validation.ok) return validation;
  const canonical = canonicalJson(validation.value);
  return {
    canonical,
    ok: true,
    value: validation.value,
  };
}

export async function finalizeJsonCandidate(
  contract: Extract<AdmittedOutputContract, { kind: "json" }>,
  candidate: string,
  repairAttempted: boolean,
): Promise<
  | {
      canonical: string;
      deliverable: Extract<JsonDeliverable, { state: "valid" }>;
      ok: true;
      value: JsonValue;
    }
  | { deliverable: Extract<JsonDeliverable, { state: "invalid" }>; ok: false }
> {
  const parsed = parseJsonCandidate(contract, candidate);
  if (!parsed.ok) {
    return {
      deliverable: jsonDeliverableSchema.options[1].parse({
        issues: parsed.issues.slice(0, MAXIMUM_OUTPUT_VALIDATION_ISSUES),
        kind: "json",
        mediaType: "application/json",
        repairAttempted,
        schema: {
          digest: contract.schema.digest,
          name: contract.schema.name,
          version: contract.schema.version,
        },
        state: "invalid",
      }),
      ok: false,
    };
  }

  if (encoder.encode(parsed.canonical).byteLength > MAXIMUM_RUN_OUTPUT_CHARACTERS) {
    return {
      deliverable: jsonDeliverableSchema.options[1].parse({
        issues: [{ code: "bound", path: "$" }],
        kind: "json",
        mediaType: "application/json",
        repairAttempted,
        schema: {
          digest: contract.schema.digest,
          name: contract.schema.name,
          version: contract.schema.version,
        },
        state: "invalid",
      }),
      ok: false,
    };
  }

  return {
    ...parsed,
    deliverable: jsonDeliverableSchema.options[0].parse({
      contentDigest: await digest(parsed.canonical),
      kind: "json",
      mediaType: "application/json",
      repairAttempted,
      schema: {
        digest: contract.schema.digest,
        name: contract.schema.name,
        version: contract.schema.version,
      },
      sizeCharacters: parsed.canonical.length,
      sizeBytes: encoder.encode(parsed.canonical).byteLength,
      state: "valid",
    }),
  };
}

export function outputRepairPrompt(input: {
  candidate: string;
  contract: Extract<AdmittedOutputContract, { kind: "json" }>;
  issues: OutputValidationIssue[];
}): string {
  return [
    "Repair one candidate into exactly one JSON object matching the frozen schema.",
    "Do not add facts, commentary, Markdown, or tool calls. Preserve the candidate's intended content.",
    `Schema ${input.contract.schema.name} version ${input.contract.schema.version}:`,
    canonicalJson(input.contract.schema.jsonSchema),
    "Validation issues:",
    JSON.stringify(input.issues.slice(0, MAXIMUM_OUTPUT_VALIDATION_ISSUES)),
    "Candidate:",
    input.candidate,
  ].join("\n");
}
