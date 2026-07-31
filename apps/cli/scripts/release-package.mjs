import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageDirectory, "dist");
const releaseDirectory = resolve(packageDirectory, "release");
const manifestPath = resolve(packageDirectory, "package.json");
const shrinkwrapPath = resolve(packageDirectory, "npm-shrinkwrap.json");
const maximumFileCount = 256;
const maximumFileBytes = 32 * 1_024 * 1_024;
const maximumPackageBytes = 8 * 1_024 * 1_024;
const maximumUnpackedBytes = 64 * 1_024 * 1_024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitObjectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha512IntegrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const allowedDistPatterns = [
  /^dist\/crewhelm\.js$/u,
  /^dist\/release\.json$/u,
  /^dist\/deployment\/[a-f0-9]{40}-\d{4}_[a-z0-9_]+\.sql$/u,
  /^dist\/deployment\/index\.js$/u,
  /^dist\/deployment\/index\.js\.map$/u,
  /^dist\/deployment\/migrations\/\d{4}_[a-z0-9_]+\.sql$/u,
  /^dist\/deployment\/wrangler-template\.json$/u,
];

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? packageDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = options.capture && result.stderr ? `\n${result.stderr.trim()}` : "";
    throw new Error(`${command} exited with status ${String(result.status)}.${detail}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

async function listRegularFiles(directory) {
  const files = [];

  async function visit(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(currentDirectory, entry.name);
      const pathStat = await lstat(path);

      if (pathStat.isSymbolicLink()) {
        throw new Error(
          `Release contents cannot include symbolic links: ${relative(directory, path)}`,
        );
      }

      if (pathStat.isDirectory()) {
        await visit(path);
      } else if (pathStat.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Release contents must be regular files: ${relative(directory, path)}`);
      }
    }
  }

  await visit(directory);
  return files;
}

function normalizedRelativePath(base, path) {
  return relative(base, path).split(sep).join("/");
}

async function validateDistContents() {
  const files = await listRegularFiles(outputDirectory);

  if (files.length === 0 || files.length > maximumFileCount) {
    throw new Error(`Release dist must contain between 1 and ${maximumFileCount} files.`);
  }

  let totalBytes = 0;
  const paths = [];

  for (const path of files) {
    const relativePath = normalizedRelativePath(packageDirectory, path);
    const fileStat = await stat(path);

    if (
      relativePath.split("/").some((part) => part.startsWith(".")) ||
      !allowedDistPatterns.some((pattern) => pattern.test(relativePath))
    ) {
      throw new Error(`Release dist contains a forbidden path: ${relativePath}`);
    }

    if (fileStat.size > maximumFileBytes) {
      throw new Error(`Release file exceeds ${maximumFileBytes} bytes: ${relativePath}`);
    }

    totalBytes += fileStat.size;
    paths.push(relativePath);
  }

  if (totalBytes > maximumUnpackedBytes) {
    throw new Error(`Release dist exceeds ${maximumUnpackedBytes} unpacked bytes.`);
  }

  const sortedPaths = paths.toSorted((left, right) => left.localeCompare(right));

  for (const requiredPath of [
    "dist/crewhelm.js",
    "dist/deployment/index.js",
    "dist/deployment/index.js.map",
    "dist/deployment/wrangler-template.json",
    "dist/release.json",
  ]) {
    if (!sortedPaths.includes(requiredPath)) {
      throw new Error(`Release dist is missing ${requiredPath}.`);
    }
  }

  return sortedPaths;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function parseOptions(arguments_, version) {
  const expectedTag = `cli-v${version}`;
  let installSmoke = false;
  let releaseTag;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === "--install-smoke" && !installSmoke) {
      installSmoke = true;
      continue;
    }

    if (argument === "--tag" && releaseTag === undefined) {
      releaseTag = arguments_[index + 1];
      index += 1;

      if (releaseTag !== expectedTag) {
        throw new Error(`Release tag must exactly match ${expectedTag}.`);
      }
      continue;
    }

    throw new Error("Usage: release-package.mjs [--install-smoke] [--tag cli-v<package-version>]");
  }

  return { installSmoke, releaseTag };
}

