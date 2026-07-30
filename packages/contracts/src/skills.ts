import * as z from "zod";

import { agentMutationIdempotencyKeySchema } from "./control-plane.js";
import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";
import { sha256DigestSchema } from "./capabilities.js";

export const MAXIMUM_SKILL_FILES = 64;
export const MAXIMUM_SKILL_FILE_BYTES = 64 * 1_024;
export const MAXIMUM_SKILL_PACKAGE_BYTES = 128 * 1_024;
export const MAXIMUM_SKILL_LIBRARY_BYTES = 256 * 1_024 * 1_024;
export const MAXIMUM_SKILLS = 100;
export const MAXIMUM_SKILL_VERSIONS = 100;

const textEncoder = new TextEncoder();
const safePathSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function serializedBytes(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isSafeSkillPath(path: string): boolean {
  if (path === "SKILL.md") {
    return true;
  }

  const [root, ...segments] = path.split("/");

  return (
    (root === "assets" || root === "references" || root === "scripts") &&
    segments.length > 0 &&
    segments.every((segment) => safePathSegment.test(segment))
  );
}

function isSafeText(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const codeUnit = content.charCodeAt(index);

    if (
      codeUnit !== 0x09 &&
      codeUnit !== 0x0a &&
      codeUnit !== 0x0d &&
      (codeUnit <= 0x1f || codeUnit === 0x7f)
    ) {
      return false;
    }
  }

  return true;
}

export const skillIdSchema = z
  .string()
  .regex(
    /^skill_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm Skill ID.",
  );
export const skillVersionSchema = z.number().int().positive().safe();
export const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/, "Expected a lowercase Skill name.");
export const skillDescriptionSchema = z.string().trim().min(1).max(320);
export const skillStatusSchema = z.enum(["active", "retired"]);
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafeSkillPath, "Expected SKILL.md or a safe assets, references, or scripts path.")
  .describe("SKILL.md or a relative path under assets/, references/, or scripts/.");
export const skillFileSchema = z
  .strictObject({
    content: z
      .string()
      .max(MAXIMUM_SKILL_FILE_BYTES)
      .refine(isSafeText, "Skill files must contain bounded UTF-8 text.")
      .refine(
        (content) => textEncoder.encode(content).byteLength <= MAXIMUM_SKILL_FILE_BYTES,
        "Skill file exceeds its byte budget.",
      ),
    path: skillFilePathSchema,
  })
  .describe("One UTF-8 Skill file up to 64 KiB. Binary assets are not accepted.");
export const skillFilesSchema = z
  .array(skillFileSchema)
  .min(1)
  .max(MAXIMUM_SKILL_FILES)
  .superRefine((files, context) => {
    const paths = files.map(({ path }) => path);

    if (!paths.includes("SKILL.md")) {
      context.addIssue({
        code: "custom",
        message: "Skill package requires SKILL.md.",
      });
    }

    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Skill package paths must be unique.",
      });
    }

    const skillFile = files.find(({ path }) => path === "SKILL.md");

    if (skillFile?.content.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "SKILL.md must not be empty.",
      });
    }
  })
  .transform((files) =>
    files.toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  );

const safeAttributionUrlSchema = z
  .url()
  .max(2_048)
  .refine((source) => {
    const url = new URL(source);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Expected an HTTPS attribution URL without credentials, query, or fragment.")
  .describe("HTTPS attribution URL without credentials, query, or fragment.");
export const skillProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("authored"),
  }),
  z.strictObject({
    commit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Expected a pinned Git commit digest."),
    kind: z.literal("repository"),
    source: safeAttributionUrlSchema,
  }),
  z.strictObject({
    kind: z.literal("web"),
    source: safeAttributionUrlSchema,
  }),
]);
export const skillPackageSchema = z
  .strictObject({
    description: skillDescriptionSchema,
    files: skillFilesSchema,
    name: skillNameSchema,
    provenance: skillProvenanceSchema,
  })
  .superRefine((skillPackage, context) => {
    if (serializedBytes(skillPackage) > MAXIMUM_SKILL_PACKAGE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Skill package exceeds its serialized byte budget.",
      });
    }
  })
  .describe("A UTF-8 package up to 128 KiB with one required SKILL.md file.");

export const skillWarningSchema = z.strictObject({
  code: z.enum(["executable_content", "suspected_secret"]),
  path: z.union([skillFilePathSchema, z.enum(["$description", "$provenance.source"])]),
});
export const skillPackageDescriptorSchema = z.strictObject({
  digest: sha256DigestSchema,
  fileCount: z.number().int().min(1).max(MAXIMUM_SKILL_FILES),
  sizeBytes: z.number().int().min(1).max(MAXIMUM_SKILL_PACKAGE_BYTES),
  warnings: z.array(skillWarningSchema).max(MAXIMUM_SKILL_FILES * 2 + 2),
});
export const skillPackageSummarySchema = z.strictObject({
  digest: sha256DigestSchema,
  fileCount: z.number().int().min(1).max(MAXIMUM_SKILL_FILES),
  sizeBytes: z.number().int().min(1).max(MAXIMUM_SKILL_PACKAGE_BYTES),
  warningCounts: z.strictObject({
    executableContent: z.number().int().min(0).max(MAXIMUM_SKILL_FILES),
    suspectedSecrets: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_SKILL_FILES + 2),
  }),
});
export const skillSummarySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  currentVersion: skillVersionSchema,
  description: skillDescriptionSchema,
  id: skillIdSchema,
  name: skillNameSchema,
  package: skillPackageSummarySchema,
  status: skillStatusSchema,
  updatedAt: z.iso.datetime(),
  versionCount: z.number().int().positive().max(MAXIMUM_SKILL_VERSIONS),
});
export const skillVersionRecordSchema = z.strictObject({
  contentTrust: z.literal("untrusted"),
  createdAt: z.iso.datetime(),
  description: skillDescriptionSchema,
  files: skillFilesSchema,
  id: skillIdSchema,
  name: skillNameSchema,
  package: skillPackageDescriptorSchema,
  provenance: skillProvenanceSchema,
  version: skillVersionSchema,
});

