#!/usr/bin/env node
// End-to-end check: boots the real worker (wrangler dev + workerd) against a
// throwaway D1, then exercises the seams a unit test can't reach — auth
// redirects, webhook HMAC + triggering, the stub runner driving the event log
// (the PR-anchored viewer stream), command validation, and the latest-wins
// cancellation.
//
// Hermetic by construction: state lives in a temp --persist-to dir, secrets
// are inline --var values invented below, and the port is off to the side.
// Your .dev.vars and .wrangler/state are never read or written.
//
// Run it with `pnpm e2e` after touching src/worker/**, src/dashboard/**, or
// migrations/**. (When the build-pipeline stages exist, that sentence becomes
// this stage's watch globs.)

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8970
const BASE = `http://127.0.0.1:${PORT}`
const WRANGLER = join(import.meta.dirname, '../node_modules/.bin/wrangler')
const SESSION_SECRET = 'e2e-session-secret'
const WEBHOOK_SECRET = 'e2e-webhook-secret'

// ---------- tiny check harness ----------------------------------------------

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures.push(name)
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------- crypto helpers (mirror cookies.ts / GitHub's webhook HMAC) ------

const enc = new TextEncoder()
const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

async function forgeSessionCookie() {
  const payload = JSON.stringify({ sub: 1, login: 'e2e', exp: Math.floor(Date.now() / 1000) + 3600 })
  const payloadB64 = b64url(enc.encode(payload))
  const sig = await hmac(SESSION_SECRET, payloadB64)
  return `session=${payloadB64}.${b64url(sig)}`
}

async function signWebhook(body) {
  const mac = await hmac(WEBHOOK_SECRET, body)
  return 'sha256=' + Buffer.from(mac).toString('hex')
}

// ---------- wrangler plumbing ------------------------------------------------

function d1(persistDir, args) {
  // The CLI opens the same SQLite file the dev server holds; under load
  // (CI) that can collide as SQLITE_BUSY. Transient by nature — retry.
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(
        WRANGLER,
        ['d1', ...args, '--local', '--persist-to', persistDir],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      if (attempt >= 5) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt)
    }
  }
}

function d1Query(persistDir, sql) {
  const out = d1(persistDir, ['execute', 'DB', '--json', '--command', sql])
  return JSON.parse(out)[0].results
}

async function waitForServer(child, maxMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early (code ${child.exitCode})`)
    try {
      await fetch(`${BASE}/api/me`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error('wrangler dev did not become ready in time')
}

// Extract the raw session token value from a Cookie header string.
// The viewer WS route accepts ?session=<token> as a fallback for clients
// (like Node's global WebSocket) that cannot set request headers — honored
// only under ENABLE_DEBUG_ROUTES (set below), refused in cloud. This harness
// runs gated-on, so the fallback is live here; the cloud-refused boundary is
// unit-tested in src/worker/auth/session.test.ts.
function sessionToken(cookie) {
  return (/(?:^|;\s*)session=([^;]*)/.exec(cookie) ?? [])[1] ?? ''
}

// Build a viewer WS URL, injecting the session token as ?session=.
function viewerWsUrl(path, cookie) {
  const sep = path.includes('?') ? '&' : '?'
  return `ws://127.0.0.1:${PORT}${path}${sep}session=${sessionToken(cookie)}`
}

// Connect a viewer WebSocket, collect { events, seqs, ids, runIds } until `run:end`
// arrives or maxMs elapses. `ids` is populated only by the PR stream (frames
// carry the PR-global id); per-run frames have no id, so it stays empty there.
async function collectWs(path, cookie, maxMs = 8000) {
  return new Promise((resolve) => {
    const events = []
    const seqs = []
    const ids = []
    const runIds = []
    let resolved = false
    let opened = false
    const finish = (status) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve({ status, events, seqs, ids, runIds })
    }
    const timer = setTimeout(() => finish(0), maxMs)
    const ws = new WebSocket(viewerWsUrl(path, cookie))
    ws.addEventListener('open', () => { opened = true })
    ws.addEventListener('error', () => finish(opened ? 0 : 401))
    ws.addEventListener('close', (e) => finish(opened ? (e.code === 1000 ? 200 : 0) : 401))
    ws.addEventListener('message', (e) => {
      let frame
      try { frame = JSON.parse(e.data) } catch { return }
      if (frame.kind !== 'event') return
      seqs.push(frame.seq)
      if (typeof frame.id === 'number') ids.push(frame.id)
      runIds.push(frame.runId)
      let payload
      try { payload = JSON.parse(frame.payload) } catch { return }
      events.push(payload)
      if (payload?.type === 'run:end') setTimeout(() => finish(200), 100)
    })
  })
}

// Check whether a WS upgrade is accepted ('open') or refused ('refused').
async function wsStatus(path, cookie, maxMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close() } catch {}; resolve('timeout') }, maxMs)
    const ws = new WebSocket(viewerWsUrl(path, cookie))
    ws.addEventListener('open', () => { clearTimeout(timer); resolve('open') })
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('refused') })
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('refused') })
  })
}

