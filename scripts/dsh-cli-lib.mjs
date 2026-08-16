import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

export function dshPackageInfo() {
  const packageRoot = process.env.DSH_PACKAGE_ROOT
    ? resolve(process.env.DSH_PACKAGE_ROOT)
    : dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
  if (typeof bin !== 'string') throw new Error('installed @deepseek-ai/dsh package exposes no dsh binary')
  return { packageRoot, package: pkg, cli: join(packageRoot, bin) }
}

export function dshCliPath() {
  return dshPackageInfo().cli
}

export function runDsh(cli, home, args, timeout = 180_000) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
}
