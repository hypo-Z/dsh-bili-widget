// macOS/Linux smoke test: boots the host half with mocked ctx, hits the real
// HTTP routes against live Bilibili APIs, and prints a pass/fail summary.
// Run: node test/smoke.mjs
import { spawn } from 'node:child_process'
import { apply, inject } from '../lib/index.js'

const routes = new Map()

function fakeSpawn({ argv, cwd, stdio, graceMs } = {}) {
  const child = spawn(argv[0], argv.slice(1), { cwd: cwd && cwd !== 'C:\\' ? cwd : undefined, stdio: ['ignore', 'pipe', 'ignore'] })
  const max = (stdio && stdio.stdout && stdio.stdout.maxBytes) || 1 << 20
  const chunks = []
  let size = 0
  child.stdout && child.stdout.on('data', (c) => {
    if (size >= max) return
    const room = Math.min(c.length, max - size)
    chunks.push(c.subarray(0, room))
    size += room
  })
  const done = new Promise((resolve) => {
    child.on('error', () => resolve())
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  return {
    done,
    collected: { stdout: { readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8') }) } },
    get exitCode() { return child.exitCode },
    get signal() { return child.signalCode },
  }
}

const ctx = {
  subprocess: { spawn: fakeSpawn },
  webServer: { register: (route) => routes.set(route.path, route.handler) },
}

apply(ctx)

function fakeReq(url, method = 'GET') {
  return { url, method, on() {} }
}
function fakeRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { out.body = text || '' },
  }
}
async function hit(path) {
  const res = fakeRes()
  await routes.get(path.split('?')[0])(fakeReq(path), res)
  return { status: res.out.status, json: (() => { try { return JSON.parse(res.out.body) } catch { return null } })() }
}

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
}

console.log('inject:', inject.join(', '))

const hot = await hit('/api/bili2/fetch?kind=hot&pn=1')
check('hot feed', hot.status === 200 && Array.isArray(hot.json?.list) && hot.json.list.length > 0, 'items=' + (hot.json?.list?.length ?? 0))

const rank = await hit('/api/bili2/fetch?kind=rank&rid=0')
check('ranking feed', rank.status === 200 && Array.isArray(rank.json?.list), 'items=' + (rank.json?.list?.length ?? 0))

const search = await hit('/api/bili2/fetch?kind=search&search_type=video&keyword=' + encodeURIComponent('黑神话'))
check('search', search.status === 200 && Array.isArray(search.json?.list), 'items=' + (search.json?.list?.length ?? 0))

const pic = search.json?.list?.find((v) => v.pic)?.pic
if (pic) {
  const img = await hit('/api/bili2/pic?url=' + encodeURIComponent(pic))
  check('cover image base64', img.status === 200 && /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(img.json?.data || ''), 'bytes~' + Math.round((img.json?.data?.length ?? 0) / 1024) + 'KB')
} else {
  check('cover image base64', false, 'no pic in search result')
}

const bad = await hit('/api/bili2/pic?url=' + encodeURIComponent('file:///etc/passwd'))
check('rejects non-http pic url', bad.status === 400)

const fails = results.filter((r) => !r.ok)
console.log('\n' + (results.length - fails.length) + '/' + results.length + ' passed')
process.exit(fails.length ? 1 : 0)
