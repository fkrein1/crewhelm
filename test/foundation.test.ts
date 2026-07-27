import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { workspaceBuildArguments } from "../scripts/build.mjs";
import { validateToolchain } from "../scripts/toolchain-policy.mjs";
import { verificationChecks } from "../scripts/verify.mjs";

const root = new URL("../", import.meta.url);
const pinnedPackageManager =
  "pnpm@11.17.0+sha512.cca3cea332ad254bb84145f966d19f4879615210346fc92c79a047f23a0d7b3cca3c3792f0076ba1f1831d277efbcf0a9119b31a9a60eca7fb3d6231f331ef72";

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source);

  if (!isRecord(value)) {
    throw new TypeError("Expected a JSON object.");
  }

  return value;
}

function parseYamlObject(source: string): Record<string, unknown> {
  const document = parseDocument(source, { uniqueKeys: true });

  if (document.errors.length > 0) {
    throw new TypeError(document.errors.map((error) => error.message).join("\n"));
  }

  const value: unknown = document.toJS();

  if (!isRecord(value)) {
    throw new TypeError("Expected a YAML object.");
  }

  return value;
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);

  if (!match?.[1]) {
    throw new TypeError("Expected YAML frontmatter.");
  }

  return parseYamlObject(match[1]);
}

function visitRecords(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitRecords(item, visitor);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  visitor(value);
  for (const child of Object.values(value)) {
    visitRecords(child, visitor);
  }
}

function workflowTriggers(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((trigger): trigger is string => typeof trigger === "string");
  }

  return isRecord(value) ? Object.keys(value) : [];
}

function hasExactPermissions(value: unknown, expected: Record<string, "read" | "write">): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).toSorted();
  const expectedKeys = Object.keys(expected).toSorted();

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key])
  );
}

function workflowPolicyErrors(name: string, workflow: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const triggers = workflowTriggers(workflow["on"]);
  const expectedPermissions: Record<string, "read" | "write"> =
    name === "codeql.yml" ? { contents: "read", "security-events": "write" } : { contents: "read" };

  if (triggers.length === 0) {
    errors.push("Workflow must declare a trigger.");
  }

  if (triggers.includes("pull_request_target")) {
    errors.push("pull_request_target is forbidden.");
  }

  if (!hasExactPermissions(workflow["permissions"], expectedPermissions)) {
    errors.push("Workflow permissions do not match the explicit allowlist.");
  }

  const jobs = workflow["jobs"];
  if (!isRecord(jobs)) {
    errors.push("Workflow must declare jobs.");
    return errors;
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (isRecord(job) && "permissions" in job) {
      errors.push(`Job ${jobName} must not override workflow permissions.`);
    }
  }

  return errors;
}

async function readWorkflows(): Promise<
  Array<{ name: string; workflow: Record<string, unknown> }>
> {
  const names = (await readdir(new URL(".github/workflows/", root)))
    .filter((name) => /\.ya?ml$/.test(name))
    .toSorted();

  return Promise.all(
    names.map(async (name) => ({
      name,
      workflow: parseYamlObject(await read(`.github/workflows/${name}`)),
    })),
  );
}

