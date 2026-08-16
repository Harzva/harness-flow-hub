export function apply(ctx) {
  ctx.provide('harnessFlowHello', Object.freeze({
    name: '@harness-flow/hello-bundle',
    version: '0.0.1-m0',
    ready: true,
  }))
}
