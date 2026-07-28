import {
  OWNER_READ_SCOPE,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type CreateConnectionLinkInput,
  type OwnerAuthority,
  type OwnerScope,
  type UpdateAgentInput,
} from "@crewhelm/contracts";

import { deriveOwnerKey } from "./identity.js";

export async function authorityFor(
  subject: string,
  scopes: OwnerScope[] = [OWNER_READ_SCOPE],
  clientId = "https://client.example/mcp.json",
): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId,
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject,
    }),
    scopes,
  });
}

export function agentInput(idempotencyKey: string, name = "Inbox triage"): CreateAgentInput {
  return {
    executionLimits: {
      maxDurationSeconds: 300,
      maxModelTokens: 20_000,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    idempotencyKey,
    instructions: "Sort new work into a concise priority list.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name,
  };
}

export function agentUpdate(
  agent: { id: string; revision: number },
  idempotencyKey: string,
  name = "Inbox coordinator",
): UpdateAgentInput {
  return {
    executionLimits: {
      maxDurationSeconds: 600,
      maxModelTokens: 40_000,
      maxToolCalls: 8,
      maxTurns: 8,
    },
    expectedRevision: agent.revision,
    id: agent.id,
    idempotencyKey,
    instructions: "Coordinate the inbox with the owner's approved tools.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name,
  };
}

export function fixedAgentFailure(code: string) {
  return {
    error: {
      code,
      message: "Agent request denied.",
    },
    ok: false,
  };
}

export function connectionLinkInput(
  idempotencyKey: string,
  authConfigId = "ac_github_managed",
): CreateConnectionLinkInput {
  return {
    authConfigId,
    idempotencyKey,
  };
}

export function fixedConnectionLinkFailure(code: string) {
  return {
    error: {
      code,
      message: "Connection link request denied.",
    },
    ok: false,
  };
}

export function fixedConnectionReadFailure(code: string) {
  return {
    error: {
      code,
      message: "Connection request denied.",
    },
    ok: false,
  };
}

export function fixedConnectionAuthorizationReturnFailure() {
  return {
    error: {
      code: "invalid_return",
      message: "Connection authorization return denied.",
    },
    ok: false,
  };
}

export function fixedRunAdmissionFailure(code: string) {
  return {
    error: {
      code,
      message: "Run admission denied.",
    },
    ok: false,
  };
}
