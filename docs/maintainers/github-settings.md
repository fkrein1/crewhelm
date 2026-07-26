# GitHub repository settings

Apply these controls when the public repository is created. They live in GitHub rather than in the
worktree and therefore cannot be enforced by the bootstrap commit alone.

## Security

- Enable private vulnerability reporting.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection.
- Install or require a Developer Certificate of Origin check.

## Main branch ruleset

- Require pull requests and CODEOWNERS approval.
- Dismiss stale approvals when the diff changes.
- Require the `Verify`, `Dependency review`, `Analyze JavaScript and TypeScript`, and DCO checks.
- Block force pushes and branch deletion.
- Restrict ruleset bypass to emergency maintainers and audit every use.

Revisit these settings before publishing packages or deploying production Workers.
