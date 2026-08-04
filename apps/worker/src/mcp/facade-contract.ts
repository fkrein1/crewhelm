import { agentIdSchema, agentRevisionNumberSchema } from "@crewhelm/contracts";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

import type { FacadeOperationKind } from "./facade-operation-descriptions.js";
import type { PrivateToolCatalog } from "./private-tool-catalog.js";

export const facadeAgentReferenceSchema = z
  .looseObject({
    id: agentIdSchema,
    revision: agentRevisionNumberSchema,
  })
  .describe("Copy-ready Agent identity and immutable revision returned by Crewhelm.")
  .meta({ id: "CrewhelmAgentReference" });

export const facadeConfirmationSchema = z
  .boolean()
  .default(false)
  .describe("Leave false to preview. Repeat the unchanged operation with true to apply it.");

export const facadeRequestKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/)
  .optional()
  .describe("Optional retry identity. Omit it on the ordinary happy path.");

interface AgentCoordinateFields {
  id: string;
  revision: string;
}

interface ReferenceMapping {
  fields: Readonly<Record<string, string>>;
  name: string;
  schema: z.ZodType;
  toPrivate?: (value: unknown) => Record<string, unknown>;
}

export interface FacadeOperation {
  action?: string;
  agentCoordinates?: AgentCoordinateFields;
  confirmation?: boolean;
  descriptions?: Readonly<Record<string, string>>;
  kind: FacadeOperationKind;
  omit?: readonly string[];
  only?: readonly string[];
  privateDefaults?: Readonly<Record<string, unknown>>;
  privateTool: string;
  publicSchema?: z.ZodObject;
  run?: (
    catalog: PrivateToolCatalog,
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<CallToolResult>;
  references?: readonly ReferenceMapping[];
  required?: readonly string[];
  rename?: Readonly<Record<string, string>>;
  retryKey?: boolean;
  schemaAlias?: string;
  schemaKinds?: readonly [string, ...string[]];
  targetKind?: string;
  toPrivate?: (input: Record<string, unknown>, extra: unknown) => Record<string, unknown>;
  publicFields?: Readonly<Record<string, z.ZodType>>;
  transformFields?: Readonly<Record<string, (value: unknown) => unknown>>;
}

export interface FacadeToolDefinition {
  annotations: ToolAnnotations;
  description: string;
  name: string;
  operations: readonly FacadeOperation[];
  title: string;
}

export const CLOSED_READ_FACADE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

export const CLOSED_CHANGE_FACADE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};

export const OPEN_READ_FACADE: ToolAnnotations = {
  ...CLOSED_READ_FACADE,
  openWorldHint: true,
};

export const OPEN_CHANGE_FACADE: ToolAnnotations = {
  ...CLOSED_CHANGE_FACADE,
  openWorldHint: true,
};
