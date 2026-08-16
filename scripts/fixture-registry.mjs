import { createHash } from 'node:crypto'
import { readFile, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, resolve } from 'node:path'

const tarballPath = resolve(process.argv[2] ?? 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const port = Number(process.argv[3] ?? 48731)
const secondTarballPath = process.argv[4] ? resolve(process.argv[4]) : null
const name = '@harness-flow/hello-bundle'
const packages = [
  { path: tarballPath, version: '0.0.1-m0' },
  ...(secondTarballPath ? [{ path: secondTarballPath, version: '0.0.2-m2' }] : []),
].map(item => {
  const body = readFileSync(item.path)
  return {
    ...item,
    body,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    shasum: createHash('sha1').update(body).digest('hex'),
  }
})

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname)
  if (pathname === `/${name}`) {
    const metadata = {
      name,
      'dist-tags': { latest: packages.at(-1).version },
      versions: Object.fromEntries(packages.map(item => [item.version, {
          name,
          version: item.version,
          dist: {
            tarball: `http://127.0.0.1:${port}/${basename(item.path)}`,
            integrity: item.integrity,
            shasum: item.shasum,
          },
        }])),
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(metadata))
    return
  }
  const requested = packages.find(item => pathname === `/${basename(item.path)}`)
  if (requested) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': requested.body.byteLength })
    res.end(requested.body)
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, registry: `http://127.0.0.1:${port}`, name, versions: packages.map(item => item.version) }) + '\n')
})

process.on('SIGINT', () => server.close())
process.on('SIGTERM', () => server.close())
