# Crewhelm CLI

Bootstrap, upgrade, and diagnose a personal Crewhelm control plane on Cloudflare.

```sh
npx @crewhelm/cli@beta up
```

Use `npx @crewhelm/cli@beta rehearse --help` for explicit Agent, integration, installation, and
upgrade production rehearsals. Rehearsals mutate real state, require `--confirm-production`, and
clean up the exact disposable resources they create.

Requires Node.js 24.18 or later within the Node.js 24 release line. See the
[Crewhelm repository](https://github.com/fkrein1/crewhelm) for setup and security guidance.
