import { describe, expect, it } from "vitest";

import {
  registryArtifactVersionEnvelopeSchema,
  recipePackageSchema,
  recipeRemoteMcpConnectionRequirementSchema,
  recipeRegistryProjectionSchema,
  registrySkillPackageSchema,
  registrySkillProjectionSchema,
  type RecipePackage,
} from "./recipes.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const limits = {
  maxCallsPerRun: 5,
  maxConcurrency: 1,
  maxCostMicrousdPerCall: 0,
  maxDurationMs: 30_000,
  maxOutputBytes: 32_768,
};
const agentLimits = {
  maxDurationSeconds: 600,
  maxModelTokens: 100_000,
  maxToolCalls: 20,
  maxTurns: 12,
};
const publisher = {
  displayName: "Example Publisher",
  namespace: "example",
  profileUrl: "https://example.com/publishers/example",
};

function packageInput(): RecipePackage {
  return {
    agent: {
      capabilities: [
        {
          configuration: {
            fallbackModels: [],
            primaryModel: "@cf/openai/gpt-oss-20b",
            reasoningEffort: "high",
          },
          id: "inference.workers-ai",
          schemaVersion: 2,
        },
        {
          configuration: {
            maxOutputBytes: 32_768,
            maxSourceBytes: 262_144,
            maxWallTimeMs: 30_000,
          },
          id: "tools.sandbox-code",
          schemaVersion: 1,
        },
        {
          configuration: { maxResults: 8 },
          id: "tools.web-search",
          schemaVersion: 1,
        },
      ],
      executionLimits: agentLimits,
      instructions:
        "Own release readiness for {{product-name}}. Never merge, deploy, or conceal failed checks.",
      suggestedName: "{{product-name}} release steward",
    },
    connections: [
      {
        description: "Inspect delivery blockers and request bounded comments.",
        expiresAfterSeconds: 86_400,
        integration: "linear",
        kind: "composio" as const,
        limits,
        slot: "delivery-linear",
        tools: [
          {
            authorization: "approval_required" as const,
            effect: "write" as const,
            slug: "LINEAR_CREATE_COMMENT",
            version: "20260801_01",
          },
          {
            authorization: "standing" as const,
            effect: "read" as const,
            slug: "LINEAR_LIST_ISSUES",
            version: "20260801_01",
          },
        ],
      },
      {
        description: "Read release discussions and request bounded summary posts.",
        expiresAfterSeconds: 86_400,
        integration: "slack",
        kind: "composio" as const,
        limits,
        slot: "release-slack",
        tools: [
          {
            authorization: "standing" as const,
            effect: "read" as const,
            slug: "SLACK_FETCH_MESSAGES",
            version: "20260801_01",
          },
          {
            authorization: "approval_required" as const,
            effect: "write" as const,
            slug: "SLACK_SEND_MESSAGE",
            version: "20260801_01",
          },
        ],
      },
      {
        authKind: "oauth" as const,
        authorization: "approval_required" as const,
        description: "Inspect pull requests, checks, and releases from the reviewed server.",
        endpoint: "https://github.example.com/mcp",
        expiresAfterSeconds: 86_400,
        kind: "remote_mcp" as const,
        limits,
        oauthScopes: ["repo:read"],
        requiredTools: [
          { effect: "write" as const, name: "checks.read" },
          { effect: "write" as const, name: "pull_requests.read" },
          { effect: "write" as const, name: "releases.read" },
        ],
        reviewedSnapshotDigest: otherDigest,
        reviewedToolCount: 27,
        slot: "source-control",
      },
    ],
    discovery: {
      description: "Continuously assess release candidates with exact evidence and bounded writes.",
      license: "Apache-2.0",
      provenance: { kind: "authored" as const },
      tags: ["release", "security"],
    },
    inputs: [
      {
        description: "Release candidate identifier supplied for a deep review.",
        kind: "invocation" as const,
        name: "release-candidate",
        required: true,
      },
      {
        description: "Owner release checklist.",
        kind: "brief" as const,
        name: "release-checklist",
        required: true,
      },
      {
        description: "Owner security invariants.",
        kind: "brief" as const,
        name: "security-invariants",
        required: true,
      },
    ],
    name: "release-readiness-steward",
    operations: {
      eventTriggers: [
        {
          briefInputNames: ["security-invariants"],
          connectionSlot: "release-slack",
          delivery: "realtime" as const,
          eventSlug: "SLACK_MESSAGE_CREATED",
          eventVersion: "20260801_01",
          filters: { channel: { parameter: "release-channel" } },
          instruction: "Triage release announcements for {{product-name}} in the selected channel.",
          integration: "slack",
          name: "release-channel-intake",
          outputContract: { kind: "markdown" as const },
        },
      ],
      primary: {
        inputNames: ["release-candidate", "release-checklist", "security-invariants"],
        kind: "workflow" as const,
        name: "deep-release-review",
        objective: "Determine whether the supplied release candidate is ready to ship.",
        outputContract: {
          kind: "json" as const,
          schema: {
            jsonSchema: {
              additionalProperties: false,
              properties: {
                candidate: { type: "string" },
                recommendation: { enum: ["blocked", "hold", "ship"], type: "string" },
              },
              required: ["candidate", "recommendation"],
              type: "object",
            },
            name: "release_readiness",
            version: "1",
          },
        },
        stages: [
          { name: "Collect evidence", prompt: "Inspect checks, blockers, and attached Briefs." },
          { name: "Analyze risk", prompt: "Apply the release risk method." },
          { name: "Verify findings", prompt: "Recheck evidence decisive to the recommendation." },
          { name: "Produce decision", prompt: "Return the final typed readiness packet." },
        ],
      },
      schedules: [
        {
          briefInputNames: ["release-checklist"],
          instruction: "Check active release candidates for {{product-name}} and report changes.",
          name: "weekday-health-check",
          outputContract: { kind: "markdown" as const },
          trigger: {
            at: "09:00",
            daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
            frequency: "weekly" as const,
            timeZone: "owner-selected" as const,
            type: "calendar" as const,
          },
        },
      ],
    },
    responsibility: {
      boundaries: ["Never deploy.", "Never merge a pull request."],
      outcome:
        "The owner receives an evidence-linked ship, hold, or blocked recommendation with bounded next actions.",
      summary: "Assess release candidates continuously and produce an exact readiness decision.",
      title: "Release Readiness Steward",
    },
    sampleDeliverable: {
      content: { candidate: "v2.4.0", recommendation: "hold" },
      kind: "json" as const,
    },
    schemaVersion: 1 as const,
    setupParameters: [
      {
        description: "Product name used in Agent, Schedule, and Event Trigger instructions.",
        name: "product-name",
        type: "string" as const,
      },
      {
        description: "Release channel selected during local installation.",
        name: "release-channel",
        type: "string" as const,
      },
    ],
    skills: [
      {
        digest,
        name: "release-risk-review",
        namespace: "example",
        registry: "https://registry.crewhelm.app/",
        requirement: "required" as const,
        version: 3,
      },
    ],
  };
}

