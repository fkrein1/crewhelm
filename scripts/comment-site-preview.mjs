const marker = "<!-- crewhelm-site-preview -->";
const workerName = "crewhelm-site";
const workersDevSubdomain = "fkrein";

/** @param {string} name */
function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const token = requiredEnvironment("GITHUB_TOKEN");
const branch = requiredEnvironment("PREVIEW_BRANCH");
const commit = requiredEnvironment("PREVIEW_COMMIT");
const pullRequest = requiredEnvironment("PREVIEW_PR");
const repository = requiredEnvironment("PREVIEW_REPOSITORY");
const apiBase = `https://api.github.com/repos/${repository}`;

/** @param {string} value */
function previewAlias(value) {
  const alias = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(alias) || `${alias}-${workerName}`.length > 63) {
    throw new Error(`Unsupported preview branch alias: ${value}`);
  }
  return alias;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<unknown>}
 */
async function github(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/vnd.github+json");
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("x-github-api-version", "2022-11-28");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function cloudflareVersion() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await github(`/commits/${commit}/check-runs?per_page=100`);
    if (!result || typeof result !== "object" || !("check_runs" in result)) {
      throw new Error("GitHub returned an invalid checks response");
    }
    const checkRuns = result.check_runs;
    if (!Array.isArray(checkRuns)) throw new Error("GitHub returned invalid check runs");
    const check = checkRuns.find(
      (item) => item && typeof item === "object" && item.name === "Workers Builds: crewhelm-site",
    );
    if (check?.status === "completed") {
      if (check.conclusion !== "success") throw new Error("Cloudflare site preview build failed");
      const summary =
        check.output && typeof check.output === "object" && "summary" in check.output
          ? check.output.summary
          : undefined;
      const match =
        typeof summary === "string" ? summary.match(/Version ID: ([0-9a-f-]{36})/i) : null;
      const version = match?.[1];
      if (!version) throw new Error("Cloudflare site preview build did not report a version ID");
      return version;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Timed out waiting for the Cloudflare site preview build");
}

const version = await cloudflareVersion();
const versionUrl = `https://${version.slice(0, 8)}-${workerName}.${workersDevSubdomain}.workers.dev`;
const branchUrl = `https://${previewAlias(branch)}-${workerName}.${workersDevSubdomain}.workers.dev`;

for (const url of [versionUrl, branchUrl]) {
  const response = await fetch(`${url}/recipes/`, { redirect: "manual" });
  if (!response.ok) throw new Error(`Preview smoke test failed with ${response.status}: ${url}`);
}

const body = `${marker}
### Site preview

- [Branch preview](${branchUrl}/recipes/)
- [Commit preview](${versionUrl}/recipes/)
`;
const comments = await github(`/issues/${pullRequest}/comments?per_page=100`);
if (!Array.isArray(comments)) throw new Error("GitHub returned invalid pull request comments");
const existing = comments.find(
  (comment) =>
    comment &&
    typeof comment === "object" &&
    "user" in comment &&
    comment.user &&
    typeof comment.user === "object" &&
    "login" in comment.user &&
    comment.user.login === "github-actions[bot]" &&
    "body" in comment &&
    typeof comment.body === "string" &&
    comment.body.includes(marker),
);

if (existing && "id" in existing && typeof existing.id === "number") {
  await github(`/issues/comments/${existing.id}`, {
    body: JSON.stringify({ body }),
    method: "PATCH",
  });
} else {
  await github(`/issues/${pullRequest}/comments`, {
    body: JSON.stringify({ body }),
    method: "POST",
  });
}
