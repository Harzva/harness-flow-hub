# Harness Flow Hub

M0 vertical slice for an in-DSH Flow and plugin marketplace. It contributes a native **Flow Hub** tab under DSH Web Settings → Plugins and a loopback-only Host adapter that invokes the official `dsh plugin --profile ...` interface.

This milestone intentionally manages only `@harness-flow/hello-bundle`. Arbitrary package installation, catalog discovery, signatures, lockfiles, rollback, and production transactions remain gated by later Roadmp milestones.

The project-owned pinned-SHA fixture is published at [Harzva/dsh-flow-hub-hello-fixture](https://github.com/Harzva/dsh-flow-hub-hello-fixture). M0 verified commit `770891307389487f6e4dc6bc4bd7a6db65d5c087`; floating branches are not accepted as evidence.

## M0 development run

1. `pnpm install`
2. `pnpm build && pnpm check`
3. `pnpm run pack:fixture`
4. Set `DSH_FLOW_HUB_FIXTURE` to the generated `.tgz` absolute path.
5. Install this directory into an isolated Web profile with `dsh plugin --profile web add <this-directory>`.
6. Start `dsh web`, then open Settings → Plugins → Flow Hub.

The Bootstrap disables mutations unless the DSH version is in the M0 verified range and a fixture source was explicitly configured.
