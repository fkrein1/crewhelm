import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { workspaceBuildArguments } from "../scripts/build.mjs";
import { normalizeSourceMapText } from "../scripts/normalize-source-map.mjs";
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
  const forbiddenTriggers = ["issue_comment", "pull_request_target", "workflow_run"];
  const expectedPermissions: Record<string, "read" | "write"> =
    name === "codeql.yml" || name === "release-cli.yml" ? {} : { contents: "read" };

  if (triggers.length === 0) {
    errors.push("Workflow must declare a trigger.");
  }

  for (const trigger of forbiddenTriggers) {
    if (triggers.includes(trigger)) {
      errors.push(`${trigger} is forbidden.`);
    }
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
    if (!isRecord(job)) {
      continue;
    }

    const expectedJobPermissions =
      name === "codeql.yml" && jobName === "analyze"
        ? { contents: "read" as const, "security-events": "write" as const }
        : name === "release-cli.yml" && jobName === "package"
          ? {
              attestations: "write" as const,
              contents: "read" as const,
              "id-token": "write" as const,
            }
          : name === "release-cli.yml" && jobName === "release"
            ? { contents: "write" as const }
            : name === "release-cli.yml" && jobName === "publish"
              ? { "id-token": "write" as const }
              : undefined;

    if (
      expectedJobPermissions
        ? !hasExactPermissions(job["permissions"], expectedJobPermissions)
        : "permissions" in job
    ) {
      errors.push(`Job ${jobName} must not override workflow permissions.`);
    }

    if (job["runs-on"] !== "ubuntu-24.04") {
      errors.push(`Job ${jobName} must use the pinned GitHub-hosted runner.`);
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
        "@mongodb-js/zstd": false,
        "core-js-pure": false,
        esbuild: true,
        "node-liblzma": false,
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
      overrides: {
        "@esbuild-kit/core-utils>esbuild": "0.25.12",
        "@hono/node-server": "2.0.10",
        "partyserver@0.5.8>@cloudflare/workers-types": ">=4.20260424.1 <6",
      },
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

  it("normalizes packaged Worker source maps across build roots", () => {
    const sourceMap = {
      version: 3,
      sources: ["../../src/index.ts"],
      sourcesContent: ["export {};"],
    };
    const first = normalizeSourceMapText(
      JSON.stringify({ ...sourceMap, sourceRoot: "/home/runner/work/crewhelm" }),
    );
    const second = normalizeSourceMapText(
      JSON.stringify({ ...sourceMap, sourceRoot: "/Users/example/crewhelm" }),
    );

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({ sourceRoot: "." });
    expect(() => normalizeSourceMapText("[]")).toThrow("Source map must be a JSON object.");
  });

  it("keeps the verification gate complete and Vitest resource-bounded", async () => {
    const manifest = parseJsonObject(await read("package.json"));
    const scripts = manifest["scripts"];

    expect(isRecord(scripts)).toBe(true);
    expect([...verificationChecks]).toEqual([
      "format:check",
      "lint",
      "typecheck",
      "test",
      "build",
      "release:check",
    ]);
    expect([...workspaceBuildArguments]).toEqual([
      "--filter=!crewhelm-monorepo",
      "--workspace-concurrency=1",
      "--if-present",
      "run",
      "build",
    ]);
    expect(scripts).toMatchObject({
      build: "node ./scripts/build.mjs",
      "docs:mcp": "vitest run apps/worker/src/mcp/documentation.test.ts --update --maxWorkers=50%",
      "docs:mcp:check": "vitest run apps/worker/src/mcp/documentation.test.ts --maxWorkers=50%",
      "format:check": "oxfmt --check .",
      lint: "oxlint --type-aware --type-check --deny-warnings --report-unused-disable-directives .",
      "release:check": "node apps/cli/scripts/release-package.mjs",
      test: "vitest run --maxWorkers=50%",
      "test:watch": "vitest --maxWorkers=50%",
      typecheck:
        "tsc --noEmit && tsc --noEmit --project apps/worker/tsconfig.json && tsc --noEmit --project apps/worker/src/tsconfig.json",
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
        "db:control-plane:generate": "node ./scripts/generate-control-plane-migrations.mjs",
      },
      dependencies: {
        "@cloudflare/think": "0.15.0",
        "@crewhelm/composio": "workspace:*",
        "@crewhelm/contracts": "workspace:*",
        agents: "0.19.0",
        ai: "7.0.37",
        "drizzle-orm": "0.45.2",
        hono: "4.12.32",
        react: "19.2.8",
      },
      devDependencies: {
        "@babel/core": "8.0.1",
        "@cloudflare/vitest-pool-workers": "0.18.8",
        "@cloudflare/workers-types": "5.20260724.1",
        "drizzle-kit": "0.31.10",
        vitest: "4.1.10",
        wrangler: "4.114.0",
      },
    });
  });

  it("keeps control-plane Drizzle migrations complete and runtime queries typed", async () => {
    const journal = parseJsonObject(
      await read("apps/worker/control-plane-migrations/meta/_journal.json"),
    );
    const entries = journal["entries"];
    const manifest = await read("apps/worker/control-plane-migrations/index.ts");
    const migrationFiles = (await readdir(new URL("apps/worker/control-plane-migrations/", root)))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .toSorted();
    const ownerControlPlane = await read("apps/worker/src/owner/durable-object.ts");

    expect(journal["dialect"]).toBe("sqlite");
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) {
      throw new TypeError("Expected a Drizzle migration journal.");
    }

    expect(migrationFiles).toEqual(
      entries.map((entry, index) => {
        if (!isRecord(entry) || entry["idx"] !== index || typeof entry["tag"] !== "string") {
          throw new TypeError("Expected contiguous Drizzle migration entries.");
        }

        expect(manifest).toContain(`import migration${index} from "./${entry["tag"]}.sql";`);
        expect(manifest).toContain(`version: ${index + 1},`);

        return `${entry["tag"]}.sql`;
      }),
    );
    expect(manifest).toContain(
      "export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;",
    );
    expect(ownerControlPlane.match(/\.sql\.exec\(/g)).toEqual([".sql.exec("]);
    expect(ownerControlPlane).toContain('this.#storage.sql.exec("PRAGMA foreign_keys = ON");');
  });

  it("wires the admitted CrewAgent runtime into production bindings and exports", async () => {
    const workerEntry = await read("apps/worker/src/index.ts");
    const wrangler = await read("apps/worker/wrangler.jsonc");

    expect(workerEntry).toContain(
      'export { CrewAgent, CrewSession } from "./agent/durable-object.js";',
    );
    expect(wrangler).toMatch(/"ai"\s*:\s*\{\s*"binding"\s*:\s*"AI"/);
    expect(wrangler).toMatch(/"name"\s*:\s*"CREW_AGENT"\s*,\s*"class_name"\s*:\s*"CrewAgent"/);
    expect(wrangler).toMatch(/"name"\s*:\s*"CREW_SESSION"\s*,\s*"class_name"\s*:\s*"CrewSession"/);
    expect(wrangler).toMatch(
      /"CrewAgent"\s*:\s*\{\s*"type"\s*:\s*"durable-object"\s*,\s*"storage"\s*:\s*"sqlite"/,
    );
    expect(wrangler).toMatch(
      /"CrewSession"\s*:\s*\{\s*"type"\s*:\s*"durable-object"\s*,\s*"storage"\s*:\s*"sqlite"/,
    );
  });

  it("keeps Worker capability modules behind their composition roots", async () => {
    const sourcePaths = (await readdir(new URL("apps/worker/src/", root), { recursive: true })).map(
      (path) => path.replaceAll("\\", "/"),
    );
    const productionPaths = sourcePaths.filter((path) => {
      const fileName = posix.basename(path);

      return (
        path.endsWith(".ts") &&
        !fileName.endsWith(".test.ts") &&
        !fileName.startsWith("test") &&
        !fileName.includes("-test-")
      );
    });
    const productionSources = await Promise.all(
      productionPaths.map((path) => read(`apps/worker/src/${path}`)),
    );
    const boundaryViolations = productionPaths.flatMap((path, index) => {
      const source = productionSources[index] ?? "";
      const importedPaths = [
        ...source.matchAll(/(?:\bfrom\s+|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g),
      ].flatMap((match) => {
        const specifier = match[1];

        return specifier === undefined
          ? []
          : [posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, ".ts")];
      });
      const importsCompositionRoot =
        /^(agent|owner)\/[^/]+\//.test(path) &&
        importedPaths.some(
          (importedPath) =>
            importedPath === "agent/durable-object.ts" ||
            importedPath === "owner/durable-object.ts",
        );
      const importsCapabilityInternals = importedPaths.some((importedPath) => {
        const importedCapability = /^(agent|owner)\/([^/]+)\//.exec(importedPath);

        return (
          importedCapability !== null &&
          !path.startsWith(`${importedCapability[1]}/${importedCapability[2]}/`) &&
          importedPath !== `${importedCapability[1]}/${importedCapability[2]}/index.ts`
        );
      });
      const crossesAdmittedRunOwnership =
        path.startsWith("agent/admitted-runs/") &&
        importedPaths.some((importedPath) => importedPath.startsWith("owner/"));
      const bypassesMcpComposition =
        path.startsWith("mcp/") &&
        path !== "mcp/server.ts" &&
        importedPaths.some(
          (importedPath) => importedPath === "mcp/server.ts" || importedPath.startsWith("http/"),
        );

      return importsCompositionRoot ||
        importsCapabilityInternals ||
        crossesAdmittedRunOwnership ||
        bypassesMcpComposition
        ? [path]
        : [];
    });

    expect(sourcePaths.filter((path) => !path.includes("/") && path.endsWith(".test.ts"))).toEqual(
      [],
    );
    expect(boundaryViolations).toEqual([]);
  });

  it("pins the bootstrap CLI and shared provider and contract workspaces", async () => {
    const cliManifest = parseJsonObject(await read("apps/cli/package.json"));
    const composioManifest = parseJsonObject(await read("packages/composio/package.json"));
    const contractsManifest = parseJsonObject(await read("packages/contracts/package.json"));

    expect(cliManifest).toMatchObject({
      name: "@crewhelm/cli",
      version: "0.1.0-beta.2",
      bin: {
        crewhelm: "dist/crewhelm.js",
      },
      dependencies: {
        wrangler: "4.114.0",
      },
      devDependencies: {
        "@crewhelm/contracts": "workspace:*",
        "@crewhelm/design": "workspace:*",
        chalk: "6.0.0",
        commander: "15.0.0",
        esbuild: "0.28.1",
        vitest: "4.1.10",
        zod: "4.4.3",
      },
      engines: {
        node: ">=24.18.0 <25",
      },
      files: ["dist", "README.md", "LICENSE", "npm-shrinkwrap.json"],
      license: "MIT",
      publishConfig: {
        access: "public",
        tag: "beta",
      },
      scripts: {
        build: "node ./scripts/build.mjs",
        "release:lock": "node ./scripts/generate-runtime-lock.mjs",
        "release:pack": "node ./scripts/release-package.mjs",
      },
    });
    expect(cliManifest).not.toHaveProperty("private");
    expect(cliManifest).not.toHaveProperty("optionalDependencies");
    const cliScripts = cliManifest["scripts"];
    expect(isRecord(cliScripts)).toBe(true);
    if (!isRecord(cliScripts)) {
      throw new TypeError("Expected CLI scripts.");
    }
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublish",
      "prepublishOnly",
      "postpublish",
    ]) {
      expect(cliScripts).not.toHaveProperty(lifecycle);
    }
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
    const productPhilosophy = await read("docs/product/philosophy.md");
    const systemArchitecture = await read("docs/architecture/system.md");
    const engineeringDesign = await read("docs/engineering/design.md");
    const securityInvariants = await read("docs/security/invariants.md");
    const frontmatter = parseFrontmatter(skill);
    const metadata = parseYamlObject(
      await read(".agents/skills/crewhelm-development/agents/openai.yaml"),
    );

    expect(instructions).toContain(".agents/skills/crewhelm-development/SKILL.md");
    expect(context).not.toHaveLength(0);
    expect(productPhilosophy).not.toHaveLength(0);
    expect(systemArchitecture).not.toHaveLength(0);
    expect(engineeringDesign).not.toHaveLength(0);
    expect(securityInvariants).not.toHaveLength(0);
    expect(frontmatter["name"]).toBe("crewhelm-development");

    const description = frontmatter["description"];
    expect(description).toEqual(expect.any(String));

    if (typeof description !== "string") {
      throw new TypeError("Expected a skill description.");
    }

    expect(description.length).toBeLessThanOrEqual(1024);
    expect(metadata).toMatchObject({
      interface: {
        display_name: "Crewhelm Development",
        short_description: "Ship small, verified Crewhelm changes",
      },
    });
  });

  it("keeps GitHub workflows minimally privileged and immutable", async () => {
    const workflows = await readWorkflows();
    const dependabot = parseYamlObject(await read(".github/dependabot.yml"));
    const dependabotUpdates = dependabot["updates"];
    const pnpmSetupInputs: unknown[] = [];
    const pullRequestAuthorityViolations: string[] = [];
    const allowedActions = new Set([
      "actions/checkout",
      "actions/dependency-review-action",
      "actions/download-artifact",
      "actions/setup-node",
      "actions/attest",
      "actions/upload-artifact",
      "github/codeql-action/analyze",
      "github/codeql-action/init",
      "pnpm/action-setup",
      "zizmorcore/zizmor-action",
    ]);

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
      cooldown: {
        "default-days": 7,
      },
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
      cooldown: {
        "default-days": 7,
      },
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
      const serializedWorkflow = JSON.stringify(workflow);

      if (workflowTriggers(workflow["on"]).includes("pull_request")) {
        if (/\bsecrets(?:\.|\[)/.test(serializedWorkflow)) {
          pullRequestAuthorityViolations.push(`${name} references secrets.`);
        }

        if (serializedWorkflow.includes('"id-token"')) {
          pullRequestAuthorityViolations.push(`${name} requests OIDC authority.`);
        }
      }

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
        expect(allowedActions).toContain(action.slice(0, action.lastIndexOf("@")));
      }

      for (const settings of checkoutSettings) {
        expect(settings).toEqual(expect.objectContaining({ "persist-credentials": false }));
      }

      for (const command of shellCommands) {
        expect(command).not.toContain("${{");
      }
    }

    expect(pullRequestAuthorityViolations).toEqual([]);
    expect(pnpmSetupInputs.length).toBeGreaterThan(0);
    for (const inputs of pnpmSetupInputs) {
      expect(inputs).toEqual({ run_install: false });
    }

    const workflowByName = Object.fromEntries(
      workflows.map(({ name, workflow }) => [name, workflow]),
    );
    expect(workflowTriggers(workflowByName["actions-security.yml"]?.["on"]).toSorted()).toEqual([
      "pull_request",
      "push",
    ]);
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
    expect(workflowTriggers(workflowByName["release-cli.yml"]?.["on"])).toEqual(["push"]);

    const releaseWorkflow = workflowByName["release-cli.yml"];
    expect(releaseWorkflow?.["on"]).toEqual({
      push: {
        tags: ["cli-v*"],
      },
    });
    const releaseJobs = releaseWorkflow?.["jobs"];
    expect(isRecord(releaseJobs)).toBe(true);
    if (!isRecord(releaseJobs)) {
      throw new TypeError("Expected release workflow jobs.");
    }
    const packageJob = releaseJobs["package"];
    expect(isRecord(packageJob)).toBe(true);
    if (!isRecord(packageJob)) {
      throw new TypeError("Expected package job.");
    }
    const packageSteps = Array.isArray(packageJob["steps"]) ? packageJob["steps"] : [];
    const packageStepNames = packageSteps.map((step) =>
      isRecord(step) && typeof step["name"] === "string" ? step["name"] : "",
    );
    expect(packageStepNames.indexOf("Require a release commit from main")).toBeLessThan(
      packageStepNames.indexOf("Install pnpm"),
    );
    expect(packageSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Install Node.js",
          with: {
            "node-version-file": ".nvmrc",
            "package-manager-cache": false,
          },
        }),
        expect.objectContaining({
          name: "Install dependencies",
          run: "pnpm install --frozen-lockfile --ignore-scripts",
        }),
      ]),
    );
    expect(releaseJobs["publish"]).toMatchObject({
      environment: "cli-release",
      needs: "package",
      permissions: { "id-token": "write" },
    });
    expect(releaseJobs["release"]).toMatchObject({
      needs: ["package", "publish"],
      permissions: { contents: "write" },
    });

    const publishJob = releaseJobs["publish"];
    const releaseJob = releaseJobs["release"];
    expect(isRecord(publishJob)).toBe(true);
    expect(isRecord(releaseJob)).toBe(true);
    if (!isRecord(publishJob) || !isRecord(releaseJob)) {
      throw new TypeError("Expected publish and release jobs.");
    }

    expect(publishJob["steps"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Install Node.js",
          with: {
            "node-version": "24.18.0",
            "package-manager-cache": false,
            "registry-url": "https://registry.npmjs.org",
          },
        }),
        expect.objectContaining({
          name: "Verify release artifact shape",
          run: expect.stringContaining("Release artifact contains an unexpected file set."),
        }),
        expect.objectContaining({
          name: "Publish npm package",
          run: expect.stringContaining('package_path="./${package_files[0]}"'),
        }),
      ]),
    );
    const publishSteps = Array.isArray(publishJob["steps"]) ? publishJob["steps"] : [];
    const publishCommand = publishSteps.find(
      (step) => isRecord(step) && step["name"] === "Publish npm package",
    );
    const publishRun = isRecord(publishCommand) ? publishCommand["run"] : undefined;
    expect(publishRun).toEqual(expect.stringContaining('."dist-tags".beta'));
    expect(publishRun).toEqual(expect.stringContaining('published_beta="$(read_beta_version)"'));
    expect(publishRun).toEqual(
      expect.stringContaining(
        'npm publish "$package_path" --access public --tag beta --ignore-scripts',
      ),
    );
    expect(
      publishSteps.some(
        (step) =>
          isRecord(step) &&
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("actions/checkout@"),
      ),
    ).toBe(false);
    expect(releaseJob["env"]).toMatchObject({
      GH_REPO: "${{ github.repository }}",
    });
    const releaseCommands = Array.isArray(releaseJob["steps"])
      ? releaseJob["steps"].flatMap((step) =>
          isRecord(step) && typeof step["run"] === "string" ? [step["run"]] : [],
        )
      : [];
    expect(releaseCommands.filter((command) => command.includes("gh release"))).not.toHaveLength(0);
    expect(
      releaseCommands
        .filter((command) => command.includes("gh release"))
        .every((command) => command.includes('--repo "$GH_REPO"')),
    ).toBe(true);
    expect(releaseCommands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Release artifact contains an unexpected file set."),
        expect.stringContaining('gh release delete "$RELEASE_TAG"'),
        expect.stringContaining('find "$published_release"'),
      ]),
    );

    const baseWorkflow = {
      jobs: { verify: { "runs-on": "ubuntu-24.04", steps: [] } },
      permissions: { contents: "read" },
    };
    for (const trigger of ["issue_comment", "pull_request_target", "workflow_run"]) {
      const forbiddenTriggerForms = [
        { ...baseWorkflow, on: trigger },
        { ...baseWorkflow, on: ["pull_request", trigger] },
        { ...baseWorkflow, on: { [trigger]: {} } },
      ];

      for (const workflow of forbiddenTriggerForms) {
        expect(workflowPolicyErrors("ci.yml", workflow)).toContain(`${trigger} is forbidden.`);
      }
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
            "runs-on": "self-hosted",
            steps: [],
          },
        },
        on: "pull_request",
      }),
    ).toContain("Job verify must use the pinned GitHub-hosted runner.");

    const actionsSecurity = workflows.find(({ name }) => name === "actions-security.yml");
    expect(actionsSecurity).toBeDefined();

    let zizmorInputs: Record<string, unknown> | undefined;
    visitRecords(actionsSecurity?.workflow, (record) => {
      if (
        typeof record["uses"] === "string" &&
        record["uses"].startsWith("zizmorcore/zizmor-action@") &&
        isRecord(record["with"])
      ) {
        zizmorInputs = record["with"];
      }
    });
    expect(zizmorInputs).toEqual({
      "advanced-security": false,
      annotations: true,
      "min-confidence": "medium",
      "min-severity": "low",
      persona: "auditor",
      version: "v1.28.0",
    });
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
        "pkg:npm/caniuse-lite@1.0.30001806",
        "pkg:npm/json-schema@0.4.0",
        "pkg:npm/node-liblzma@2.2.0",
        "pkg:npm/pako@1.0.11",
        "pkg:npm/strtok3@10.3.5",
        "pkg:npm/argparse@2.0.1",
        "pkg:npm/lightningcss@1.32.0",
        "pkg:npm/lightningcss-android-arm64@1.32.0",
        "pkg:npm/lightningcss-darwin-arm64@1.32.0",
        "pkg:npm/lightningcss-darwin-x64@1.32.0",
        "pkg:npm/lightningcss-freebsd-x64@1.32.0",
        "pkg:npm/lightningcss-linux-arm-gnueabihf@1.32.0",
        "pkg:npm/lightningcss-linux-arm64-gnu@1.32.0",
        "pkg:npm/lightningcss-linux-arm64-musl@1.32.0",
        "pkg:npm/lightningcss-linux-x64-gnu@1.32.0",
        "pkg:npm/lightningcss-linux-x64-musl@1.32.0",
        "pkg:npm/lightningcss-win32-arm64-msvc@1.32.0",
        "pkg:npm/lightningcss-win32-x64-msvc@1.32.0",
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
      "pnpm docs:mcp:check",
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
        { context: "Audit GitHub Actions", integration_id: 15368 },
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

  it("versions restricted and immutable CLI release tags", async () => {
    const creationRuleset = parseJsonObject(
      await read(".github/rulesets/cli-release-creators.json"),
    );
    const immutabilityRuleset = parseJsonObject(await read(".github/rulesets/cli-releases.json"));

    expect(creationRuleset).toEqual({
      bypass_actors: [
        {
          actor_id: 22371297,
          actor_type: "User",
          bypass_mode: "always",
        },
      ],
      conditions: {
        ref_name: {
          exclude: [],
          include: ["refs/tags/cli-v*"],
        },
      },
      enforcement: "active",
      name: "Restricted CLI release tag creation",
      rules: [{ type: "creation" }],
      target: "tag",
    });
    expect(immutabilityRuleset).toEqual({
      bypass_actors: [],
      conditions: {
        ref_name: {
          exclude: [],
          include: ["refs/tags/cli-v*"],
        },
      },
      enforcement: "active",
      name: "Protected CLI release tags",
      rules: [{ type: "deletion" }, { type: "update" }],
      target: "tag",
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
    expect(invariants.match(/^[1-9]\. /gmu)).toHaveLength(8);
    expect(threatModel).not.toHaveLength(0);
    expect(settings).not.toHaveLength(0);
    expect(notices).toContain("Copyright (c) 2026 Matt Pocock");
  });
});
