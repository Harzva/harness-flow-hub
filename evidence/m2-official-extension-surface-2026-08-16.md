# M2 official DSH extension-surface audit

Date: 2026-08-16  
Source reference: downloaded `deepseek-harness` source snapshot whose root package manifest reports `0.1.0-rc.5`; runtime confirmation was performed with installed DSH `0.1.0-rc.6`.

## Confirmed reusable surfaces

| Surface | Official evidence | Harness Flow Hub use | Stability decision |
|---|---|---|---|
| Plugins settings page | `packages/client/ui-settings/src/client/contract/slots.ts` declares `settings.plugins.tab` as a root list slot with `id`, `order`, and `label`. | Flow Hub registers its own `flow-hub` tab. | Use now. It is typed, additive, effect-owned, and unload-safe. |
| Slot discovery contract | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` documents the same slot, current occupants, replacement risk, and a third-party registration example. | Bootstrap can detect whether the slot is present before loading the full UI. | Use now, but continue version-gating because the project is pre-1.0. |
| Plugin inventory | `packages/host/plugin-inventory/src/types.ts` exposes entry id, module name, effective enabled state, and Fiber phase. Its README states that `pluginInventory/list` is intentionally read-only and has no mutation path. | Read installed/live state without parsing the DOM or Loader internals. | Use for inventory only. Never represent it as an installer. |
| Browser Remote assembly | `packages/api/remotes/README.md` states that the Client assembly mounts the read-only plugin inventory contribution through `ctx.remote.$mount()`. | Future Host integration should contribute a typed Remote through the same assembly pattern. | Preferred upstream integration path. |
| Profile package writer | `docs/user/develop/basic/publish.md` says `dsh plugin --profile <name> <args...>` forwards to pnpm, creates and maintains the Profile manifest, appends/removes bundle layers, and pairs with `--dump-config`. | Transaction staging invokes the official CLI with argv, then validates through official `--dump-config`. | Keep as the only writer until an official programmatic mutation API exists. |
| Plugin configuration cards | `packages/client/ui-settings-plugins/README.md` declares nested `settings.plugin.item`, but also documents that externally distributed plugins cannot expose arbitrary Host settings namespaces without an api-proxy allowlist change. | Flow Hub must not promise generic third-party settings forms from schemas alone. | Do not couple marketplace installation to this restricted configuration plane. |

## Gaps that require stable upstream contracts

1. **Typed Profile mutation Remote.** Add plan/apply/remove/update operations owned by DSH, with exact package source, Profile revision, lifecycle-script policy, cancellation, progress, and structured errors. Until then, Flow Hub continues to call the official CLI only from its loopback Host plugin.
2. **Transaction and recovery status.** Expose durable operation ids and recovery outcomes so a Client reconnect can distinguish running, rolled back, recovered, and unknown outcomes without reading Hub-private files.
3. **Profile lifecycle Remote.** Provide list/create/clone/validate/start/stop and current revision/digest. The existing plugin inventory describes Loader entries, not Profile packages or saved Profiles.
4. **External settings contribution policy.** Replace the repository-local api-proxy namespace allowlist requirement with a permissioned, typed contribution contract, or explicitly declare that third-party settings remain plugin-owned custom tabs.
5. **Compatibility descriptor.** Publish DSH version, Client slot-contract version, Remote schema version, and Profile schema version in one bootstrap response. Package semver alone cannot prove all four faces are compatible.
6. **First-class page/navigation slot.** `settings.plugins.tab` is sufficient for Alpha. A top-level Hub should wait for an official additive navigation/page slot rather than replace a shipped cell or patch core UI.

## Integration rule

Harness Flow Hub will reuse typed Slots and read-only inventory now, preserve `dsh plugin` as the sole Profile writer, and keep its loopback Host route behind same-origin checks. It will not patch DSH core, mutate Profile manifests directly, or describe the read-only inventory Remote as an installation API.
