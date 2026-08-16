# Harness Flow Hub for DSH

Harness Flow Hub is an independent, community-built plugin Registry and Agent Stack workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It contributes a native **Flow Hub** tab under **DSH Web → Settings → Plugins**, while its public GitHub Pages site remains a read-only discovery surface. Developer search aliases are `dsh`, **DSH Flow Hub**, `dsh-plugin`, `dsh-flow`, `dsh-flow-hub`, `dsh-hub`, and **DeepSeek Harness Flow Hub**; the product name remains **Harness Flow Hub**.

**Public explorer:** [harzva.github.io/harness-flow-hub](https://harzva.github.io/harness-flow-hub/)

> Alpha status: the transaction engine and native UI are real, but the public catalog is evidence-first. A discovered plugin is not automatically trusted, and no community candidate is currently labeled `verified`.

## What works today

- Native DSH UI with Home, Plugins, Flows, Profiles, and Tasks views.
- A deterministic 20-record Registry with explicit `verified`, `failed`, `unverified`, `stale`, and `revoked` states.
- Structured install and rollback plans; the browser cannot submit arbitrary package names or shell commands.
- Preflight checks for platform, DSH version, disk, network, credentials, and Registry signature.
- Transactional Profile snapshot, staging, official `dsh plugin` execution, config validation, atomic commit, final-path relink, health check, recovery points, and rollback.
- Offline-safe reads: an unreachable configured upstream Registry falls back to the versioned snapshot bundled with the Hub, while installed Profiles, recovery points, tasks, and local management remain independent.
- Exact npm version, `.tgz`, GitHub commit SHA, and local-directory source adapters.
- Real DSH lifecycle evidence for install, update, downgrade, remove, startup recovery, rollback, rollback undo, and injected failure recovery.
- Signed immutable Registry prerelease and Windows/Linux CI evidence. macOS remains explicitly uncovered.

## Trust boundary

The public site can search and explain Registry evidence. It never asks for credentials and cannot install anything. Install, update, remove, and rollback actions stay inside the local DSH Web UI and require a structured preview before execution.

## Development

Requirements: Node.js 22+, pnpm 11, and DeepSeek Harness `0.1.0-rc.6` for the currently verified runtime path.

```powershell
pnpm install
pnpm check
pnpm site:serve
```

To load the Hub into an isolated DSH Web Profile, package this repository, add the resulting `.tgz` through the official `dsh plugin --profile web add ...` command, then start `dsh web` and open **Settings → Plugins → Flow Hub**.

The test-only write channel manages the project-owned `@harness-flow/hello-bundle` fixture. Arbitrary community package mutations remain gated until their verification and permission contracts are complete.

## Evidence and roadmap

- [`evidence/`](./evidence/) contains machine-readable lifecycle and release proof.
- [`registry/generated/registry.json`](./registry/generated/registry.json) is the public deterministic Registry snapshot.
- [Project roadmap](../harness-flow-hub-roadmap.md) is the single execution control plane.
- [Signed Registry prerelease](https://github.com/Harzva/harness-flow-hub/releases/tag/registry-2026.08.16-alpha.1)

The project-owned pinned-SHA fixture is [Harzva/dsh-flow-hub-hello-fixture](https://github.com/Harzva/dsh-flow-hub-hello-fixture) at commit `770891307389487f6e4dc6bc4bd7a6db65d5c087`.