export const listSkillsInputSchema = z.strictObject({
  target: z.strictObject({
    cursor: skillIdSchema.optional(),
    kind: z.literal("skill-catalog"),
    limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(25),
    name: skillNameSchema
      .optional()
      .describe("Return Skills whose names contain this value, case-insensitively."),
    status: skillStatusSchema.optional(),
  }),
});
export const getSkillInputSchema = z.strictObject({
  target: z.strictObject({
    id: skillIdSchema,
    kind: z.literal("skill-package"),
    version: skillVersionSchema.optional(),
  }),
});

const changeModeSchema = z.enum(["preview", "apply"]);
export const publishSkillInputSchema = z
  .strictObject({
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: changeModeSchema,
    target: z
      .strictObject({
        expectedVersion: skillVersionSchema.optional(),
        id: skillIdSchema.optional(),
        kind: z.literal("skill-package"),
        package: skillPackageSchema,
        repairVersion: skillVersionSchema
          .describe("Exact stored version to restore without changing Skill lifecycle.")
          .optional(),
      })
      .superRefine((target, context) => {
        if (target.repairVersion !== undefined) {
          if (target.id === undefined || target.expectedVersion !== undefined) {
            context.addIssue({
              code: "custom",
              message: "Repairing requires Skill ID and repair version only.",
            });
          }

          return;
        }

        if ((target.id === undefined) !== (target.expectedVersion === undefined)) {
          context.addIssue({
            code: "custom",
            message: "Publishing a new version requires both Skill ID and expected version.",
          });
        }
      }),
  })
  .superRefine((input, context) => {
    if (input.mode === "apply" && input.idempotencyKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Apply mode requires an idempotency key.",
        path: ["idempotencyKey"],
      });
    }

    if (input.mode === "preview" && input.idempotencyKey !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Preview mode does not accept an idempotency key.",
        path: ["idempotencyKey"],
      });
    }
  });
export const retireSkillInputSchema = z
  .strictObject({
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: changeModeSchema,
    target: z.strictObject({
      expectedVersion: skillVersionSchema,
      id: skillIdSchema,
      kind: z.literal("skill-retirement"),
    }),
  })
  .superRefine((input, context) => {
    if (input.mode === "apply" && input.idempotencyKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Apply mode requires an idempotency key.",
        path: ["idempotencyKey"],
      });
    }

    if (input.mode === "preview" && input.idempotencyKey !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Preview mode does not accept an idempotency key.",
        path: ["idempotencyKey"],
      });
    }
  });

const skillRequestErrorSchema = z.strictObject({
  code: z.enum([
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "library_capacity_exceeded",
    "name_conflict",
    "no_changes",
    "owner_mismatch",
    "package_mismatch",
    "skill_limit_exceeded",
    "skill_not_found",
    "skill_retired",
    "suspected_secret",
    "version_conflict",
    "version_limit_exceeded",
  ]),
  message: z.literal("Skill request denied."),
});
const skillStorageErrorSchema = z.strictObject({
  code: z.enum(["skill_storage_corrupt", "skill_storage_unavailable"]),
  message: z.literal("Skill storage unavailable."),
  operation: z.strictObject({
    nextAction: z.enum(["contact_operator", "retry_same_request"]),
  }),
});
export const listSkillsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    nextCursor: skillIdSchema.nullable(),
    ok: z.literal(true),
    skills: z.array(skillSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
  }),
  z.strictObject({
    error: skillRequestErrorSchema,
    ok: z.literal(false),
  }),
]);
export const getSkillResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    skill: skillSummarySchema,
    version: skillVersionRecordSchema,
  }),
  z.strictObject({
    error: z.union([skillRequestErrorSchema, skillStorageErrorSchema]),
    ok: z.literal(false),
  }),
]);
export const publishSkillResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    ok: z.literal(true),
    package: skillPackageDescriptorSchema,
    skill: skillSummarySchema.optional(),
    version: skillVersionSchema,
  }),
  z.strictObject({
    error: z.union([skillRequestErrorSchema, skillStorageErrorSchema]),
    ok: z.literal(false),
  }),
]);
export const retireSkillResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    ok: z.literal(true),
    skill: skillSummarySchema,
  }),
  z.strictObject({
    error: z.union([skillRequestErrorSchema, skillStorageErrorSchema]),
    ok: z.literal(false),
  }),
]);

export type GetSkillResult = z.infer<typeof getSkillResultSchema>;
export type ListSkillsResult = z.infer<typeof listSkillsResultSchema>;
export type PublishSkillInput = z.infer<typeof publishSkillInputSchema>;
export type PublishSkillResult = z.infer<typeof publishSkillResultSchema>;
export type RetireSkillInput = z.infer<typeof retireSkillInputSchema>;
export type RetireSkillResult = z.infer<typeof retireSkillResultSchema>;
export type SkillPackage = z.infer<typeof skillPackageSchema>;
export type SkillPackageDescriptor = z.infer<typeof skillPackageDescriptorSchema>;
export type SkillProvenance = z.infer<typeof skillProvenanceSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillVersionRecord = z.infer<typeof skillVersionRecordSchema>;
export type SkillWarning = z.infer<typeof skillWarningSchema>;