function validateRuntimeLock(lock, packageManifest) {
  if (
    lock.name !== packageManifest.name ||
    lock.version !== packageManifest.version ||
    lock.lockfileVersion !== 3 ||
    typeof lock.packages !== "object" ||
    lock.packages === null ||
    Array.isArray(lock.packages)
  ) {
    throw new Error("The npm runtime lock has invalid root metadata.");
  }

  const rootPackage = lock.packages[""];

  if (
    typeof rootPackage !== "object" ||
    rootPackage === null ||
    JSON.stringify(rootPackage.dependencies) !== JSON.stringify(packageManifest.dependencies) ||
    JSON.stringify(rootPackage.bin) !== JSON.stringify(packageManifest.bin) ||
    JSON.stringify(rootPackage.engines) !== JSON.stringify(packageManifest.engines)
  ) {
    throw new Error("The npm runtime lock does not match the publishable package.");
  }

  const dependencyEntries = Object.entries(lock.packages).filter(([path]) => path !== "");

  if (dependencyEntries.length === 0 || dependencyEntries.length > maximumFileCount) {
    throw new Error("The npm runtime lock contains an invalid dependency count.");
  }

  const installScriptPackages = [];

  for (const [path, dependency] of dependencyEntries) {
    if (
      !path.startsWith("node_modules/") ||
      path.includes("..") ||
      typeof dependency !== "object" ||
      dependency === null ||
      typeof dependency.version !== "string" ||
      typeof dependency.resolved !== "string" ||
      !dependency.resolved.startsWith("https://registry.npmjs.org/") ||
      typeof dependency.integrity !== "string" ||
      !sha512IntegrityPattern.test(dependency.integrity)
    ) {
      throw new Error(`The npm runtime lock contains an invalid dependency: ${path}`);
    }

    if (dependency.hasInstallScript === true) {
      installScriptPackages.push(path);
    }
  }

  if (
    JSON.stringify(installScriptPackages.toSorted((left, right) => left.localeCompare(right))) !==
    JSON.stringify(["node_modules/esbuild", "node_modules/fsevents", "node_modules/workerd"])
  ) {
    throw new Error("The npm runtime lifecycle-script allowlist changed.");
  }
}

const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { installSmoke, releaseTag } = parseOptions(process.argv.slice(2), packageManifest.version);
const runtimeLock = JSON.parse(await readFile(shrinkwrapPath, "utf8"));
validateRuntimeLock(runtimeLock, packageManifest);
const runtimeLockSha256 = await sha256(shrinkwrapPath);
const versionOutput = run(
  process.execPath,
  [resolve(outputDirectory, "crewhelm.js"), "version", "--json"],
  {
    capture: true,
  },
);
const packagedIdentity = JSON.parse(versionOutput);

if (
  packagedIdentity.cliVersion !== packageManifest.version ||
  !Number.isSafeInteger(packagedIdentity.deploymentProtocolVersion) ||
  packagedIdentity.deploymentProtocolVersion < 1 ||
  !sha256Pattern.test(packagedIdentity.workerFingerprint)
) {
  throw new Error("The built CLI returned an invalid packaged identity.");
}

const sourceCommit = run("git", ["rev-parse", "HEAD"], {
  capture: true,
  cwd: resolve(packageDirectory, "../.."),
});

if (!gitObjectIdPattern.test(sourceCommit)) {
  throw new Error("The source commit is not a full Git object identifier.");
}

const releaseManifest = {
  schemaVersion: 1,
  cliVersion: packageManifest.version,
  sourceCommit,
  deploymentProtocolVersion: packagedIdentity.deploymentProtocolVersion,
  runtimeLockSha256,
  workerFingerprint: packagedIdentity.workerFingerprint,
  ...(releaseTag === undefined ? {} : { releaseTag }),
};

