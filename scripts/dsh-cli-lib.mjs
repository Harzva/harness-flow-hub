import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export function dshCliPath() {
  const packageRoot = process.env.DSH_PACKAGE_ROOT
    ? resolve(process.env.DSH_PACKAGE_ROOT)
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
      : null
  if (packageRoot === null) throw new Error('set DSH_PACKAGE_ROOT on non-Windows verifier hosts')
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
  if (typeof bin !== 'string') throw new Error('installed @deepseek-ai/dsh package exposes no dsh binary')
  return join(packageRoot, bin)
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

