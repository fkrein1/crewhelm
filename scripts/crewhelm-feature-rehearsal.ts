#!/usr/bin/env -S pnpm exec tsx

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { diagnoseDeployment } from "../apps/cli/src/doctor.js";
import { readInstallation } from "../apps/cli/src/installation.js";
import { openInCodexBrowser } from "../apps/cli/src/codex-browser.js";
import { openInDefaultBrowser } from "../apps/cli/src/interactive.js";
import {
  readRehearsalCredential,
  writeRehearsalCredential,
} from "../apps/cli/src/rehearsal-credential.js";
import {
  authorizeRefreshableOwnerCredential,
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
} from "../apps/cli/src/temporary-owner-session.js";
import { CREWHELM_CLI_VERSION } from "../apps/cli/src/version.js";
import { recoverWorkflowSmoke, runWorkflowSmoke } from "../apps/cli/src/workflow-smoke.js";

const DEFAULT_INSTALLATION = "crewhelm.testing.installation.json";
const DEFAULT_CREDENTIAL = ".crewhelm-rehearsal-credential.json";
const STANDARD_REHEARSAL_ORIGIN = "https://crewhelm-testing.fkrein.workers.dev";

interface RehearsalTarget {
  expectedDeploymentFingerprint: string;
  origin: URL;
}

function boundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`${name} is outside its allowed bounds.`);
  }
  return parsedValue;
}

export async function resolveRehearsalTarget(installationPath: string): Promise<RehearsalTarget> {
  const installation = await readInstallation(installationPath);
  if (!installation) throw new Error("Rehearsal installation metadata does not exist.");
  if (installation.workerName !== "crewhelm-testing") {
    throw new Error("Feature rehearsal is pinned to the crewhelm-testing Worker.");
  }
  if (installation.origin !== STANDARD_REHEARSAL_ORIGIN) {
    throw new Error("Feature rehearsal is pinned to the canonical crewhelm-testing origin.");
  }
  const release: unknown = JSON.parse(await readFile("apps/cli/dist/release.json", "utf8"));
  const workerFingerprint =
    typeof release === "object" && release !== null
      ? Reflect.get(release, "workerFingerprint")
      : undefined;
  if (typeof workerFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(workerFingerprint)) {
    throw new Error("Packaged Worker fingerprint is invalid.");
  }
  return {
    expectedDeploymentFingerprint: workerFingerprint,
    origin: new URL(installation.origin),
  };
}

async function authorize(options: {
  browser: "codex" | "system";
  credentialPath: string;
  installationPath: string;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: rehearsalTarget.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    throw new Error("Rehearsal deployment is not aligned to the packaged build.");
  }
  const openUrl =
    options.browser === "codex"
      ? (url: URL) => openInCodexBrowser(url, { writeError: (text) => process.stderr.write(text) })
      : openInDefaultBrowser;
  const result = await authorizeRefreshableOwnerCredential(
    {
      clientName: "Crewhelm combined authentication rehearsal",
      origin: rehearsalTarget.origin,
      persistCredential: (credential) =>
        writeRehearsalCredential(options.credentialPath, credential),
      scope: "crewhelm:full",
      timeoutMs: options.timeoutMs,
    },
    { fetch, openUrl },
    (session) =>
      session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-feature-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      ),
  );

  return {
    authorization: result.authorization,
    credential: result.authorization.ok ? "saved" : "not_saved",
    initialization: result.operation.status,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
  };
}

async function workflow(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return runWorkflowSmoke(
    {
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function recover(options: {
  agentId: string;
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
  workflowId: string;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return recoverWorkflowSmoke(
    {
      agentId: options.agentId,
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
      workflowId: options.workflowId,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

export async function runFeatureRehearsal(arguments_: readonly string[]): Promise<number> {
  const [action, ...rest] = arguments_;
  if (action !== "authorize" && action !== "recover" && action !== "workflow") {
    process.stderr.write(
      "Usage: crewhelm-feature-rehearsal.ts <authorize|recover|workflow> [options]\n",
    );
    return 2;
  }
  const parsed = parseArgs({
    args: rest,
    options: {
      browser: { default: "codex", type: "string" },
      "agent-id": { type: "string" },
      credential: { default: DEFAULT_CREDENTIAL, type: "string" },
      installation: { default: DEFAULT_INSTALLATION, type: "string" },
      "run-timeout-ms": { default: "240000", type: "string" },
      "timeout-ms": { default: "5000", type: "string" },
      "workflow-id": { type: "string" },
    },
    strict: true,
  });
  const timeoutMs = boundedInteger(parsed.values["timeout-ms"], 100, 30_000, "timeout-ms");
  const common = {
    credentialPath: parsed.values.credential,
    installationPath: parsed.values.installation,
    timeoutMs,
  };
  const runTimeoutMs = boundedInteger(
    parsed.values["run-timeout-ms"],
    1_000,
    10 * 60 * 1_000,
    "run-timeout-ms",
  );
  const report =
    action === "authorize"
      ? await authorize({
          ...common,
          browser:
            parsed.values.browser === "codex" || parsed.values.browser === "system"
              ? parsed.values.browser
              : (() => {
                  throw new Error("browser must be codex or system.");
                })(),
        })
      : action === "recover"
        ? await recover({
            ...common,
            agentId:
              parsed.values["agent-id"] ??
              (() => {
                throw new Error("recover requires agent-id.");
              })(),
            runTimeoutMs,
            workflowId:
              parsed.values["workflow-id"] ??
              (() => {
                throw new Error("recover requires workflow-id.");
              })(),
          })
        : await workflow({
            ...common,
            runTimeoutMs,
          });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return typeof report === "object" && report !== null && Reflect.get(report, "ok") === true
    ? 0
    : 1;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runFeatureRehearsal(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      return undefined;
    },
    (error: unknown) => {
      process.stderr.write(
        `Feature rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
      return undefined;
    },
  );
}
