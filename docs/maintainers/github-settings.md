# GitHub repository settings

Keep these controls aligned with the live public repository. They are enforced partly by GitHub
and partly by the versioned workflows in `.github/workflows/`. The importable
`.github/rulesets/main.json` file is the source of truth for the live `Protected main` ruleset.

## Security

- Enable the dependency graph; the required dependency-review workflow fails closed without it.
- Enable private vulnerability reporting.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection.
- Require Actions to use full commit SHA pins.
- Install the Developer Certificate of Origin (`DCO`) GitHub App for this repository only, with
  read access to code, metadata, and pull requests and write access to checks.

## Main branch ruleset

- Target the default branch and keep enforcement active.
- Require every change to arrive through a pull request.
- While `fkrein1` is the only write-capable maintainer, require zero approvals so the author is not
  deadlocked. CODEOWNERS still requests the relevant review. Raise this to one approval and require
  code-owner review when a second maintainer is available.
- Require all review conversations to be resolved.
- Require strict, up-to-date `Verify`, `Dependency review`,
  `Analyze JavaScript and TypeScript`, and `DCO` status checks.
- Block CodeQL analysis errors and high-or-higher code-scanning alerts.
- Block force pushes and branch deletion, including for administrators; configure no standing
  bypass actors.

## Check placement

| Event                          | Verify         | CodeQL analysis | Dependency review | DCO            |
| ------------------------------ | -------------- | --------------- | ----------------- | -------------- |
| Pull request opened or updated | Required       | Required        | Required          | Required       |
| Push to `main` after merge     | Monitoring     | Monitoring      | Not applicable    | Not applicable |
| Weekly schedule                | Not applicable | Monitoring      | Not applicable    | Not applicable |

Dependency review is a pull-request-only comparison and must not be configured as a post-merge
`main` check. Merge queue is intentionally disabled for the current single-maintainer workflow; if
it is enabled later, add and validate `merge_group` triggers before making queue checks required.

## Merge settings

- Allow rebase merges so intentional semantic commits remain in history.
- Disable merge commits and squash merges.
- Enable auto-merge, branch-update suggestions, and automatic deletion of merged head branches.
- Merge only after required checks pass. Codex may perform the merge only when the user has granted
  repository merge authority.

## Ruleset rollout and recovery

For initial rollout, install DCO for this repository, open a signed-off pull request, and wait for
all four required contexts to report. Then import `.github/rulesets/main.json`, verify the active
ruleset through GitHub's API, and only then merge the pull request.

If a required provider is unavailable or a check configuration prevents its own repair, use
explicit, audited maintainer authority to remove only the failing required context. Land the repair
through a pull request under every remaining control, restore the context, and read back the active
ruleset. Do not disable the pull-request, force-push, deletion, or remaining check rules.

Revisit these settings before publishing packages or deploying production Workers.
