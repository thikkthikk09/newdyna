/**
 * Dyna Store dev server — static files + Bakong API proxy (no CORS).
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const PORT = Number(process.env.PORT) || 8787
const RUNTIME_FILE = path.join(ROOT, 'standalone', '.bakong-runtime.json')
const BAKONG_API = 'https://api-bakong.nbc.gov.kh/v1/check_transaction_by_md5'
const BAKONG_RENEW = 'https://api-bakong.nbc.gov.kh/v1/renew_token'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function readConfigFile() {
  try {
    return fs.readFileSync(path.join(ROOT, 'standalone', 'bakong.config.local.js'), 'utf8')
  } catch {
    return ''
  }
}

function loadConfig() {
  const text = readConfigFile()
  const pick = (key) => {
    const m = text.match(new RegExp(`${key}:\\s*['"]([^'"]*)['"]`))
    return m?.[1]?.trim() || ''
  }
  return {
    token: pick('token'),
    registerToken: pick('registerToken'),
    email: pick('email') || process.env.BAKONG_EMAIL || '',
    organization: pick('organization') || 'Dyna Store',
    project: pick('project') || 'dyna_store',
  }
}

function pickJwt(...values) {
  for (const v of values) {
    const t = String(v || '').trim()
    if (t.startsWith('eyJ')) return t
  }
  return ''
}

function loadRuntime() {
  try {
    const raw = fs.readFileSync(RUNTIME_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function saveRuntime(data) {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true })
    fs.writeFileSync(
      RUNTIME_FILE,
      JSON.stringify(
        {
          email: data.email || '',
          jwt: data.jwt?.startsWith('eyJ') ? data.jwt : '',
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
    )
  } catch {
    /* ignore */
  }
}

const runtime = loadRuntime()
let serverJwt = pickJwt(runtime.jwt, loadConfig().token, process.env.BAKONG_TOKEN)
let runtimeEmail = runtime.email || ''

function activeEmail() {
  return runtimeEmail || loadConfig().email
}

/** Reuse cached JWT — renew_token sends an email on every call */
function jwtStillValid(token, bufferMs = 15 * 60 * 1000) {
  if (!token?.startsWith('eyJ')) return false
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    if (!payload.exp) return true
    return Date.now() < payload.exp * 1000 - bufferMs
  } catch {
    return false
  }
}

async function renewJwt(email, organization, project, registerToken) {
  const payload = { email, organization, project }
  if (registerToken?.startsWith('rbk')) payload.token = registerToken

  const upstream = await fetch(BAKONG_RENEW, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await upstream.text()
  const data = text ? JSON.parse(text) : {}
  if (data.responseCode === 0 && data.data?.token) {
    serverJwt = data.data.token
    runtimeEmail = email
    saveRuntime({ email, jwt: serverJwt })
  }
  return data
}

async function ensureServerJwt(force = false) {
  if (!force && jwtStillValid(serverJwt)) return serverJwt

  const email = activeEmail()
  if (!email) return ''

  try {
    const cfg = loadConfig()
    await renewJwt(email, cfg.organization, cfg.project, cfg.registerToken)
  } catch {
    /* ignore */
  }
  return serverJwt
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function sendJson(res, status, data) {
  cors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

async function handleSetEmail(res, body) {
  let json
  try {
    json = JSON.parse(body)
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' })
  }

  const email = String(json.email || '').trim()
  if (!email) return sendJson(res, 400, { error: 'email required' })

  runtimeEmail = email
  const cfg = loadConfig()
  const force = Boolean(json.forceRenew)

  try {
    if (!force && jwtStillValid(serverJwt) && activeEmail() === email) {
      return sendJson(res, 200, {
        ok: true,
        hasJwt: true,
        token: serverJwt,
        renewed: false,
        cached: true,
      })
    }

    const data = await renewJwt(
      email,
      json.organization || cfg.organization,
      json.project || cfg.project,
      cfg.registerToken,
    )
    const jwt = serverJwt.startsWith('eyJ')
    sendJson(res, 200, {
      ok: true,
      hasJwt: jwt,
      token: jwt ? serverJwt : null,
      renewed: data.responseCode === 0,
      cached: false,
      message: jwt ? 'ready' : data.responseMessage || 'Renew failed',
    })
  } catch (err) {
    sendJson(res, 502, { error: String(err.message) })
  }
}

async function handleCheckMd5(req, res, body) {
  let json
  try {
    json = JSON.parse(body)
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' })
  }

  const md5 = json.md5
  if (!md5) return sendJson(res, 400, { error: 'md5 required' })

  let token = String(json.token || '').trim()
  if (token.startsWith('rbk')) token = ''
  if (!token.startsWith('eyJ')) token = await ensureServerJwt()

  if (!token) {
    return sendJson(res, 200, {
      responseCode: 1,
      responseMessage: 'Enter Bakong register email on the top-up page',
      errorCode: 99,
      data: null,
    })
  }

  try {
    const upstream = await fetch(BAKONG_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ md5 }),
    })
    const text = await upstream.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      return sendJson(res, 502, { error: 'Invalid response from Bakong API' })
    }

    if (data.errorCode === 6) {
      serverJwt = ''
      await ensureServerJwt(true)
      if (serverJwt.startsWith('eyJ')) {
        const retry = await fetch(BAKONG_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serverJwt}`,
          },
          body: JSON.stringify({ md5 }),
        })
        const retryText = await retry.text()
        data = retryText ? JSON.parse(retryText) : data
      }
    }

    sendJson(res, 200, data)
  } catch (err) {
    sendJson(res, 502, { error: String(err.message) })
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0])
  if (urlPath === '/') urlPath = '/index.html'
  const filePath = path.normalize(path.join(ROOT, urlPath))
  if (!filePath.startsWith(ROOT)) {
    cors(res)
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      cors(res)
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    cors(res)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  cors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    const jwt = serverJwt.startsWith('eyJ')
    return sendJson(res, 200, {
      ok: true,
      hasToken: jwt,
      hasJwt: jwt,
      email: activeEmail() || null,
    })
  }

  if (req.method === 'POST' && (req.url === '/api/set-email' || req.url === '/api/renew-token')) {
    return handleSetEmail(res, await readBody(req))
  }

  if (req.method === 'POST' && (req.url === '/api/check-md5' || req.url === '/check-md5')) {
    return handleCheckMd5(req, res, await readBody(req))
  }

  if (req.method === 'GET') {
    return serveStatic(req, res)
  }

  res.writeHead(405)
  res.end('Method not allowed')
})

await ensureServerJwt()

server.listen(PORT, '127.0.0.1', () => {
  const email = activeEmail()
  console.log('')
  console.log('  Dyna Store + Bakong proxy')
  console.log(`  Open:  http://127.0.0.1:${PORT}/index.html`)
  if (serverJwt.startsWith('eyJ')) {
    console.log('  JWT:   ready — scan KHQR → pay → balance auto-updates')
  } else if (email) {
    console.log('  JWT:   renew failed — check email is registered at Bakong API')
  } else {
    console.log('  JWT:   missing — enter register email on top-up page')
  }
  console.log('')
})
