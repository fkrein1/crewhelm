# GitHub repository settings

These controls live in GitHub. Keep them aligned with the versioned workflows and the desired
`Protected main` ruleset in `.github/rulesets/main.json`.

## Repository

- Use `main` as the default branch.
- Allow rebase merges. Enable auto-merge, branch updates, and deletion of merged branches.

## Security

- Enable the dependency graph, private vulnerability reporting, Dependabot alerts and security
  updates, secret scanning, and push protection.
- Give Actions read-only default permissions. Allow selected actions only, require full commit SHA
  pins, and require approval for all external contributors.

## Protected main

- Keep the live ruleset identical to `.github/rulesets/main.json`, with active enforcement and no
  bypass actors.
- Keep zero required approvals only while one write-capable maintainer exists. Then require one
  approval and code-owner review.
- If a required check blocks its repair, remove only that context, land the repair under every
  remaining rule, restore it, and verify the live ruleset.

## CLI releases

- Keep the CLI tag ruleset aligned with `.github/rulesets/cli-releases.json`.
- Protect the `cli-release` environment with a required reviewer and restrict it to `cli-v*` tags.
- Allow `actions/attest`, `actions/upload-artifact`, and `actions/download-artifact`.
- Enable immutable releases. A matching tag packages and attests the CLI before the environment
  gate creates a prerelease.
