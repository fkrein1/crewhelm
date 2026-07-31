import {
  agentCapabilityConfigurationSchema,
  agentSkillReferenceSchema,
  SKILLS_CAPABILITY_ID,
  SKILLS_CAPABILITY_SCHEMA_VERSION,
  type AgentCapabilityConfiguration,
  type skillIdSchema,
  type skillVersionSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import type { AgentCapabilityModule } from "./kernel.js";

export { SKILLS_CAPABILITY_ID, SKILLS_CAPABILITY_SCHEMA_VERSION };

const skillConfigurationReferenceSchema = agentSkillReferenceSchema.omit({
  moduleId: true,
  schemaVersion: true,
});

export const skillsCapabilityConfigurationSchema = z.strictObject({
  skills: z
    .array(skillConfigurationReferenceSchema)
    .min(1)
    .max(8)
    .superRefine((skills, context) => {
      const identities = skills.map(({ id, version }) => `${id}:${version}`);

      if (new Set(identities).size !== identities.length) {
        context.addIssue({
          code: "custom",
          message: "Skill references must be unique.",
        });
      }
    })
    .transform((skills) =>
      skills.toSorted((left, right) =>
        left.id === right.id ? left.version - right.version : left.id.localeCompare(right.id),
      ),
    ),
});

export function skillsCapabilityConfiguration(
  skills: readonly {
    id: z.infer<typeof skillIdSchema>;
    version: z.infer<typeof skillVersionSchema>;
  }[],
): AgentCapabilityConfiguration {
  const configuration = skillsCapabilityConfigurationSchema.parse({ skills });

  return agentCapabilityConfigurationSchema.parse({
    configuration,
    id: SKILLS_CAPABILITY_ID,
    schemaVersion: SKILLS_CAPABILITY_SCHEMA_VERSION,
  });
}

export const skillsCapabilityModule: AgentCapabilityModule<
  z.infer<typeof skillsCapabilityConfigurationSchema>
> = {
  configurationSchema: skillsCapabilityConfigurationSchema,
  descriptor: {
    configurationFields: [
      {
        description: 'One to eight exact references shaped as [{"id":"skill_...","version":1}].',
        name: "skills",
        required: true,
        type: "list",
      },
    ],
    description: "Attaches versioned Skill instructions to admitted Agent runs.",
    id: SKILLS_CAPABILITY_ID,
    prerequisites: [],
    schemaVersion: SKILLS_CAPABILITY_SCHEMA_VERSION,
    title: "Skills",
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  },
  resolve(configuration) {
    return {
      contributions: configuration.skills.map((skill) => ({
        kind: "skill-reference" as const,
        skill,
      })),
      ok: true,
    };
  },
};