await writeFile(
  resolve(outputDirectory, "release.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
  { mode: 0o644 },
);

const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "npm-shrinkwrap.json",
  "package.json",
  ...(await validateDistContents()),
].toSorted((left, right) => left.localeCompare(right));

await rm(releaseDirectory, { force: true, recursive: true });
await mkdir(releaseDirectory, { recursive: true });

const packOutput = run(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", releaseDirectory],
  { capture: true },
);
const packResult = JSON.parse(packOutput);

if (!Array.isArray(packResult) || packResult.length !== 1) {
  throw new Error("npm pack did not report exactly one package.");
}

const packageResult = packResult[0];
const actualPackageFiles = packageResult.files
  .map((file) => file.path)
  .toSorted((left, right) => left.localeCompare(right));

if (JSON.stringify(actualPackageFiles) !== JSON.stringify(expectedPackageFiles)) {
  throw new Error(
    `Packed file allowlist mismatch.\nExpected: ${expectedPackageFiles.join(", ")}\nActual: ${actualPackageFiles.join(", ")}`,
  );
}

if (
  packageResult.name !== packageManifest.name ||
  packageResult.version !== packageManifest.version ||
  !sha1Pattern.test(packageResult.shasum) ||
  packageResult.size > maximumPackageBytes ||
  packageResult.unpackedSize > maximumUnpackedBytes
) {
  throw new Error("npm pack reported invalid package metadata.");
}

const tarballPath = resolve(releaseDirectory, packageResult.filename);
const copiedManifestPath = resolve(releaseDirectory, "release.json");
await writeFile(copiedManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, {
  mode: 0o644,
});

const extractionDirectory = await mkdtemp(resolve(tmpdir(), "crewhelm-release-"));

try {
  run("tar", ["-xzf", tarballPath, "-C", extractionDirectory]);
  const unpackedVersion = run(
    process.execPath,
    [resolve(extractionDirectory, "package/dist/crewhelm.js"), "--version"],
    { capture: true },
  );

  if (unpackedVersion !== packageManifest.version) {
    throw new Error("The unpacked CLI did not report the package version.");
  }
} finally {
  await rm(extractionDirectory, { force: true, recursive: true });
}

if (installSmoke) {
  const installationDirectory = await mkdtemp(resolve(tmpdir(), "crewhelm-install-"));
  const npmConfigurationPath = resolve(installationDirectory, ".npmrc");

  try {
    await writeFile(
      npmConfigurationPath,
      "audit=false\nfund=false\nignore-scripts=true\npackage-lock=false\n",
      { mode: 0o600 },
    );
    const installEnvironment = {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      npm_config_cache: resolve(installationDirectory, "npm-cache"),
      npm_config_userconfig: npmConfigurationPath,
    };

    run("npm", ["install", tarballPath], {
      cwd: installationDirectory,
      env: installEnvironment,
    });

    const installedVersion = run(
      resolve(installationDirectory, "node_modules/.bin/crewhelm"),
      ["--version"],
      { capture: true, cwd: installationDirectory, env: installEnvironment },
    );
    const installedWranglerVersion = run(
      resolve(installationDirectory, "node_modules/.bin/wrangler"),
      ["--version"],
      { capture: true, cwd: installationDirectory, env: installEnvironment },
    );

    if (
      installedVersion !== packageManifest.version ||
      !installedWranglerVersion.includes(packageManifest.dependencies.wrangler)
    ) {
      throw new Error("The installed CLI runtime did not match the package lock.");
    }
  } finally {
    await rm(installationDirectory, { force: true, recursive: true });
  }
}

const checksumTargets = [tarballPath, copiedManifestPath];
const checksums = [];

for (const path of checksumTargets.toSorted((left, right) => left.localeCompare(right))) {
  checksums.push(`${await sha256(path)}  ${normalizedRelativePath(releaseDirectory, path)}`);
}

await writeFile(resolve(releaseDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
  mode: 0o644,
});

console.log(
  JSON.stringify({
    ...releaseManifest,
    package: packageResult.filename,
    packageBytes: packageResult.size,
    unpackedBytes: packageResult.unpackedSize,
  }),
);
