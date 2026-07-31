import packageManifest from "../package.json" with { type: "json" };

const semanticVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

if (!semanticVersionPattern.test(packageManifest.version)) {
  throw new Error("The CLI package version is not valid SemVer.");
}

export const CREWHELM_CLI_VERSION = packageManifest.version;
