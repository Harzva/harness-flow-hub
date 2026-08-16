import { createHash } from 'node:crypto'
import { readFile, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, resolve } from 'node:path'

const tarballPath = resolve(process.argv[2] ?? 'artifacts/harness-flow-hello-bundle-0.0.1-m0.tgz')
const port = Number(process.argv[3] ?? 48731)
const body = readFileSync(tarballPath)
const version = '0.0.1-m0'
const name = '@harness-flow/hello-bundle'
const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
const shasum = createHash('sha1').update(body).digest('hex')

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname)
  if (pathname === `/${name}`) {
    const metadata = {
      name,
      'dist-tags': { latest: version },
      versions: {
        [version]: {
          name,
          version,
          dist: {
            tarball: `http://127.0.0.1:${port}/${basename(tarballPath)}`,
            integrity,
            shasum,
          },
        },
      },
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(metadata))
    return
  }
  if (pathname === `/${basename(tarballPath)}`) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.byteLength })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, registry: `http://127.0.0.1:${port}`, name, version, integrity }) + '\n')
})

process.on('SIGINT', () => server.close())
process.on('SIGTERM', () => server.close())
