import {
  crewAgentObjectName,
  crewAgentRuntimeConfigSchema,
  type CrewAgentRuntimeConfig,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { CrewAgent } from "../src/crew-agent.js";

function runtimeConfig(
  agentId = "agent_11111111-1111-4111-8111-111111111111",
): CrewAgentRuntimeConfig {
  return crewAgentRuntimeConfigSchema.parse({
    agentId,
    capabilityGrants: [],
    executionLimits: {
      maxDurationSeconds: 45,
      maxModelTokens: 2_000,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    instructions: "Return one concise, plain-text answer.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    ownerKey: `owner_${"A".repeat(43)}`,
    revision: 3,
  });
}

function seedRuntimeConfig(agent: CrewAgent, configuration: CrewAgentRuntimeConfig): void {
  const key = "_think_config";
  const serialized = JSON.stringify(configuration);

  void agent.sql`
    CREATE TABLE IF NOT EXISTS think_config (
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (key)
    )
  `;
  void agent.sql`
    INSERT OR REPLACE INTO think_config (key, value)
    VALUES (${key}, ${serialized})
  `;
}

function crewAgentNamespace(): DurableObjectNamespace<CrewAgent> {
  const namespace = env.CREW_AGENT;

  if (!namespace) {
    throw new Error("The test-only CrewAgent namespace is unavailable.");
  }

  return namespace;
}

describe("CrewAgent Think runtime", () => {
  it("derives a fail-closed zero-tool turn from one validated revision config", async () => {
    const configuration = runtimeConfig();
    const stub = crewAgentNamespace().getByName(crewAgentObjectName(configuration));

    await runInDurableObject(stub, async (agent) => {
      seedRuntimeConfig(agent, configuration);

      expect(agent.getModel()).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
      expect(agent.getSystemPrompt()).toBe("Return one concise, plain-text answer.");
      expect(agent.workspaceBash).toBe(false);
      expect(agent.includeMcpTools).toBe(false);
      expect(agent.waitForMcpConnections).toBe(false);
      expect(agent.fetchTools).toBe(false);
      expect(agent.storeMessages).toBe(false);
      expect(agent.storeTools).toBe(false);
      expect(agent.sendReasoning).toBe(false);
      expect(agent.beforeTurn()).toEqual({
        activeTools: [],
        chatStreamStallTimeoutMs: 45_000,
        maxOutputTokens: 2_000,
        maxSteps: 4,
        sendReasoning: false,
      });
      expect(agent.beforeTurn()).not.toHaveProperty("instructions");
      expect(agent.authorizeTurn()).toBe(false);
      expect(agent.authorizeAction()).toBe(false);
    });
  });

  it("denies inherited configuration and turn admission entrypoints", async () => {
    const configuration = runtimeConfig("agent_22222222-2222-4222-8222-222222222222");
    const stub = crewAgentNamespace().getByName(crewAgentObjectName(configuration));

    await runInDurableObject(stub, async (agent) => {
      expect(() => agent.configure(configuration)).toThrow(
        "CrewAgent runtime admission is not available.",
      );
      await expect(
        agent.runTurn({ input: "Attempt an unadmitted model turn.", mode: "wait" }),
      ).rejects.toThrow("CrewAgent runtime admission is not available.");
    });
    await expect(stub.fetch("https://crew-agent.test")).resolves.toMatchObject({
      status: 404,
    });
  });

  it("rejects configuration stored under a different owner or Agent object name", async () => {
    const configuration = runtimeConfig("agent_33333333-3333-4333-8333-333333333333");
    const wrongOwnerName = crewAgentObjectName({
      ...configuration,
      ownerKey: `owner_${"B".repeat(43)}`,
    });
    const wrongAgentName = crewAgentObjectName({
      ...configuration,
      agentId: "agent_44444444-4444-4444-8444-444444444444",
    });

    for (const objectName of [wrongOwnerName, wrongAgentName]) {
      const stub = crewAgentNamespace().getByName(objectName);

      await runInDurableObject(stub, (agent) => {
        seedRuntimeConfig(agent, configuration);

        expect(() => agent.getModel()).toThrow(
          "CrewAgent runtime configuration does not match this object.",
        );
      });
    }
  });

  it("fails closed when no validated runtime config has been installed", async () => {
    const configuration = runtimeConfig("agent_55555555-5555-4555-8555-555555555555");
    const stub = crewAgentNamespace().getByName(crewAgentObjectName(configuration));

    await runInDurableObject(stub, (agent) => {
      expect(() => agent.getModel()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => agent.getSystemPrompt()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
      expect(() => agent.beforeTurn()).toThrow(
        "CrewAgent runtime configuration is missing or invalid.",
      );
    });
  });
});