// Open a box channel and collect what the coordinator sends. Retiring a box
// closes the dev server's connections for a moment (a local wrangler artifact —
// no error, no production analog), and a connect landing in that window is
// refused. The box agent reconnects with backoff for the same reason; this
// mirrors it so a section that follows a retire does not fail on the bounce.
// A channel refused for a real reason (a bad token) fails every attempt and
// still throws, just later.
async function openBoxChannel(boxId, token, label, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/boxes/${boxId}/channel?token=${token}`)
    const inbox = []
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)))
    const opened = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve(true))
      ws.addEventListener('error', () => resolve(false))
      ws.addEventListener('close', () => resolve(false))
    })
    if (opened) {
      const wait = async (pred, maxMs = 4000) => {
        const start = Date.now()
        while (Date.now() - start < maxMs) {
          const hit = inbox.find(pred)
          if (hit) return hit
          await new Promise((r) => setTimeout(r, 50))
        }
        return null
      }
      return { ws, inbox, wait }
    }
    try { ws.close() } catch {}
    if (attempt >= attempts) throw new Error(`${label} channel refused after ${attempts} attempts`)
    await new Promise((r) => setTimeout(r, 200 * attempt))
  }
}

// A connection killed by that same bounce, as undici reports it. Anything else
// is a real failure and must not be retried into a pass.
function isBounce(err) {
  const code = err?.cause?.code ?? err?.code
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET'
}

// ---------- main -------------------------------------------------------------

const persistDir = mkdtempSync(join(tmpdir(), 'scenetest-e2e-'))
let server = null
let agent = null

async function main() {
  console.log('· building dashboard assets')
  execFileSync('node', [join(import.meta.dirname, '../node_modules/vite/bin/vite.js'), 'build'],
    { stdio: ['ignore', 'ignore', 'inherit'] })

  console.log('· migrating throwaway D1 and seeding a watched repo')
  d1(persistDir, ['migrations', 'apply', 'DB'])
  d1Query(persistDir, "INSERT INTO allowed_user (github_id, github_login, added_at) VALUES (1, 'e2e', 0)")
  d1Query(persistDir, "INSERT INTO watched_repo (owner, name, added_at, added_by) VALUES ('demo', 'watched', 0, 1)")

  // Seed a PR + box + run so the script can play the box itself: connect the
  // coordinator's WebSocket channel with this token and speak the box wire
  // format, with no provider involved.
  const boxToken = 'e2e-box-token'
  const boxTokenHash = Buffer.from(
    await crypto.subtle.digest('SHA-256', enc.encode(boxToken)),
  ).toString('hex')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 9, 'wsbox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-1', 'demo/watched', 9, 'wsbox1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-ws-run', 'demo/watched', 9, 'wsbox1', 'manual', 'queued', 'e2e-box-1')")
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-team-run', 'demo/watched', 9, 'wsbox1', 'manual', 'queued', 'e2e-box-1')")

  // A second PR + box for the real box agent (infra/box/agent.mjs), spawned
  // below in test mode — separate so its channel doesn't fight the inline
  // box-protocol checks. Starts 'provisioning'; the agent must flip it.
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 10, 'agbox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-2', 'demo/watched', 10, 'agbox1', 'provisioning', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-agent-run', 'demo/watched', 10, 'agbox1', 'manual', 'queued', 'e2e-box-2')")

  console.log('· starting wrangler dev')
  server = spawn(WRANGLER, [
    'dev', '--port', String(PORT), '--persist-to', persistDir,
    '--var', `SESSION_SECRET:${SESSION_SECRET}`,
    '--var', `GITHUB_WEBHOOK_SECRET:${WEBHOOK_SECRET}`,
    '--var', 'GITHUB_OAUTH_CLIENT_SECRET:e2e-dummy',
    '--var', 'ENABLE_DEBUG_ROUTES:1',
    // Preview environments resolve without Supabase or Cloudflare. Only a PR
    // that opens one is affected, and only the block below opens one.
    '--var', 'PREVIEW_PROVIDER:stub',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let serverErr = ''
  server.stderr.on('data', (d) => { serverErr += d })
  await waitForServer(server)

  const cookie = await forgeSessionCookie()
  const j = (res) => res.json()
  const waitFor = async (fn, maxMs = 6000) => {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (await fn()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  // --- auth seams ---
  console.log('· auth')
  check('SPA shell is public', (await fetch(BASE + '/')).status === 200)
  check('/api/me anonymous → 401', (await fetch(BASE + '/api/me')).status === 401)
  const me = await fetch(BASE + '/api/me', { headers: { cookie } })
  check('/api/me with forged session → 200', me.status === 200 && (await j(me)).github_login === 'e2e')

  // --- webhook seams ---
  console.log('· webhook')
  const hook = async (event, body, { delivery, badSig } = {}) => {
    const raw = JSON.stringify(body)
    return fetch(BASE + '/webhook/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery ?? crypto.randomUUID(),
        'x-hub-signature-256': badSig ? 'sha256=' + '0'.repeat(64) : await signWebhook(raw),
      },
      body: raw,
    })
  }
  const prPayload = (repo, n, sha) => ({
    action: 'opened', number: n,
    repository: { full_name: repo },
    pull_request: { state: 'open', head: { sha, ref: `pr-${n}` }, base: { ref: 'main', sha: 'base000' } },
  })

  check('bad signature → 401', (await hook('ping', {}, { badSig: true })).status === 401)
  check('ping → ignored', (await j(await hook('ping', { zen: 'ok' }))).result === 'ignored:ping')
  // A webhook-creation ping records its repo: the "wiring verified" signal
  // for project onboarding.
  await hook('ping', { zen: 'ok', repository: { full_name: 'demo/watched' } })
  const pingRow = d1Query(persistDir,
    "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'ping' AND repo = 'demo/watched'")
  check('ping delivery attributed to its repo', pingRow[0].n === 1)
  const dupId = crypto.randomUUID()
  await hook('ping', { zen: 'ok' }, { delivery: dupId })
  check('duplicate delivery → dropped', (await j(await hook('ping', { zen: 'ok' }, { delivery: dupId }))).result === 'duplicate')
  check('unwatched repo → ignored',
    (await j(await hook('pull_request', prPayload('demo/unwatched', 1, 'aaa1')))).result === 'ignored:unwatched-repo')

  const created = await j(await hook('pull_request', prPayload('demo/watched', 5, 'aaa2')))
  const webhookRunId = created.result?.startsWith('run-created:') ? created.result.slice('run-created:'.length) : null
  check('watched repo PR → run created', webhookRunId !== null, JSON.stringify(created))

  // --- watching a repo survives an unreachable/rate-limited GitHub lookup ---
  console.log('· add repo (resilient to GitHub lookup)')
  const added = await fetch(BASE + '/api/admin/repos', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'demo', name: 'added-via-api' }),
  })
  check('add-repo returns 200 even when GitHub lookup fails', added.status === 200)
  const repoList = await j(await fetch(BASE + '/api/admin/repos', { headers: { cookie } }))
  check('watched repo listed regardless of GitHub',
    repoList.repos.some((r) => r.owner === 'demo' && r.name === 'added-via-api'))
  // Casing differs from registration → still matches (NOCASE) and triggers.
  const addedHook = await j(await hook('pull_request', prPayload('demo/Added-Via-API', 2, 'addr01')))
  check('newly watched repo triggers a run (case-insensitive match)',
    addedHook.result?.startsWith('run-created:'), JSON.stringify(addedHook))

  // --- pr-closed teardown: a closed PR retires its box now -------------------
  // The webhook handler tears the box down on close/merge rather than letting
  // it bill until the age-cap reaper: retireBox cancels the PR's unfinished
  // runs, drops the coordinator's queue/sockets, and marks the droplet
  // destroyed. Seed a fresh PR with a live box + running run to drive it.
  console.log('· pr-closed teardown')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 12, 'closebox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-close', 'demo/watched', 12, 'closebox1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-close-run', 'demo/watched', 12, 'closebox1', 'manual', 'running', 'e2e-box-close')")
  const closedPayload = {
    action: 'closed', number: 12,
    repository: { full_name: 'demo/watched' },
    pull_request: { state: 'closed', head: { sha: 'closebox1' }, base: { ref: 'main', sha: 'base000' } },
  }
  const closed = await j(await hook('pull_request', closedPayload))
  check('closed PR with a live box → retired', closed.result === 'pr-closed:retired', JSON.stringify(closed))
  const closedBox = d1Query(persistDir, "SELECT status FROM boxes WHERE id = 'e2e-box-close'")
  check('closed PR marked its box destroyed', closedBox[0].status === 'destroyed', `got ${closedBox[0].status}`)
  const closedRun = d1Query(persistDir, "SELECT status, ended_at FROM runs WHERE id = 'e2e-close-run'")
  check('closed PR cancelled its unfinished run',
    closedRun[0].status === 'cancelled' && closedRun[0].ended_at != null, JSON.stringify(closedRun[0]))
  // Idempotent: closing again finds no live box and is a plain pr-closed.
  const closedAgain = await j(await hook('pull_request', closedPayload))
  check('closing again with no live box → plain pr-closed',
    closedAgain.result === 'pr-closed', JSON.stringify(closedAgain))

  // --- the run that webhook triggered, observed through the PR viewer --------
  // webhookRunId is the only run on demo/watched#5, so the whole-PR stream is
  // just that run.
  console.log('· stub run → PR viewer WS')
  const replay = await collectWs('/api/cloud/repos/demo/watched/pr/5/ws', cookie)
  const types = replay.events.map((e) => e.type)
  check('WS replays run:start first', types[0] === 'run:start')
  check('WS reaches run:end', types.includes('run:end'))
  check('scenes flowed through', types.filter((t) => t === 'scene:start').length === 4)
  check('no duplicate seq in replay', replay.seqs.length === new Set(replay.seqs).size)

  // --- PR-scoped commands (the PR is the unit; runId is an optional body
  // field, not the address). This one is run-agnostic — no runId at all. ------
  console.log('· pr commands')
  const cmdOk = await fetch(`${BASE}/api/cloud/repos/demo/watched/pr/5/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'run:stop' } }),
  })
  // No box is connected for this PR, so the coordinator queues it.
  check('valid run-agnostic command → 202 accepted', cmdOk.status === 202)
  const cmdBad = await fetch(`${BASE}/api/cloud/repos/demo/watched/pr/5/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'rm -rf' } }),
  })
  check('garbage command → 400', cmdBad.status === 400)
  check('WS with tampered session → refused',
    (await wsStatus('/api/cloud/repos/demo/watched/pr/5/ws', 'session=tampered.sig')) === 'refused')

  // --- PR coordinator: the script plays the box over the WebSocket channel --
  console.log('· PR coordinator (box channel)')
  const wsUrl = (token) => `ws://127.0.0.1:${PORT}/api/boxes/e2e-box-1/channel?token=${token}`

  // Wrong token: the upgrade is refused, surfacing as an error/close event.
  const badWs = new WebSocket(wsUrl('wrong-token'))
  const badResult = await new Promise((resolve) => {
    badWs.addEventListener('open', () => resolve('open'))
    badWs.addEventListener('error', () => resolve('refused'))
    badWs.addEventListener('close', () => resolve('refused'))
  })
  check('box channel rejects a bad token', badResult === 'refused')

  // Command posted while no box is connected → queued, not delivered. This one
  // carries a runId in the body, so the box gets it back for per-run filing.
  const queuedCmd = await fetch(`${BASE}/api/cloud/repos/demo/watched/pr/9/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'run:pause' }, runId: 'e2e-ws-run' }),
  })
  check('command with no box connected → 202 queued',
    queuedCmd.status === 202 && (await j(queuedCmd)).delivered === false)

  // Connect as the box; collect everything the coordinator sends.
  const { ws: box, inbox, wait: waitInbox } = await openBoxChannel('e2e-box-1', boxToken, 'box')

  const flushed = await waitInbox((m) => m.kind === 'command')
  check('queued command flushed to box on connect',
    flushed?.command?.type === 'run:pause' && flushed?.runId === 'e2e-ws-run',
    JSON.stringify(inbox))

  // Command posted while connected → delivered live.
  const liveCmd = await fetch(`${BASE}/api/cloud/repos/demo/watched/pr/9/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'run:resume' }, runId: 'e2e-ws-run' }),
  })
  check('command with box connected → 202 delivered',
    liveCmd.status === 202 && (await j(liveCmd)).delivered === true)
  check('live command arrived on the box socket',
    (await waitInbox((m) => m.command?.type === 'run:resume')) !== null, JSON.stringify(inbox))

  // Box streams events up the socket → coordinator appends them to its SQLite
  // log → the viewer WS (which reads that log) replays them to viewers.
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-ws-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: Date.now(), runId: 'e2e-ws-run', sceneCount: 1 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: Date.now(), runId: 'e2e-ws-run', name: 'ws scene', file: 'x.scene.ts', actors: ['A'], teamIndex: 0, team: { name: 'default' } } },
    ],
  }))
  check('coordinator acked the events batch',
    (await waitInbox((m) => m.kind === 'ack' && m.count === 2)) !== null, JSON.stringify(inbox))

  // The coordinator derives D1 projections from the same event stream (#36):
  // no /scene-executions call, no stub hand-writes. run:start moves the run to
  // 'running' with a started_at; scene:start writes a scene_executions row.
  check('run:start projected the run → running with started_at', await waitFor(() => {
    const r = d1Query(persistDir, "SELECT status, started_at FROM runs WHERE id = 'e2e-ws-run'")
    return r[0].status === 'running' && r[0].started_at != null
  }), 'runs.e2e-ws-run never went running')
  check('scene:start projected a scene_executions row from the stream', await waitFor(() => {
    const r = d1Query(persistDir,
      "SELECT status, scene_name, scene_file FROM scene_executions WHERE run_id = 'e2e-ws-run'")
    return r.length === 1 && r[0].scene_name === 'ws scene' &&
      r[0].scene_file === 'x.scene.ts' && r[0].status === 'running'
  }), 'scene_executions not derived from the event stream')

  // Two teams run the same scene in one run: same name, different teamIndex.
  // They are two executions, and scene:end names which one ended.
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-team-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: 1, runId: 'e2e-team-run', sceneCount: 2 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: 2, runId: 'e2e-team-run', name: 'shared scene', file: 's.scene.ts', actors: ['A'], teamIndex: 0, team: { name: 'alpha' } } },
      { seq: 3, payload: { type: 'scene:start', timestamp: 3, runId: 'e2e-team-run', name: 'shared scene', file: 's.scene.ts', actors: ['B'], teamIndex: 1, team: { name: 'beta' } } },
      // Settles team 0 — the scene that started FIRST, so a positional
      // most-recently-started guess would settle team 1 instead.
      { seq: 4, payload: { type: 'scene:end', timestamp: 4, runId: 'e2e-team-run', name: 'shared scene', status: 'completed', duration: 2, teamIndex: 0, team: { name: 'alpha' } } },
    ],
  }))
  await waitInbox((m) => m.kind === 'ack' && m.runId === 'e2e-team-run' && m.count === 4)

  const teamRows = () => d1Query(persistDir,
    "SELECT team_index, status FROM scene_executions WHERE run_id = 'e2e-team-run' ORDER BY team_index")
  check('scene:end settles the team it names, leaving the other running', await waitFor(() => {
    const r = teamRows()
    return r.length === 2 && r[0].status === 'passed' && r[1].status === 'running'
  }), JSON.stringify(teamRows()))

  // PR viewer: replay the whole PR's log from the object, then live events.
  const wsReplay = await collectWs('/api/cloud/repos/demo/watched/pr/9/ws', cookie, 2500)
  check('box events reached viewer via WS replay',
    wsReplay.events.some((e) => e.type === 'scene:start' && e.name === 'ws scene'))

  // Add a third event to e2e-ws-run; the PR-anchored stream below asserts replay
  // + id-cursor resume over all three (the PR stream is the only viewer now, and
  // dedupes the replay/live overlap on the PR-global id).
  box.send(JSON.stringify({
    kind: 'events', runId: 'e2e-ws-run',
    events: [{ seq: 3, payload: { type: 'action:start', timestamp: Date.now(), runId: 'e2e-ws-run', actor: 'A', action: 'click', target: 'x' } }],
  }))
  await waitInbox((m) => m.kind === 'ack' && m.runId === 'e2e-ws-run' && m.count >= 1)

  // --- PR-anchored stream: the whole PR over one socket, framed on the
  // PR-global id. e2e-ws-run is PR demo/watched#9; its events surface here keyed
  // by id (ascending, no duplicates) with the per-run seq preserved. sinceId
  // resumes past the cursor — same Last-Event-ID semantics, PR scope.
  console.log('· PR-anchored viewer stream')
  const prStream = await collectWs('/api/cloud/repos/demo/watched/pr/9/ws?sinceId=0', cookie, 2500)
  check('PR stream replays the PR\'s events',
    prStream.events.some((e) => e.type === 'scene:start' && e.name === 'ws scene'),
    JSON.stringify(prStream.events.map((e) => e.type)))
  check('PR stream ids ascend, no duplicates',
    prStream.ids.length >= 3 &&
      prStream.ids.length === new Set(prStream.ids).size &&
      prStream.ids.every((v, i) => i === 0 || v > prStream.ids[i - 1]),
    JSON.stringify(prStream.ids))
  check('PR stream preserves the per-run seq', prStream.seqs.includes(1) && prStream.seqs.includes(3))
  // Every frame names its run — the widget partitions the PR's stream by it.
  check('PR stream frames name their run',
    prStream.runIds.length > 0 && prStream.runIds.every((r) => typeof r === 'string' && r !== ''),
    JSON.stringify(prStream.runIds))
  check('PR stream frames tell the PR\'s runs apart',
    new Set(prStream.runIds).size === 2, JSON.stringify([...new Set(prStream.runIds)]))
  const lastId = Math.max(...prStream.ids)
  const prResume = await collectWs(`/api/cloud/repos/demo/watched/pr/9/ws?sinceId=${lastId}`, cookie, 1500)
  check('PR stream sinceId resumes past the cursor',
    prResume.ids.every((v) => v > lastId), JSON.stringify(prResume.ids))

  box.close()

  // --- the real box agent, spawned in test mode -----------------------------
  console.log('· box agent (infra/box/agent.mjs)')
  const agentWork = mkdtempSync(join(tmpdir(), 'scenetest-agent-'))
  // Queue a pipeline update and a command before the agent exists; both must
  // arrive via flush on connect, update first (FIFO). The update's stage
  // drops a marker file so we can see it actually executed, and its vector
  // must come back through /ready into boxes.realized_stages.
  const updateQueued = await fetch(`${BASE}/api/debug/box-update`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      boxId: 'e2e-box-2',
      headSha: 'agbox1',
      vector: { setup: 'hash-setup-1' },
      stages: [{ name: 'setup', run: 'touch stage-ran.marker' }],
      // The scenes command from pipeline.json rides the update. This stands
      // in for `scenetest --report-url $SCENETEST_REPORT_URL`: POST the
      // batched {events:[{seq,payload}]} envelope the 0.15 CLI sends, with a
      // run:end the agent settles the verdict from (1 failed → run failed).
      scenes: `curl -s -X POST "$SCENETEST_REPORT_URL" -H 'content-type: application/json' -d '{"events":[{"seq":0,"payload":{"type":"run:start","timestamp":1,"runId":"e2e-agent-run","sceneCount":1}},{"seq":1,"payload":{"type":"run:end","timestamp":2,"runId":"e2e-agent-run","duration":1,"summary":{"scenes":1,"completed":0,"failed":1}}}]}'`,
    }),
  })
  check('debug box-update queued (no box connected yet)',
    updateQueued.status === 202 && (await j(updateQueued)).delivered === false)
  await fetch(`${BASE}/api/cloud/repos/demo/watched/pr/10/commands`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ command: { type: 'run:pause' }, runId: 'e2e-agent-run' }),
  })
  check('agent: ready endpoint rejects bad token',
    (await fetch(`${BASE}/api/boxes/e2e-box-2/ready`, {
      method: 'POST', headers: { authorization: 'Bearer wrong' },
    })).status === 401)

  agent = spawn('node', [join(import.meta.dirname, '../infra/box/agent.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCENETEST_BOX_ID: 'e2e-box-2',
      SCENETEST_REPO: 'demo/watched',
      SCENETEST_HEAD_SHA: 'agbox1',
      SCENETEST_INGEST_URL: BASE,
      SCENETEST_BEARER_TOKEN: boxToken,
      SCENETEST_WORK_DIR: agentWork,
      SCENETEST_LOCAL_PORT: '4998',
      SCENETEST_SKIP_CHECKOUT: '1',
      SCENETEST_NO_POWEROFF: '1',
    },
  })
  let agentLog = ''
  agent.stdout.on('data', (d) => { agentLog += d })
  agent.stderr.on('data', (d) => { agentLog += d })

  check('agent connected its channel',
    await waitFor(() => agentLog.includes('channel connected')), agentLog)
  check('agent ran the queued pipeline stage',
    await waitFor(() => existsSync(join(agentWork, 'stage-ran.marker'))), agentLog)
  check('agent received the queued command (flush on connect)',
    await waitFor(() => {
      try { return readFileSync(join(agentWork, 'e2e-agent-run.commands.jsonl'), 'utf8').includes('run:pause') }
      catch { return false }
    }), agentLog)

  // The scenes CLI on a box reports to the agent's local ingest; the agent
  // relays up the channel and the coordinator appends to its SQLite log. seq 0
  // shares this run's seq space with the dispatch's scenes report below (run:start
  // seq 0, run:end seq 1) — one producer, one seq sequence — so run:end (seq 1)
  // is a distinct (run_id, seq) and isn't dropped by the log's INSERT OR IGNORE.
  const localIngest = await fetch('http://127.0.0.1:4998/events/e2e-agent-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ seq: 0, payload: { type: 'run:start', timestamp: Date.now(), runId: 'e2e-agent-run', sceneCount: 1 } }] }),
  })
  check('agent local ingest accepts and relays', localIngest.status === 202 && (await j(localIngest)).relayed === true)
  const agentReplay = await collectWs('/api/cloud/repos/demo/watched/pr/10/ws', cookie, 2500)
  check('agent-relayed event reached viewer via WS',
    agentReplay.events.some((e) => e.type === 'run:start'))

  // Dispatch a batch: the agent runs the scenes command from the update,
  // which POSTs its event batch to $SCENETEST_REPORT_URL (the agent's local
  // ingest); the agent relays the events and settles the verdict from run:end.
  await fetch(`${BASE}/api/debug/box-dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      boxId: 'e2e-box-2',
      run: { runId: 'e2e-agent-run', boxId: 'e2e-box-2', repo: 'demo/watched', prNumber: 10, headSha: 'agbox1', subset: null },
    }),
  })
  check('scenes command ran and its events relayed (run:end via report-url)',
    await waitFor(async () => {
      const replay = await collectWs('/api/cloud/repos/demo/watched/pr/10/ws', cookie, 1200)
      return replay.events.some((e) => e.type === 'run:end')
    }, 8000))
  check('agent settled the verdict from run:end (1 failing scene → failed)',
    await waitFor(async () => {
      const rows = d1Query(persistDir, "SELECT status FROM runs WHERE id = 'e2e-agent-run'")
      return rows[0].status === 'failed'
    }, 5000))
  agent.kill('SIGTERM')

  // A failed pipeline stage retires the box (its runs cancel; reaper would
  // sweep the droplet). Reuses box 1 — the inline section is done with it.
  const failReady = await fetch(`${BASE}/api/boxes/e2e-box-1/ready`, {
    method: 'POST',
    headers: { authorization: `Bearer ${boxToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, failed_stage: 'db' }),
  })
  check('failed stage report → box retired', (await j(failReady)).retired === true)

  // --- home view live layer: rollups → HomeCoordinator → live tiles ---------
  // Connect the cross-PR home WebSocket, then drive a stub run on a fresh PR.
  // The PR coordinator pushes coarse run-status rollups up to the singleton
  // HomeCoordinator (DO-to-DO); it fans them out here. The PR's tile should go
  // running → failed live (the stub's checkout scene always fails), carrying a
  // progress %. Proves partyserver fan-out + the upward emit end-to-end.
  console.log('· home view live layer')
  const homeResult = await new Promise((resolve) => {
    const tiles = []
    let snapshot = null
    let triggered = false
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { hws.close() } catch {}
      resolve({ snapshot, tiles })
    }
    const timer = setTimeout(finish, 15000)
    const hws = new WebSocket(viewerWsUrl('/api/cloud/home/ws', cookie))
    hws.addEventListener('error', finish)
    hws.addEventListener('message', async (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m.kind === 'snapshot') {
        snapshot = m.tiles
        if (!triggered) {
          // Subscribed now — trigger the run so we catch its tiles live (not in
          // the connect-time snapshot).
          triggered = true
          await fetch(BASE + '/api/debug/stub-run', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prNumber: 7 }),
          })
        }
      } else if (m.kind === 'tile') {
        tiles.push(m.tile)
        if (m.tile.repo === 'demo/repo' && m.tile.prNumber === 7 &&
            (m.tile.status === 'failed' || m.tile.status === 'passed')) finish()
      }
    })
  })
  const homeTiles7 = homeResult.tiles.filter((t) => t.repo === 'demo/repo' && t.prNumber === 7)
  check('home WS sent an initial snapshot', Array.isArray(homeResult.snapshot))
  check('home tile went running live (DO→DO rollup → fan-out)',
    homeTiles7.some((t) => t.status === 'running'), JSON.stringify(homeTiles7))
  check('home tile settled failed with pct 100 (stub checkout scene fails)',
    homeTiles7.some((t) => t.status === 'failed' && t.pct === 100), JSON.stringify(homeTiles7))

  // --- the add-a-project wizard's status checklist ---------------------------
  console.log('· repo setup status')
  check('status endpoint anonymous → 401',
    (await fetch(`${BASE}/api/admin/repos/demo/watched/status`)).status === 401)
  const st1 = await j(await fetch(`${BASE}/api/admin/repos/demo/watched/status`, { headers: { cookie } }))
  check('status: registered + webhook seen + first run present',
    st1.registered === true && st1.webhook.seen === true && st1.first_run != null,
    JSON.stringify(st1))
  check('status: pipeline not falsely active', st1.pipeline.state !== 'active', JSON.stringify(st1.pipeline))
  // A box that realized real (non-coarse) stages flips the pipeline check.
  d1Query(persistDir,
    `UPDATE boxes SET realized_stages = '{"deps":"d1","db":"d2","build":"d3"}'
      WHERE id = (SELECT id FROM boxes WHERE repo = 'demo/watched' ORDER BY created_at DESC, rowid DESC LIMIT 1)`)
  const st2 = await j(await fetch(`${BASE}/api/admin/repos/demo/watched/status`, { headers: { cookie } }))
  check('status: realized stages → pipeline active (from box evidence)',
    st2.pipeline.state === 'active' && st2.pipeline.source === 'box', JSON.stringify(st2.pipeline))

  // --- latest-wins: second push retires the box and cancels run 1 -----------
  // Timing assumption: the stub batch takes ≥600ms (5 × 120ms action sleeps),
  // and the second trigger lands within ~100ms of the first returning — so
  // run 1 is mid-flight when its box is retired.
  console.log('· latest-wins cancellation')
  const stubRun = async () => (await j(await fetch(BASE + '/api/debug/stub-run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prNumber: 1 }),
  }))).runId
  const run1 = await stubRun()
  const run2 = await stubRun()
  await collectWs('/api/cloud/repos/demo/repo/pr/1/ws', cookie) // closes when the PR emits run:end
  await new Promise((r) => setTimeout(r, 300)) // let run1's bailing loop settle

  const statuses = d1Query(persistDir,
    `SELECT id, status FROM runs WHERE id IN ('${run1}', '${run2}')`)
  const s = Object.fromEntries(statuses.map((r) => [r.id, r.status]))
  check('first run cancelled when box rebuilt', s[run1] === 'cancelled', `got ${s[run1]}`)
  check('second run reached its verdict', s[run2] === 'failed', `got ${s[run2]}`) // stub's checkout scene always fails
  // The same run read back as a past-run report, folded from the object's live
  // log (the R2 branch is covered after the archive below). The stub's four
  // scenes carry five assertions, one of them failing.
  const stubReport = await j(await fetch(
    `${BASE}/api/cloud/repos/demo/repo/pr/1/runs/${run2}`, { headers: { cookie } }))
  check('stub run folds into a report with its scenes, actions and assertions',
    stubReport.scenes?.length === 4 &&
      stubReport.scenes.every((sc) => sc.timeline.length > 0 && sc.assertions.length > 0) &&
      stubReport.summary?.assertions?.total === 5 && stubReport.summary.assertions.failed === 1,
    JSON.stringify(stubReport.summary))

  const live = d1Query(persistDir,
    "SELECT COUNT(*) AS n FROM boxes WHERE repo = 'demo/repo' AND pr_number = 1 AND status != 'destroyed'")
  check('exactly one live box per PR', live[0].n === 1, `got ${live[0].n}`)
  const agentBox = d1Query(persistDir,
    "SELECT status, realized_stages FROM boxes WHERE id = 'e2e-box-2'")
  check('agent flipped its box provisioning → ready (via update)',
    agentBox[0].status === 'ready', `got ${agentBox[0].status}`)
  check('realized stage vector stored from the agent report',
    agentBox[0].realized_stages === '{"setup":"hash-setup-1"}', `got ${agentBox[0].realized_stages}`)
  const failedBox = d1Query(persistDir,
    "SELECT b.status, r.status AS run_status FROM boxes b JOIN runs r ON r.box_id = b.id WHERE b.id = 'e2e-box-1'")
  check('failed-stage box destroyed and its run cancelled',
    failedBox[0].status === 'destroyed' && failedBox[0].run_status === 'cancelled',
    JSON.stringify(failedBox[0]))

  // --- R2 durable artifacts: log in the object → archive → serve from R2 ----
  // The event log lives in the PR object's SQLite. At end of run the object
  // flushes it to a per-run R2 .jsonl; D1 never holds the log, so there is no
  // prune. We drive a log into a fresh PR's object over the box channel, then
  // archive it via the cron backstop and read it back.
  console.log('· R2 artifacts (archive → serve from R2)')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 11, 'artif1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-art', 'demo/watched', 11, 'artif1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-artifact-run', 'demo/watched', 11, 'artif1', 'manual', 'running', 'e2e-box-art')")

  // Drive the run's log into the PR object over its box channel.
  const { ws: artBox, inbox: artInbox } = await openBoxChannel('e2e-box-art', boxToken, 'art box')
  artBox.send(JSON.stringify({
    kind: 'events', runId: 'e2e-artifact-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: 1, runId: 'e2e-artifact-run', sceneCount: 1 } },
      { seq: 2, payload: { type: 'scene:start', timestamp: 1, runId: 'e2e-artifact-run', name: 'artifact scene', file: 'a.scene.ts', actors: ['A'], teamIndex: 0, team: { name: 'default' } } },
      { seq: 3, payload: { type: 'assertion', timestamp: 1, runId: 'e2e-artifact-run', actor: 'A', description: 'page loads', result: true, scene: 'artifact scene', teamIndex: 0 } },
      { seq: 4, payload: { type: 'scene:end', timestamp: 2, runId: 'e2e-artifact-run', name: 'artifact scene', status: 'completed', duration: 1, teamIndex: 0, team: { name: 'default' } } },
      { seq: 5, payload: { type: 'run:end', timestamp: 2, runId: 'e2e-artifact-run', duration: 1, summary: { scenes: 1, completed: 1, failed: 0, assertions: { total: 1, passed: 1, failed: 0 }, warnings: 0, consoleErrors: 0 } } },
    ],
  }))
  const artAck = await waitFor(() =>
    artInbox.some((m) => m.kind === 'ack' && m.runId === 'e2e-artifact-run' && m.count === 5))
  check('artifact run events acked by the coordinator', artAck, JSON.stringify(artInbox))

  // run:end settles the verdict in D1 through the same projection writer (#36):
  // the run was inserted 'running'; the event stream alone moves it to 'passed'
  // (0 failed) with an ended_at — no /complete call on this path.
  check('run:end projected the settled verdict (0 failed → passed)', await waitFor(() => {
    const r = d1Query(persistDir, "SELECT status, ended_at FROM runs WHERE id = 'e2e-artifact-run'")
    return r[0].status === 'passed' && r[0].ended_at != null
  }), 'run:end did not settle the verdict in D1')

  check('run log anonymous → 401', (await fetch(`${BASE}/api/runs/e2e-artifact-run/log`)).status === 401)

  // Before archive: /log streams the live log straight from the object's SQLite.
  const logPre = await fetch(`${BASE}/api/runs/e2e-artifact-run/log`, { headers: { cookie } })
  const logPreText = await logPre.text()
  check('run log serves the live log from the object before archive',
    logPre.status === 200 && logPreText.includes('run:start') && logPreText.includes('run:end'),
    `${logPre.status} ${logPreText.slice(0, 120)}`)

  // Terminal (settled above by the projection writer) + no artifact_key → the
  // cron archive backstop flushes it to R2.
  const sched = await fetch(`${BASE}/cdn-cgi/handler/scheduled`)
  check('scheduled handler reachable', sched.status === 200, `got ${sched.status}`)
  check('cron archive backstop wrote the artifact_key', await waitFor(() => {
    const r = d1Query(persistDir, "SELECT artifact_key FROM runs WHERE id = 'e2e-artifact-run'")
    return r[0].artifact_key != null
  }), 'artifact_key never set')

  // After archive: getRunLog prefers the R2 artifact.
  const logPost = await fetch(`${BASE}/api/runs/e2e-artifact-run/log`, { headers: { cookie } })
  const logPostText = await logPost.text()
  check('run log serves from R2 after archive',
    logPost.status === 200 && logPostText.includes('run:start') && logPostText.includes('run:end'),
    `${logPost.status} ${logPostText.slice(0, 120)}`)

  // The object keeps its log (no prune), so the PR viewer replay still serves it
  // after archive; the R2 fold-back only matters once the object is reset at PR
  // teardown (the re-fold section below).
  const artifactReplay = await collectWs('/api/cloud/repos/demo/watched/pr/11/ws', cookie, 2500)
  const artTypes = artifactReplay.events.map((e) => e.type)
  check('viewer replay serves the full log after archive',
    artTypes.includes('run:start') && artTypes.includes('run:end'), JSON.stringify(artTypes))
  check('replay has no duplicate seq',
    artifactReplay.seqs.length === new Set(artifactReplay.seqs).size, JSON.stringify(artifactReplay.seqs))
  artBox.close()

  // --- past-run report (the run picker and the ?run=<id> deep link) ---------
  // The widget leaves live mode when the URL carries ?run=<id> and reads the run
  // from these two endpoints: the picker lists GET .../runs, the view renders
  // GET .../runs/:runId. This runs after the archive above, so the report is
  // folded from the R2 artifact — the same path a link followed days later takes.
  console.log('· past-run report')
  const runsBase = '/api/cloud/repos/demo/watched/pr/11'
  check('run list anonymous → 401', (await fetch(`${BASE}${runsBase}/runs`)).status === 401)

  const runList = await j(await fetch(`${BASE}${runsBase}/runs`, { headers: { cookie } }))
  const listed = (runList.runs ?? []).find((r) => r.id === 'e2e-artifact-run')
  check('run list names the PR\'s run with an mtime',
    listed != null && typeof listed.mtime === 'number' && listed.mtime > 0, JSON.stringify(runList))

  const reportRes = await fetch(`${BASE}${runsBase}/runs/e2e-artifact-run`, { headers: { cookie } })
  const report = await j(reportRes)
  check('run report serves the run folded from its archived log',
    reportRes.status === 200 && report.scenes?.length === 1,
    `${reportRes.status} ${JSON.stringify(report).slice(0, 200)}`)
  check('run report carries the scene with its assertion',
    report.scenes?.[0]?.name === 'artifact scene' &&
      report.scenes[0].status === 'completed' &&
      report.scenes[0].assertions?.[0]?.description === 'page loads',
    JSON.stringify(report.scenes))
  check('run report summary counts the scene and its assertion',
    report.summary?.scenes === 1 && report.summary?.completed === 1 &&
      report.summary?.assertions?.passed === 1,
    JSON.stringify(report.summary))

  // The PR in the path is the authority: another PR's run is not readable here.
  const wrongPr = await fetch(
    `${BASE}/api/cloud/repos/demo/watched/pr/10/runs/e2e-artifact-run`, { headers: { cookie } })
  check('run report 404s for a run belonging to another PR', wrongPr.status === 404, `got ${wrongPr.status}`)

  // --- re-fold: an archived run rejoins the PR stream after teardown ---------
  // THE DO OWNS THE LOG and R2 can recreate it exactly. Reset the PR object's
  // live log (modelling teardown), then reconnect the PR-anchored stream: the
  // archived run is folded back from R2 under its original ids, so the whole-PR
  // history survives the reset. e2e-artifact-run is PR demo/watched#11.
  console.log('· re-fold archived run into the PR stream')
  // Baseline: the ids the live log minted, before we throw the log away.
  const preReset = await collectWs('/api/cloud/repos/demo/watched/pr/11/ws?sinceId=0', cookie, 2500)
  check('PR stream serves the archived run before reset',
    preReset.events.some((e) => e.type === 'run:end') && preReset.ids.length >= 3,
    JSON.stringify(preReset.ids))

  const reset = await fetch(`${BASE}/api/debug/reset-pr-log`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'demo/watched', prNumber: 11 }),
  })
  check('reset-pr-log drops the live log', reset.status === 200, `got ${reset.status}`)

  const reFold = await collectWs('/api/cloud/repos/demo/watched/pr/11/ws?sinceId=0', cookie, 2500)
  const reFoldTypes = reFold.events.map((e) => e.type)
  check('re-fold replays the archived run from R2',
    reFoldTypes.includes('run:start') && reFoldTypes.includes('run:end'),
    JSON.stringify(reFoldTypes))
  check('re-fold preserves the original ids (same stream every time)',
    JSON.stringify(reFold.ids) === JSON.stringify(preReset.ids),
    `before=${JSON.stringify(preReset.ids)} after=${JSON.stringify(reFold.ids)}`)
  check('re-fold preserves the per-run seq', reFold.seqs.includes(1) && reFold.seqs.includes(3))

  // --- preview environment ---------------------------------------------------
  // A PR whose pipeline declares a hosted preview gets a Supabase branch and
  // has its keys written to the project's Cloudflare Worker. Nothing about it
  // touches the box or the run: this walks the environment to ready on its
  // own, with the polls driven by hand rather than by timing the alarm.
  console.log('· preview environment')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, head_ref, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 14, 'prev1', 'feat/preview', 'main', 'open', 0, 0)")

  const previewPost = (path, body) =>
    fetch(`${BASE}/api/debug/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo/watched', prNumber: 14, ...body }),
    })
  const previewRow = () =>
    d1Query(persistDir, "SELECT status, branch_ref, worker_name FROM preview_envs WHERE pr_number = 14")[0]

  const opened = await previewPost('preview-start', { gitBranch: 'feat/preview' })
  check('preview environment opens', opened.status === 202)
  check('it starts out building', previewRow()?.status === 'building', JSON.stringify(previewRow()))

  // The stub resolves on its second poll, and opening the environment arms an
  // alarm that may already have spent the first. Poll to ready rather than
  // counting them.
  let previewStatus = 'building'
  for (let poll = 0; poll < 5 && previewStatus !== 'ready'; poll++) {
    previewStatus = (await j(await previewPost('preview-step'))).status
  }
  check('polling drives the environment to ready', previewStatus === 'ready', previewStatus)
  check('the branch and Worker are recorded for the next push',
    previewRow()?.branch_ref === 'stub-14' && previewRow()?.worker_name === 'stub-preview-pr-14',
    JSON.stringify(previewRow()))

  // A pooled connection can die between blocks (the local dev server bounces
  // its connections; no production analog), so retry the bounce rather than
  // reading it as a failed check.
  const previewBody = await j(await (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetch(`${BASE}/api/debug/preview?repo=demo/watched&prNumber=14`)
      } catch (err) {
        if (attempt >= 4 || !isBounce(err)) throw err
        await new Promise((r) => setTimeout(r, 200 * attempt))
      }
    }
  })())
  check('the preview object and the row agree',
    previewBody.row?.status === 'ready' && previewBody.object?.status === 'ready',
    JSON.stringify(previewBody))

  // Closing the PR takes the environment with it.
  await hook('pull_request', {
    action: 'closed', number: 14,
    repository: { full_name: 'demo/watched' },
    pull_request: { state: 'closed', head: { sha: 'prev1', ref: 'feat/preview' }, base: { ref: 'main', sha: 'base000' } },
  })
  check('closing the PR drops its preview environment',
    await waitFor(() => previewRow() === undefined),
    JSON.stringify(previewRow()))

  // --- idle teardown: the coordinator's alarm retires a box once idle --------
  // #30: activity-based retirement replaces the age cap. The PR object resets a
  // DO alarm on every activity signal and, when it fires with the PR's runs all
  // settled, marks the box destroyed (the reaper then drops the droplet) —
  // promptly, without waiting out RUNNER_MAX_AGE_MINUTES. An in-flight run
  // re-arms instead. We drive the alarm logic via /api/debug/idle-check so the
  // test is deterministic rather than timing the real window. Last in the run:
  // the retire briefly bounces the dev server's connections (a local wrangler
  // artifact — no error, no production analog), so nothing should open a box
  // channel after it.
  console.log('· idle teardown (DO alarm)')
  d1Query(persistDir,
    "INSERT INTO prs (repo, pr_number, head_sha, base_ref, state, opened_at, updated_at) VALUES ('demo/watched', 13, 'idlebox1', 'main', 'open', 0, 0)")
  d1Query(persistDir,
    `INSERT INTO boxes (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at) VALUES ('e2e-box-idle', 'demo/watched', 13, 'idlebox1', 'ready', '${boxTokenHash}', 0)`)
  d1Query(persistDir,
    "INSERT INTO runs (id, repo, pr_number, head_sha, trigger, status, box_id) VALUES ('e2e-idle-run', 'demo/watched', 13, 'idlebox1', 'manual', 'running', 'e2e-box-idle')")

  // Connect the box channel: the coordinator records the box it coordinates (the
  // alarm's retire target) and arms the idle alarm.
  const { ws: idleBox, wait: waitIdleInbox } = await openBoxChannel('e2e-box-idle', boxToken, 'idle box')
  // Retiring a box closes the dev server's connections, so a request on a pooled
  // one can die in transit — the same bounce openBoxChannel retries through.
  // Retry rather than swallow: a lost request means the alarm never ran.
  // Re-running it is a no-op once the box is retired.
  const idleCheck = async (attempts = 4) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetch(`${BASE}/api/debug/idle-check`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: 'demo/watched', prNumber: 13 }),
        })
      } catch (err) {
        if (attempt >= attempts || !isBounce(err)) throw err
        await new Promise((r) => setTimeout(r, 200 * attempt))
      }
    }
  }

  const idleBoxStatus = () =>
    d1Query(persistDir, "SELECT status FROM boxes WHERE id = 'e2e-box-idle'")[0].status

  // A run is in flight (ended_at NULL) → the box is busy: the alarm re-arms, the
  // box survives. (A hung run that never settles is the age cap's job.)
  await idleCheck()
  check('idle check keeps a box with an in-flight run', idleBoxStatus() === 'ready', `got ${idleBoxStatus()}`)

  // Settle the run from the event stream (run:end → ended_at set).
  idleBox.send(JSON.stringify({
    kind: 'events', runId: 'e2e-idle-run',
    events: [
      { seq: 1, payload: { type: 'run:start', timestamp: 1, runId: 'e2e-idle-run', sceneCount: 1 } },
      { seq: 2, payload: { type: 'run:end', timestamp: 2, runId: 'e2e-idle-run', duration: 1, summary: { scenes: 1, completed: 1, failed: 0 } } },
    ],
  }))
  await waitIdleInbox((m) => m.kind === 'ack' && m.runId === 'e2e-idle-run' && m.count === 2)
  check('idle run settled to a verdict', await waitFor(() => {
    const r = d1Query(persistDir, "SELECT ended_at FROM runs WHERE id = 'e2e-idle-run'")
    return r[0].ended_at != null
  }), 'e2e-idle-run never settled')

  // Idle with every run settled → the alarm retires the box now, well short of
  // the age cap.
  await idleCheck()
  check('idle check retires the box once its runs settle', await waitFor(() => idleBoxStatus() === 'destroyed'),
    `got ${idleBoxStatus()}`)
  idleBox.close()

  if (failures.length > 0 && serverErr) {
    console.error('\n--- wrangler dev stderr (tail) ---\n' + serverErr.split('\n').slice(-20).join('\n'))
  }
}

main()
  .catch((err) => {
    failures.push('script error')
    console.error('script error:', err)
  })
  .finally(() => {
    if (agent && agent.exitCode === null) agent.kill('SIGKILL')
    if (server && server.exitCode === null) server.kill('SIGTERM')
    rmSync(persistDir, { recursive: true, force: true })
    console.log(`\n${passed} passed, ${failures.length} failed`)
    process.exit(failures.length > 0 ? 1 : 0)
  })
