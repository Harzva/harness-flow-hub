import { rm } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('lib', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts', 'src/transaction.ts', 'src/flow-resolver.ts', 'src/bootstrap-policy.ts', 'src/compatibility.ts'],
  outdir: 'lib',
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
})

await build({
  entryPoints: ['src/client/bootstrap.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-settings/client',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@harness-flow/dsh-flow-hub", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})