describe("repository foundation", () => {
  it("pins the runtime, package manager, and development dependencies", async () => {
    const manifest = parseJsonObject(await read("package.json"));
    const engines = manifest["engines"];
    const dependencies = manifest["devDependencies"];

    expect(isRecord(engines)).toBe(true);
    expect(isRecord(dependencies)).toBe(true);

    if (!isRecord(dependencies)) {
      throw new TypeError("Expected development dependencies.");
    }

    expect(manifest["name"]).toBe("crewhelm-monorepo");
    expect(manifest["private"]).toBe(true);
    expect(manifest["packageManager"]).toBe(pinnedPackageManager);
    expect(engines).toEqual({
      node: "24.18.0",
      pnpm: "11.17.0",
    });
    expect((await read(".nvmrc")).trim()).toBe("24.18.0");

    for (const version of Object.values(dependencies)) {
      expect(version).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/));
    }
  });

  it("enforces pnpm supply-chain controls without dormant lifecycle approvals", async () => {
    const workspace = parseYamlObject(await read("pnpm-workspace.yaml"));

    expect(workspace).toMatchObject({
      allowBuilds: {
        esbuild: true,
        workerd: true,
      },
      autoInstallPeers: false,
      blockExoticSubdeps: true,
      enableGlobalVirtualStore: false,
      engineStrict: true,
      minimumReleaseAge: 1440,
      minimumReleaseAgeIgnoreMissingTime: false,
      minimumReleaseAgeStrict: true,
      nodeVersion: "24.18.0",
      packages: ["apps/*", "packages/*", "tooling/*"],
      savePrefix: "",
      strictDepBuilds: true,
      strictPeerDependencies: true,
      trustPolicy: "no-downgrade",
      verifyDepsBeforeRun: "error",
    });
    expect(workspace).not.toHaveProperty("dangerouslyAllowAllBuilds");
    expect(workspace).not.toHaveProperty("trustLockfile");
  });

  it("keeps the verification gate complete and Vitest resource-bounded", async () => {
    const manifest = parseJsonObject(await read("package.json"));
    const scripts = manifest["scripts"];

    expect(isRecord(scripts)).toBe(true);
    expect([...verificationChecks]).toEqual(["format:check", "lint", "typecheck", "test", "build"]);
    expect([...workspaceBuildArguments]).toEqual([
      "--filter=!crewhelm-monorepo",
      "--workspace-concurrency=1",
      "--if-present",
      "run",
      "build",
    ]);
    expect(scripts).toMatchObject({
      build: "node ./scripts/build.mjs",
      "format:check": "oxfmt --check .",
      lint: "oxlint --type-aware --type-check --deny-warnings --report-unused-disable-directives .",
      test: "vitest run --maxWorkers=50%",
      "test:watch": "vitest --maxWorkers=50%",
      typecheck:
        "tsc --noEmit && tsc --noEmit --project apps/worker/tsconfig.json && tsc --noEmit --project apps/worker/test/tsconfig.json",
      verify: "node ./scripts/verify.mjs",
    });
  });

  it("pins the deployable Worker toolchain in its workspace manifest", async () => {
    const manifest = parseJsonObject(await read("apps/worker/package.json"));

    expect(manifest).toMatchObject({
      name: "@crewhelm/worker",
      private: true,
      scripts: {
        build: "wrangler deploy --dry-run --outdir dist",
      },
      dependencies: {
        "@crewhelm/composio": "workspace:*",
        "@crewhelm/contracts": "workspace:*",
        hono: "4.12.32",
      },
      devDependencies: {
        "@cloudflare/vitest-pool-workers": "0.18.8",
        "@cloudflare/workers-types": "5.20260724.1",
        vitest: "4.1.10",
        wrangler: "4.114.0",
      },
    });
  });

  it("pins the bootstrap CLI and shared provider and contract workspaces", async () => {
    const cliManifest = parseJsonObject(await read("apps/cli/package.json"));
    const composioManifest = parseJsonObject(await read("packages/composio/package.json"));
    const contractsManifest = parseJsonObject(await read("packages/contracts/package.json"));
    const coreManifest = parseJsonObject(await read("packages/core/package.json"));

    expect(cliManifest).toMatchObject({
      name: "@crewhelm/cli",
      private: true,
      bin: {
        crewhelm: "dist/crewhelm.js",
      },
      dependencies: {
        "@crewhelm/contracts": "workspace:*",
        zod: "4.4.3",
      },
      devDependencies: {
        esbuild: "0.28.1",
        vitest: "4.1.10",
      },
    });
    expect(composioManifest).toMatchObject({
      name: "@crewhelm/composio",
      private: true,
      dependencies: {
        "@crewhelm/contracts": "workspace:*",
        zod: "4.4.3",
      },
      exports: {
        ".": "./src/index.ts",
      },
    });
    expect(contractsManifest).toMatchObject({
      name: "@crewhelm/contracts",
      private: true,
      dependencies: {
        zod: "4.4.3",
      },
      exports: {
        ".": "./src/index.ts",
      },
    });
    expect(coreManifest).toMatchObject({
      name: "@crewhelm/core",
      private: true,
      dependencies: {
        "@crewhelm/contracts": "workspace:*",
      },
      exports: {
        ".": "./src/index.ts",
      },
    });
  });

  it("rejects drift from the pinned executable toolchain", () => {
    const validToolchain = {
      actualNodeVersion: "24.18.0",
      expectedNodeVersion: "24.18.0",
      expectedPackageManager: pinnedPackageManager,
      packageManagerExecutable: "/tooling/pnpm.cjs",
      userAgent: "pnpm/11.17.0 npm/? node/v24.18.0",
    };

    expect(validateToolchain(validToolchain)).toEqual([]);
    expect(
      validateToolchain({
        ...validToolchain,
        actualNodeVersion: "26.5.0",
      }),
    ).toContain("Expected Node.js 24.18.0, received 26.5.0.");
    expect(
      validateToolchain({
        ...validToolchain,
        packageManagerExecutable: "/tooling/npm-cli.js",
        userAgent: "npm/11.0.0 node/v24.18.0",
      }),
    ).toEqual(
      expect.arrayContaining([
        "Run verification through pnpm.",
        "The active package-manager executable must be pnpm.",
      ]),
    );
  });

  it("parses and constrains repository agent instructions", async () => {
    const instructions = await read("AGENTS.md");
    const context = await read("CONTEXT.md");
    const skill = await read(".agents/skills/crewhelm-development/SKILL.md");
    const frontmatter = parseFrontmatter(skill);
    const metadata = parseYamlObject(
      await read(".agents/skills/crewhelm-development/agents/openai.yaml"),
    );
    const bugDiagnosis = await read(
      ".agents/skills/crewhelm-development/references/bug-diagnosis.md",
    );
    const simplificationReview = await read(
      ".agents/skills/crewhelm-development/references/simplification-review.md",
    );

    expect(instructions).toContain(".agents/skills/crewhelm-development/SKILL.md");
    expect(instructions).toContain("docs/engineering/module-design.md");
    expect(instructions).toContain("docs/product/philosophy.md");
    expect(instructions).toContain("docs/architecture/system.md");
    expect(instructions).toContain("docs/engineering/code-philosophy.md");
    expect(instructions).toContain("git commit -s");
    expect(context).toContain("A recipe may request a capability");
    expect(frontmatter["name"]).toBe("crewhelm-development");

    const description = frontmatter["description"];
    expect(description).toEqual(expect.any(String));

    if (typeof description !== "string") {
      throw new TypeError("Expected a skill description.");
    }

    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill).toContain("Complete one observable objective at a time.");
    expect(skill).toContain("Prefer deep modules with small, explicit interfaces.");
    expect(skill).toContain("dependencies or lockfiles");
    expect(skill).toContain("references/simplification-review.md");
    expect(skill).toContain("git commit -s");
    expect(bugDiagnosis).toContain("Build the feedback loop first");
    expect(simplificationReview).toContain("would a clean implementation use a materially simpler");
    expect(simplificationReview).toContain("Clarity outranks line count");
    expect(metadata).toMatchObject({
      interface: {
        display_name: "Crewhelm Development",
        short_description: "Ship small, verified Crewhelm changes",
      },
    });
  });

  it("records product shaping, system ownership, and code simplification guardrails", async () => {
    const productPhilosophy = await read("docs/product/philosophy.md");
    const systemArchitecture = await read("docs/architecture/system.md");
    const codePhilosophy = await read("docs/engineering/code-philosophy.md");
    const controlPlaneDecision = await read(
      "docs/decisions/0002-owner-scoped-durable-object-control-plane.md",
    );
    const runtimeDecision = await read(
      "docs/decisions/0003-declarative-recipes-and-hardened-think.md",
    );

    for (const field of [
      "Problem and evidence:",
      "Appetite:",
      "Epicenter:",
      "Security and compatibility invariants:",
      "Stop or reshape condition:",
    ]) {
      expect(productPhilosophy).toContain(field);
    }

    expect(productPhilosophy).toContain("Composio is the integration and web plane");
    expect(productPhilosophy).toContain("owner-confirmed PR");
    expect(productPhilosophy).toContain("Updates never silently widen grants");
    expect(systemArchitecture).toContain("OwnerControlPlane");
    expect(systemArchitecture).toContain("D1 is not an authoritative store");
    expect(systemArchitecture).toContain("`ScheduleSpec`");
    expect(systemArchitecture).toContain("`TurnExecution`");
    expect(systemArchitecture).toContain("`WorkflowExecution`");
    expect(systemArchitecture).toContain("workspaceBash = false");
    expect(systemArchitecture).toContain("includeMcpTools = false");
    expect(systemArchitecture).toContain("Tool discovery is not authorization");
    expect(systemArchitecture).toContain("fresh MCP");
    expect(systemArchitecture).toContain("Only composition roots");
    expect(systemArchitecture).toContain("control plane owns admission and administration");
    expect(systemArchitecture).toContain("never fall through to `latest`");
    expect(systemArchitecture).toContain("Do not expose Composio Sessions");
    expect(systemArchitecture).toContain("Firecrawl is one Composio toolkit");
    expect(systemArchitecture).toContain("approval-required actions remain unavailable");
    expect(codePhilosophy).toContain("Correctness and security");
    expect(codePhilosophy).toContain("Given what this implementation taught us");
    expect(codePhilosophy).toContain("Never simplify away");
    expect(controlPlaneDecision).toContain("Status: accepted");
    expect(controlPlaneDecision).toContain("One SQLite-backed `OwnerControlPlane`");
    expect(runtimeDecision).toContain("Status: accepted");
    expect(runtimeDecision).toContain("one data-driven `CrewAgent`");
  });

  it("keeps GitHub workflows minimally privileged and immutable", async () => {
    const workflows = await readWorkflows();
    const dependabot = parseYamlObject(await read(".github/dependabot.yml"));
    const dependabotUpdates = dependabot["updates"];
    const pnpmSetupInputs: unknown[] = [];

    expect(workflows.length).toBeGreaterThan(0);
    expect(dependabot["version"]).toBe(2);
    expect(Array.isArray(dependabotUpdates)).toBe(true);

    if (!Array.isArray(dependabotUpdates)) {
      throw new TypeError("Expected Dependabot update configuration.");
    }

    const npmUpdates = dependabotUpdates.find(
      (update) => isRecord(update) && update["package-ecosystem"] === "npm",
    );
    const githubActionsUpdates = dependabotUpdates.find(
      (update) => isRecord(update) && update["package-ecosystem"] === "github-actions",
    );

    expect(npmUpdates).toMatchObject({
      groups: {
        "development-tooling": {
          "dependency-type": "development",
          "update-types": ["minor", "patch"],
        },
      },
      ignore: [
        {
          "dependency-name": "*",
          "update-types": ["version-update:semver-major"],
        },
      ],
    });
    expect(githubActionsUpdates).toMatchObject({
      groups: {
        "github-actions": {
          patterns: ["*"],
        },
      },
      ignore: [
        {
          "dependency-name": "*",
          "update-types": ["version-update:semver-major"],
        },
      ],
    });

    for (const { name, workflow } of workflows) {
      expect(workflowPolicyErrors(name, workflow)).toEqual([]);

      const externalActions: string[] = [];
      const checkoutSettings: unknown[] = [];
      const shellCommands: string[] = [];

      visitRecords(workflow, (record) => {
        const action = record["uses"];
        const command = record["run"];

        if (typeof action === "string" && !action.startsWith("./")) {
          externalActions.push(action);
        }

        if (typeof action === "string" && action.startsWith("actions/checkout@")) {
          checkoutSettings.push(record["with"]);
        }

        if (typeof action === "string" && action.startsWith("pnpm/action-setup@")) {
          pnpmSetupInputs.push(record["with"]);
        }

        if (typeof command === "string") {
          shellCommands.push(command);
        }
      });

      for (const action of externalActions) {
        expect(action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }

      for (const settings of checkoutSettings) {
        expect(settings).toEqual(expect.objectContaining({ "persist-credentials": false }));
      }

      for (const command of shellCommands) {
        expect(command).not.toContain("${{");
      }
    }

    expect(pnpmSetupInputs).toEqual([{ run_install: false }]);

    const workflowByName = Object.fromEntries(
      workflows.map(({ name, workflow }) => [name, workflow]),
    );
    expect(workflowTriggers(workflowByName["ci.yml"]?.["on"]).toSorted()).toEqual([
      "pull_request",
      "push",
    ]);
    expect(workflowTriggers(workflowByName["codeql.yml"]?.["on"]).toSorted()).toEqual([
      "pull_request",
      "push",
      "schedule",
    ]);
    expect(workflowTriggers(workflowByName["dependency-review.yml"]?.["on"])).toEqual([
      "pull_request",
    ]);

    const baseWorkflow = {
      jobs: { verify: { runsOn: "ubuntu-24.04", steps: [] } },
      permissions: { contents: "read" },
    };
    const forbiddenTriggerForms = [
      { ...baseWorkflow, on: "pull_request_target" },
      { ...baseWorkflow, on: ["pull_request", "pull_request_target"] },
      { ...baseWorkflow, on: { pull_request_target: {} } },
    ];

    for (const workflow of forbiddenTriggerForms) {
      expect(workflowPolicyErrors("ci.yml", workflow)).toContain(
        "pull_request_target is forbidden.",
      );
    }

    expect(
      workflowPolicyErrors("ci.yml", {
        ...baseWorkflow,
        jobs: {
          verify: {
            permissions: "write-all",
            steps: [],
          },
        },
        on: "pull_request",
      }),
    ).toContain("Job verify must not override workflow permissions.");
    expect(
      workflowPolicyErrors("ci.yml", {
        ...baseWorkflow,
        jobs: {
          verify: {
            permissions: { contents: "write" },
            steps: [],
          },
        },
        on: "pull_request",
      }),
    ).toContain("Job verify must not override workflow permissions.");

    const dependencyReview = workflows.find(({ name }) => name === "dependency-review.yml");
    expect(dependencyReview).toBeDefined();

    let dependencyReviewInputs: Record<string, unknown> | undefined;
    visitRecords(dependencyReview?.workflow, (record) => {
      if (
        typeof record["uses"] === "string" &&
        record["uses"].startsWith("actions/dependency-review-action@") &&
        isRecord(record["with"])
      ) {
        dependencyReviewInputs = record["with"];
      }
    });

    expect(dependencyReviewInputs).toMatchObject({
      "allow-dependencies-licenses": [
        "pkg:npm/json-schema-typed@8.0.2",
        "pkg:npm/rou3@0.7.12",
        "pkg:npm/@img/sharp-libvips-darwin-arm64@1.3.1",
        "pkg:npm/@img/sharp-libvips-darwin-x64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-arm64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-arm@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-ppc64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-riscv64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-s390x@1.3.1",
        "pkg:npm/@img/sharp-libvips-linux-x64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linuxmusl-arm64@1.3.1",
        "pkg:npm/@img/sharp-libvips-linuxmusl-x64@1.3.1",
      ].join(", "),
      "allow-licenses":
        "0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, CC0-1.0, ISC, MIT, Unlicense",
      "fail-on-scopes": "runtime, development, unknown",
      "fail-on-severity": "moderate",
      "license-check": true,
    });

    const continuousIntegration = workflows.find(({ name }) => name === "ci.yml");
    const continuousIntegrationCommands: string[] = [];
    visitRecords(continuousIntegration?.workflow, (record) => {
      if (typeof record["run"] === "string") {
        continuousIntegrationCommands.push(record["run"]);
      }
    });
    expect(continuousIntegrationCommands).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm verify",
    ]);
  });

  it("versions the protected main ruleset", async () => {
    const ruleset = parseJsonObject(await read(".github/rulesets/main.json"));
    const rules = ruleset["rules"];

    expect(ruleset).toMatchObject({
      bypass_actors: [],
      conditions: {
        ref_name: {
          exclude: [],
          include: ["~DEFAULT_BRANCH"],
        },
      },
      enforcement: "active",
      name: "Protected main",
      target: "branch",
    });
    expect(Array.isArray(rules)).toBe(true);

    if (!Array.isArray(rules)) {
      throw new TypeError("Expected ruleset rules.");
    }

    const ruleByType = Object.fromEntries(
      rules.filter(isRecord).map((rule) => [rule["type"], rule]),
    );
    expect(Object.keys(ruleByType).toSorted()).toEqual([
      "code_scanning",
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
    expect(ruleByType["pull_request"]?.["parameters"]).toMatchObject({
      allowed_merge_methods: ["rebase"],
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
    });
    expect(ruleByType["required_status_checks"]?.["parameters"]).toMatchObject({
      strict_required_status_checks_policy: true,
      required_status_checks: [
        { context: "Verify", integration_id: 15368 },
        { context: "Dependency review", integration_id: 15368 },
        { context: "Analyze JavaScript and TypeScript", integration_id: 15368 },
        { context: "DCO", integration_id: 1861 },
      ],
    });
    expect(ruleByType["code_scanning"]?.["parameters"]).toEqual({
      code_scanning_tools: [
        {
          alerts_threshold: "errors",
          security_alerts_threshold: "high_or_higher",
          tool: "CodeQL",
        },
      ],
    });
  });

  it("records the security, maintenance, and attribution foundation", async () => {
    const ignoredFiles = await read(".gitignore");
    const invariants = await read("docs/security/invariants.md");
    const threatModel = await read("docs/security/threat-model.md");
    const settings = await read("docs/maintainers/github-settings.md");
    const notices = await read("THIRD_PARTY_NOTICES.md");

    expect(ignoredFiles).toMatch(/^\.dev\.vars\*$/m);
    expect(ignoredFiles).toMatch(/^!\.dev\.vars\.example$/m);
    expect(invariants).toContain("Models may propose actions but cannot grant permissions");
    expect(threatModel).toContain("MCP client to Crewhelm's public OAuth and MCP ingress");
    expect(threatModel).toContain("Instruction poisoning");
    expect(threatModel).toContain("self-approval");
    expect(threatModel).toContain("raw Composio paths bypassing `ToolGate`");
    expect(settings).toContain("secret scanning and push protection");
    expect(settings).toContain("Developer Certificate of Origin");
    expect(settings).toContain("require zero approvals");
    expect(settings).toContain("Dependency review is a pull-request-only comparison");
    expect(settings).toContain("Disable merge commits and squash merges");
    expect(settings).toContain("Ruleset rollout and recovery");
    expect(notices).toContain("Copyright (c) 2026 Matt Pocock");
  });
});
