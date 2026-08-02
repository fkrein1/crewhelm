import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection, z } from "astro:content";

const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema({
    extend: z.object({
      area: z.string().trim().min(1),
      audience: z.enum(["owner", "operator", "mcp-client", "contributor"]),
      availability: z.literal("available"),
      sources: z.array(z.string().trim().min(1)).min(1),
      type: z.enum(["tutorial", "how-to", "explanation", "reference"]),
    }),
  }),
});

export const collections = { docs };