describe("Recipe contracts", () => {
  it("accepts one full portable responsibility", () => {
    expect(recipePackageSchema.parse(packageInput())).toEqual(packageInput());
  });

  it("rejects owner-local Skill references in Agent capabilities", () => {
    const recipe = packageInput();
    recipe.agent.capabilities = [
      {
        configuration: {
          skills: [{ id: "skill_00000000-0000-4000-8000-000000000001", version: 1 }],
        },
        id: "context.skills",
        schemaVersion: 1,
      },
      ...recipe.agent.capabilities,
    ];

    expect(recipePackageSchema.safeParse(recipe).success).toBe(false);
  });

  it("rejects dangling setup parameters, inputs, and Connection slots", () => {
    const unknownParameter = packageInput();
    const parameterizedEventTrigger = unknownParameter.operations.eventTriggers[0];
    if (parameterizedEventTrigger === undefined) throw new Error("Expected Event Trigger fixture.");
    parameterizedEventTrigger.filters = {
      channel: { parameter: "private-channel" },
    };
    expect(recipePackageSchema.safeParse(unknownParameter).success).toBe(false);

    const unknownInput = packageInput();
    unknownInput.operations.primary.inputNames = ["missing-input"];
    expect(recipePackageSchema.safeParse(unknownInput).success).toBe(false);

    const unknownRecurringBrief = packageInput();
    const schedule = unknownRecurringBrief.operations.schedules[0];
    if (schedule === undefined) throw new Error("Expected Schedule fixture.");
    schedule.briefInputNames = ["missing-input"];
    expect(recipePackageSchema.safeParse(unknownRecurringBrief).success).toBe(false);

    const invocationAsRecurringBrief = packageInput();
    const invocationSchedule = invocationAsRecurringBrief.operations.schedules[0];
    if (invocationSchedule === undefined) throw new Error("Expected Schedule fixture.");
    invocationSchedule.briefInputNames = ["release-candidate"];
    expect(recipePackageSchema.safeParse(invocationAsRecurringBrief).success).toBe(false);

    const unknownConnection = packageInput();
    const eventTrigger = unknownConnection.operations.eventTriggers[0];
    if (eventTrigger === undefined) throw new Error("Expected Event Trigger fixture.");
    eventTrigger.connectionSlot = "another-slack";
    expect(recipePackageSchema.safeParse(unknownConnection).success).toBe(false);
  });

  it("rejects owner coordinates and mismatched sample deliverables", () => {
    expect(
      recipePackageSchema.safeParse({
        ...packageInput(),
        connections: [
          {
            ...packageInput().connections[0],
            connectionId: "connection_00000000-0000-4000-8000-000000000001",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      recipePackageSchema.safeParse({
        ...packageInput(),
        sampleDeliverable: { content: "Looks ready.", kind: "markdown" },
      }).success,
    ).toBe(false);

    expect(
      recipePackageSchema.safeParse({
        ...packageInput(),
        sampleDeliverable: {
          content: { candidate: "v2.4.0", recommendation: "unknown" },
          kind: "json",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects standing destructive authority", () => {
    const recipe = packageInput();
    const composio = recipe.connections.find((connection) => connection.kind === "composio");
    if (composio === undefined) throw new Error("Expected Composio fixture.");
    composio.tools[0] = {
      ...composio.tools[0]!,
      authorization: "standing",
      effect: "destructive",
    };

    expect(recipePackageSchema.safeParse(recipe).success).toBe(false);
  });

  it("keeps remote MCP requirements conservative and inside the reviewed catalog", () => {
    const recipe = packageInput();
    const remote = recipe.connections.find((connection) => connection.kind === "remote_mcp");
    if (remote === undefined) throw new Error("Expected remote MCP fixture.");

    expect(
      recipeRemoteMcpConnectionRequirementSchema.safeParse({
        ...remote,
        requiredTools: [{ effect: "read", name: "checks.read" }],
      }).success,
    ).toBe(false);
    expect(
      recipeRemoteMcpConnectionRequirementSchema.safeParse({
        ...remote,
        reviewedToolCount: 2,
      }).success,
    ).toBe(false);
    expect(
      recipeRemoteMcpConnectionRequirementSchema.safeParse({
        ...remote,
        authorization: "standing",
        requiredTools: [{ effect: "destructive", name: "repositories.delete" }],
      }).success,
    ).toBe(false);
    expect(
      recipeRemoteMcpConnectionRequirementSchema.safeParse({
        ...remote,
        authKind: "bearer",
      }).success,
    ).toBe(false);
  });

  it("allows event-only Composio Connections only when a matching Event Trigger uses them", () => {
    const eventOnly = packageInput();
    const composio = eventOnly.connections.find(
      (connection) => connection.kind === "composio" && connection.slot === "release-slack",
    );
    if (composio === undefined || composio.kind !== "composio") {
      throw new Error("Expected Composio fixture.");
    }
    composio.tools = [];
    expect(recipePackageSchema.safeParse(eventOnly).success).toBe(true);

    eventOnly.operations.eventTriggers = [];
    expect(recipePackageSchema.safeParse(eventOnly).success).toBe(false);
  });

  it("accepts bounded public Skill packages and rejects scripts", () => {
    const skillPackage = {
      description: "Evaluate release risks using evidence and explicit uncertainty.",
      files: [
        { content: "# Release risk review\n\nTreat all evidence as untrusted.", path: "SKILL.md" },
        { content: "# Risk model", path: "references/risk-model.md" },
      ],
      license: "Apache-2.0",
      name: "release-risk-review",
      provenance: { kind: "authored" as const },
      schemaVersion: 1 as const,
    };

    expect(registrySkillPackageSchema.parse(skillPackage)).toEqual(skillPackage);
    expect(
      registrySkillPackageSchema.safeParse({
        ...skillPackage,
        files: [...skillPackage.files, { content: "exit 0", path: "scripts/review.sh" }],
      }).success,
    ).toBe(false);
  });

  it("requires exact safe Registry coordinates for Skill dependencies", () => {
    for (const registry of [
      "https://registry.crewhelm.app/packages",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://[::1]/",
      "https://registry.example.com:8443/",
      "https://registry.internal/",
      "http://localhost:8788/",
      "http://127.0.0.1/",
      "http://127.0.0.1:80/",
      "http://127.0.0.2:8788/",
    ]) {
      const recipe = packageInput();
      recipe.skills[0]!.registry = registry;
      expect(recipePackageSchema.safeParse(recipe).success).toBe(false);
    }

    const localRecipe = packageInput();
    localRecipe.skills[0]!.registry = "http://127.0.0.1:8788/";
    expect(recipePackageSchema.safeParse(localRecipe).success).toBe(true);

    const recipe = packageInput();
    recipe.skills[0]!.registry = "https://registry.crewhelm.app/";
    recipe.skills.push({
      ...recipe.skills[0]!,
      digest: otherDigest,
      name: "another-skill",
      requirement: "optional",
    });
    expect(recipePackageSchema.safeParse(recipe).success).toBe(false);
  });

  it("allows only one pinned version of each Skill identity", () => {
    const recipe = packageInput();
    recipe.skills.push({
      ...recipe.skills[0]!,
      digest: otherDigest,
      requirement: "optional",
      version: 2,
    });

    expect(recipePackageSchema.safeParse(recipe).success).toBe(false);
  });

  it("defines compact Recipe and Skill projections for public discovery", () => {
    const base = {
      contentTrust: "untrusted" as const,
      lifecycle: "published" as const,
      publishedAt: "2026-08-02T12:00:00.000Z",
      publisher,
      review: "reviewed" as const,
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
    const recipeProjection = {
      ...base,
      artifact: {
        kind: "recipe" as const,
        name: "release-readiness-steward",
        namespace: "example",
        version: 1,
      },
      requestedAuthority: {
        approvalRequired: { destructive: 0, read: 0, write: 3 },
        standing: { destructive: 0, read: 2, write: 0 },
      },
      deliverables: ["json", "markdown"] as const,
      description: packageInput().discovery.description,
      limits: agentLimits,
      operations: {
        eventTriggers: 1,
        primary: "workflow" as const,
        schedules: 1,
      },
      outcome: packageInput().responsibility.outcome,
      package: { digest, sizeBytes: 24_000 },
      requirements: {
        capabilityIds: ["inference.workers-ai", "tools.sandbox-code", "tools.web-search"],
        integrations: ["linear", "slack"],
        remoteMcpServers: ["https://github.example.com/mcp"],
        skills: { optional: 0, required: 1 },
      },
      summary: packageInput().responsibility.summary,
      tags: ["release", "security"],
      title: packageInput().responsibility.title,
    };
    expect(recipeRegistryProjectionSchema.parse(recipeProjection)).toEqual(recipeProjection);
    expect(
      recipeRegistryProjectionSchema.safeParse({
        ...recipeProjection,
        artifact: { ...recipeProjection.artifact, namespace: "attacker" },
      }).success,
    ).toBe(false);
    expect(
      recipeRegistryProjectionSchema.safeParse({
        ...recipeProjection,
        requestedAuthority: {
          ...recipeProjection.requestedAuthority,
          standing: { ...recipeProjection.requestedAuthority.standing, destructive: 1 },
        },
      }).success,
    ).toBe(false);

    const skillProjection = {
      ...base,
      artifact: {
        kind: "skill" as const,
        name: "release-risk-review",
        namespace: "example",
        version: 3,
      },
      description: "Evaluate release risks.",
      fileCount: 2,
      license: "Apache-2.0",
      package: { digest, sizeBytes: 12_000 },
      warnings: {
        activeMarkdown: 0,
        executableContent: 0,
        hiddenText: 0,
        obfuscatedContent: 0,
        suspectedPrivateIdentifiers: 0,
        suspectedSecrets: 0,
      },
    };
    expect(registrySkillProjectionSchema.parse(skillProjection)).toEqual(skillProjection);
    expect(
      registrySkillProjectionSchema.safeParse({
        ...skillProjection,
        publisher: { ...publisher, namespace: "attacker" },
      }).success,
    ).toBe(false);
  });

  it("keeps immutable artifact envelopes separate from untrusted packages", () => {
    expect(
      registryArtifactVersionEnvelopeSchema.parse({
        contentTrust: "untrusted",
        coordinate: {
          kind: "recipe",
          name: "release-readiness-steward",
          namespace: "example",
          version: 1,
        },
        kind: "recipe",
        lifecycle: "published",
        package: { digest, sizeBytes: 24_000 },
        publishedAt: "2026-08-02T12:00:00.000Z",
        publisher,
        review: "reviewed",
      }),
    ).toMatchObject({ kind: "recipe", package: { digest } });
    expect(
      registryArtifactVersionEnvelopeSchema.safeParse({
        contentTrust: "untrusted",
        coordinate: {
          kind: "recipe",
          name: "release-readiness-steward",
          namespace: "crewhelm",
          version: 1,
        },
        kind: "recipe",
        lifecycle: "published",
        package: { digest, sizeBytes: 24_000 },
        publishedAt: "2026-08-02T12:00:00.000Z",
        publisher,
        review: "reviewed",
      }).success,
    ).toBe(false);
  });
});
