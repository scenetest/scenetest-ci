import type { Env } from '../env.ts'
import type { RunEvent } from '../db.ts'
import type { HomeTile } from './home-coordinator.ts'
import { artifactKey, readArtifactLog } from '../artifacts.ts'

// One Durable Object per PR: the coordination point between the PR's box and
// the rest of the system. It terminates the box's single outbound WebSocket
// (hibernation API, so an idle connected box costs nothing), queues commands
// and run dispatches while no box is connected, and — the point of this class —
// **owns the PR's event log** in its own SQLite. The box's events land in the
// `log` table; the live fan-out and replay-on-connect both read from there, and
// at end of run the log is flushed to a per-run R2 `.jsonl` archive. D1 never
// holds log lines (see docs/architecture.md, "The log and its projections").
//
// The log carries every run for this PR. (run_id, seq) is the box's per-run
// sequence — UNIQUE, the resend idempotency key, a fact the box asserts. `id` is
// a per-object autoincrement: the log's own record of receive-order, the
// PR-global position the PR viewer (/pr-viewer-connect) streams and resumes on,
// with run_id as the channel discriminator. A subscriber tails the log, not the
// fact-stream — events arrive in
// the order the DO logged them (frozen once minted), not necessarily as they
// happened; deterministic and replayable, so multi-box ordering needn't be
// reasoned about.
//
// At teardown the SQLite is reset (POST /reset: DELETE, keeping the autoincrement
// high-water mark), but runs survive in R2 with their `id`, so rehydrateArchived
// folds a run back UNDER ITS ORIGINAL id — same stream whatever the restore order.
//
// Box-channel wire format — OUR contract between worker and box bootstrap,
// wrapping (not extending) the published protocol:
//   box → cloud: { kind: 'events', runId, events: [{ seq, payload }] }
//     — same shape as the HTTP ingest body plus runId; payloads stay opaque
//       (envelope-grade checks only, so newer event types relay through).
//   cloud → box: { kind: 'command', runId?, command } (a protocol Command;
//                  runId present only when the command targets a run)
//                { kind: 'dispatch', run }              (a RunSpec batch)
//                { kind: 'update', update }             (checkout + run
//                  pipeline stages: { headSha, vector, stages: [{name,run}] })
//
// Viewer-channel wire format (WS, cookie-authed at the worker edge):
//   cloud → viewer: { kind: 'event', id, runId, seq, payload }
//     `id` is the PR-global position (cursor + the client collection's key),
//     run_id the channel discriminator, seq the box's per-run sequence, and
//     payload the raw JSON string. Client JSON.parse(frame.payload)s to recover
//     the protocol event, and dedupes the replay/live overlap on id.
//
// Idle teardown — the object owns *when* a box is retired (architecture.md,
// "Runner"). Every activity signal (box connect, viewer connect, an events
// batch, a command/dispatch) resets a Durable Object alarm; when it fires with
// all of this PR's runs settled, the box is marked destroyed (the cron reaper
// then destroys the backing droplet). An in-flight run re-arms instead — a
// genuinely hung box whose run never settles is left to the age-cap backstop
// (RUNNER_MAX_AGE_MINUTES). The window is RUNNER_IDLE_TIMEOUT_MINUTES (default
// 5). The tracked box id lives in storage, set on box connect.
//
// Internal HTTP surface (reachable only via the binding, never publicly):
//   GET  /box-connect?boxId=…              — WebSocket upgrade for the box
//   GET  /pr-viewer-connect?sinceId=…       — WebSocket upgrade, whole PR
//   GET  /jsonl?runId=…                    — the run's log as .jsonl text
//   POST /archive                          — { runId } → flush log to R2
//   POST /reset                            — drop live log rows (PR teardown)
//   POST /command                          — { runId?, command } → send or queue
//   POST /dispatch                         — { run: RunSpec } → send or queue
//   POST /retire                           — { boxId } → close sockets, drop queue
//   POST /idle-check                       — run the idle-alarm logic now (test hook)
//   POST /ingest/:runId                    — { events } → ingestAndFanout

interface EventsEnvelope {
  kind: 'events'
  runId: string
  events: RunEvent[]
}

// A stored log row, as returned by the ingest RETURNING clause: `id` is the
// PR-global position, `seq` the box's per-run sequence, `payload` the JSON
// string as stored.
interface StoredEvent {
  id: number
  seq: number
  payload: string
}

const QUEUE_PREFIX = 'q:'
const REPLAY_PAGE = 1000
// The box this object is coordinating, persisted on box connect so the idle
// alarm knows what to retire (the DO can't read its own name).
const BOX_ID_KEY = 'boxId'
const IDLE_DEFAULT_MINUTES = 5

// The run/scene boundary events the D1 projections are derived from. Everything
// else in the log (actions, assertions, …) is a fact for the live stream only —
// projections settle at boundaries, "a couple of writes per run, not per event"
// (architecture.md, "The log and its projections").
const PROJECTED = new Set(['run:start', 'scene:start', 'scene:end', 'run:end'])

// Coarse run-status rollups to the home view are throttled to this cadence for
// progress (scene:end) updates; run:start / run:end always emit so status
// transitions are never delayed (architecture.md, "The home view").
const ROLLUP_THROTTLE_MS = 2000

// The boundary-event payloads the projection writer reads. Fields beyond `type`
// are best-effort (the payload is opaque protocol JSON); a missing one just
// drops that part of the projection.
interface BoundaryPayload {
  type: string
  timestamp?: number
  name?: string
  file?: string
  teamIndex?: number
  status?: string
  error?: unknown
  sceneCount?: number
  summary?: { failed?: number } & Record<string, unknown>
}

// A scene execution's row id: the run, the team, and the scene's name — every
// part of it carried by both scene:start and scene:end, so the settle is a
// primary-key write. The widget keys a scene the same way.
function sceneRowId(runId: string, teamIndex: number, name: string): string {
  return `${runId}:${teamIndex}:${name}`
}

// Parse a batch's boundary events out of the just-inserted log rows. The shared
// input to both the D1 projection writer and the home-view rollup emit.
function parseBoundary(inserted: StoredEvent[]): BoundaryPayload[] {
  const out: BoundaryPayload[] = []
  for (const e of inserted) {
    let p: BoundaryPayload | null = null
    try { p = JSON.parse(e.payload) as BoundaryPayload } catch { continue }
    if (p && typeof p.type === 'string' && PROJECTED.has(p.type)) out.push(p)
  }
  return out
}

// Immutable per-run identity the scene_executions projection needs. Resolved
// from D1 once per run and cached for the object's lifetime.
interface RunMeta {
  repo: string
  prNumber: number
  headSha: string
}

export class PrCoordinator implements DurableObject {
  private sql: SqlStorage
  // Cache of each run's immutable D1 identity, so the projection writer resolves
  // repo/pr/sha once per run rather than per ingest batch. Dropped on eviction
  // and lazily rebuilt; the runs row is the source of truth.
  private runMeta = new Map<string, RunMeta>()
  // Last home-view rollup emit per run, for throttling progress updates.
  private lastRollupAt = new Map<string, number>()

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // SQLite-backed (wrangler new_sqlite_classes). The schema is created on
    // first construction and is a no-op thereafter; the constructor runs
    // before any request is dispatched, so the table is always present.
    // The PR's whole event log. `id` is a per-object (= per-PR) autoincrement —
    // the single PR-global position the PR-anchored viewer streams/resumes on.
    // (run_id, seq) stays UNIQUE: the box's per-run sequence, the resend
    // idempotency key (INSERT OR IGNORE), and in parity with the box's .jsonl.
    this.sql = state.storage.sql
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         id      INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id  TEXT    NOT NULL,
         seq     INTEGER NOT NULL,
         payload TEXT    NOT NULL,
         ts      INTEGER NOT NULL,
         UNIQUE (run_id, seq)
       )`,
    )
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/box-connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      const boxId = url.searchParams.get('boxId')
      if (!boxId) return new Response('boxId required', { status: 400 })

      // Latest wins extends to connections: at most one live box channel.
      for (const ws of this.state.getWebSockets('box')) ws.close(1012, 'replaced')

      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1]!, ['box', boxId])
      // Remember which box we coordinate (the idle alarm retires it) and treat
      // the connect itself as activity.
      await this.state.storage.put(BOX_ID_KEY, boxId)
      await this.resetIdleAlarm()
      await this.flushQueue(pair[1]!)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (url.pathname === '/pr-viewer-connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      // Whole-PR stream: no run filter, just a resume cursor over the PR-global
      // id. repo + pr (the DO stores no identity) let rehydrate find the PR's
      // archived runs in D1.
      let sinceId = parseInt(url.searchParams.get('sinceId') ?? '0', 10)
      if (!Number.isFinite(sinceId) || sinceId < 0) sinceId = 0
      const repo = url.searchParams.get('repo')
      const prNumber = parseInt(url.searchParams.get('pr') ?? '', 10)

      // Fold archived/reset runs back in BEFORE registering for live fan-out:
      // rehydrate awaits (D1 + R2), and any live frame delivered during that
      // await would land ahead of the not-yet-sent replay, jumping the client's
      // id cursor past — and so dropping — the unreplayed lower ids. Those
      // events are in the log regardless, so replay (after register) still
      // covers them. Register THEN replay runs without an await between, so no
      // live frame can interleave ahead of the replay.
      if (repo && Number.isFinite(prNumber)) await this.rehydrateArchived(repo, prNumber)
      await this.resetIdleAlarm()
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1]!, ['viewer', 'prv'])
      await this.replayPrTo(pair[1]!, sinceId)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (url.pathname === '/jsonl' && req.method === 'GET') {
      const runId = url.searchParams.get('runId')
      if (!runId) return new Response('runId required', { status: 400 })
      return new Response(this.buildRunJsonl(runId), {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      })
    }

    if (url.pathname === '/archive' && req.method === 'POST') {
      const { runId } = (await req.json()) as { runId: string }
      if (!runId) return new Response('runId required', { status: 400 })
      const key = await this.archiveRun(runId)
      return Response.json({ key })
    }

    if (url.pathname === '/reset' && req.method === 'POST') {
      // PR teardown. DELETE, not DROP: keeping the autoincrement high-water mark
      // means a later re-fold slots archived rows back under their original ids
      // while ids for post-revival runs climb above — the two never collide.
      this.sql.exec('DELETE FROM log')
      return Response.json({ ok: true })
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      // runId is optional: it targets the box's per-run bookkeeping when a
      // command names a run, and is absent for run-agnostic commands. JSON
      // drops an undefined key, so the box sees runId only when one was sent.
      const { runId, command } = (await req.json()) as { runId?: string; command: unknown }
      const delivered = await this.sendOrQueue({ kind: 'command', runId, command })
      return Response.json({ delivered })
    }

    if (url.pathname === '/dispatch' && req.method === 'POST') {
      const { run } = (await req.json()) as { run: unknown }
      const delivered = await this.sendOrQueue({ kind: 'dispatch', run })
      return Response.json({ delivered })
    }

    if (url.pathname === '/update' && req.method === 'POST') {
      // Pipeline update: checkout this sha and run these stages, then report
      // ready with the vector. Queued like everything else so a still-booting
      // box receives it first (FIFO), before any dispatches.
      const update = (await req.json()) as unknown
      const delivered = await this.sendOrQueue({ kind: 'update', update })
      return Response.json({ delivered })
    }

    if (url.pathname === '/retire' && req.method === 'POST') {
      const { boxId } = (await req.json()) as { boxId: string }
      await this.retireBoxLocally(boxId)
      return Response.json({ ok: true })
    }

    if (url.pathname === '/idle-check' && req.method === 'POST') {
      // Run the idle-alarm logic on demand. The runtime calls alarm() on the
      // timer; this lets the e2e drive the same path deterministically.
      await this.alarm()
      return Response.json({ ok: true })
    }

    if (url.pathname.startsWith('/ingest/') && req.method === 'POST') {
      const runId = decodeURIComponent(url.pathname.slice('/ingest/'.length))
      if (!runId) return new Response('runId required', { status: 400 })
      const { events } = (await req.json()) as { events?: RunEvent[] }
      const valid = (events ?? []).filter(
        (e): e is RunEvent => e != null && typeof e.seq === 'number',
      )
      await this.ingestAndFanout(runId, valid)
      return Response.json({ ok: true, count: valid.length })
    }

    return new Response('Not Found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      ws.send(JSON.stringify({ kind: 'error', message: 'not json' }))
      return
    }
    const envelope = parsed as Partial<EventsEnvelope>
    if (envelope.kind !== 'events' || typeof envelope.runId !== 'string' || !Array.isArray(envelope.events)) {
      ws.send(JSON.stringify({ kind: 'error', message: 'unknown envelope' }))
      return
    }
    const events = envelope.events.filter(
      (e): e is RunEvent => e != null && typeof e.seq === 'number',
    )
    await this.ingestAndFanout(envelope.runId, events)
    ws.send(JSON.stringify({ kind: 'ack', runId: envelope.runId, count: events.length }))
  }

  async webSocketClose(): Promise<void> {
    // Nothing to clean: connection state lives in the socket tags, and the
    // queue persists precisely for the box-not-connected case.
  }

  // Idle teardown. The runtime fires this when the idle window elapses with no
  // activity. If a run is still in flight the box is busy, not idle — re-arm and
  // wait (a hung run that never settles is the age cap's job, not ours). With
  // every run settled, mark the box destroyed: the DO owns the teardown
  // *decision*; the cron reaper destroys the droplet on its next pass (boxes
  // with status 'destroyed' are swept regardless of age). retireBox in box.ts is
  // not reused — it fetches this same object's /retire, and a DO awaiting a
  // subrequest to itself deadlocks; the equivalent runs inline here instead.
  async alarm(): Promise<void> {
    const boxId = await this.state.storage.get<string>(BOX_ID_KEY)
    if (!boxId) return
    const active = await this.env.DB.prepare(
      `SELECT 1 FROM runs WHERE box_id = ?1 AND ended_at IS NULL LIMIT 1`,
    )
      .bind(boxId)
      .first()
    if (active) {
      await this.resetIdleAlarm()
      return
    }
    await this.env.DB.prepare(
      `UPDATE boxes SET status = 'destroyed', destroyed_at = ?1 WHERE id = ?2 AND status != 'destroyed'`,
    )
      .bind(Date.now(), boxId)
      .run()
    await this.retireBoxLocally(boxId)
  }

  private idleTimeoutMs(): number {
    const minutes = Number(this.env.RUNNER_IDLE_TIMEOUT_MINUTES ?? IDLE_DEFAULT_MINUTES)
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : IDLE_DEFAULT_MINUTES) * 60_000
  }

  // Push the idle alarm out by one window. setAlarm replaces any pending one, so
  // each activity signal extends the window from now.
  private async resetIdleAlarm(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + this.idleTimeoutMs())
  }

  // Close the box's sockets and drop the command queue — the queue targeted the
  // retired box's state, and a fresh box gets new dispatches from createRun. If
  // this is the box we were tracking, forget it and disarm the idle alarm.
  private async retireBoxLocally(boxId: string): Promise<void> {
    for (const ws of this.state.getWebSockets(boxId)) ws.close(1001, 'box retired')
    await this.clearQueue()
    if ((await this.state.storage.get<string>(BOX_ID_KEY)) === boxId) {
      await this.state.storage.delete(BOX_ID_KEY)
      await this.state.storage.deleteAlarm()
    }
  }

  private async ingestAndFanout(runId: string, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return
    // A batch arriving (even a box's resend) is activity: push the idle alarm out.
    await this.resetIdleAlarm()
    const now = Date.now()
    // INSERT OR IGNORE: a box reconnect can replay events it already sent;
    // (run_id, seq) is the dedup key, so re-delivery is a no-op. RETURNING
    // yields a row only for an actually-inserted event, each carrying its `id`
    // (the PR-global position) — so PR fan-out never duplicates.
    const inserted: StoredEvent[] = []
    for (const e of events) {
      const row = this.sql
        .exec(
          'INSERT OR IGNORE INTO log (run_id, seq, payload, ts) VALUES (?, ?, ?, ?) RETURNING id, seq, payload',
          runId,
          e.seq,
          JSON.stringify(e.payload ?? null),
          now,
        )
        .toArray()[0] as StoredEvent | undefined
      if (row) inserted.push(row)
    }
    // Live fan-out first — viewers must not wait on anything downstream — then
    // settle the D1 projections, then push the coarse rollup up to the home
    // view. The three are independent; only fan-out is on the live path. The
    // rollup runs last so it reads the freshly-projected run/scene state.
    this.fanoutPr(runId, inserted)
    const boundary = parseBoundary(inserted)
    if (boundary.length === 0) return
    await this.projectToD1(runId, boundary, now)
    await this.emitRollup(runId, boundary, now)
  }

  // Derive D1 projections from the log the object already owns. This is the
  // projection writer the architecture promises the object runs at run
  // boundaries (architecture.md, "The log and its projections"): the box (or
  // stub) only asserts events; runs.status, started_at/ended_at and the
  // scene_executions grid are pure functions of the stream, computed here so
  // one code path serves real and stub runs identically. INSERT OR IGNORE on
  // the log means `inserted` is the deduped set, so re-delivery never
  // double-projects; the boundary UPDATEs are idempotent regardless.
  private async projectToD1(runId: string, boundary: BoundaryPayload[], now: number): Promise<void> {
    // scene rows carry NOT NULL repo/pr/sha — resolve them only when a
    // scene:start is actually in this batch.
    const meta = boundary.some((p) => p.type === 'scene:start')
      ? await this.resolveRunMeta(runId)
      : null

    const stmts: D1PreparedStatement[] = []
    for (const p of boundary) {
      const ts = typeof p.timestamp === 'number' ? p.timestamp : now
      switch (p.type) {
        case 'run:start':
          // First sign of life: queued → running. scene_count (the run's scene
          // total) feeds the home view's progress %. The ended_at guard keeps a
          // late/replayed run:start from resurrecting an already-settled or
          // cancelled run (latest-wins sets ended_at on cancel).
          stmts.push(
            this.env.DB.prepare(
              'UPDATE runs SET status = ?1, started_at = ?2, scene_count = COALESCE(?3, scene_count) WHERE id = ?4 AND ended_at IS NULL',
            ).bind('running', ts, typeof p.sceneCount === 'number' ? p.sceneCount : null, runId),
          )
          break
        case 'scene:start': {
          if (!meta || typeof p.file !== 'string' || typeof p.name !== 'string') break
          if (typeof p.teamIndex !== 'number') break
          // scene_id stays file+name: it is the cross-run key the flaky check
          // groups on, and the same scene run by two teams is one scene. The
          // row id is (run, team, name) — what scene:end can name, since it
          // carries no file. Two same-named scenes in different files are one
          // row; the protocol gives a consumer no way to tell them apart when
          // one ends.
          const sceneId = `${p.file}:${p.name}`
          stmts.push(
            this.env.DB.prepare(
              `INSERT INTO scene_executions
                 (id, run_id, repo, pr_number, scene_id, scene_file, scene_name, team_index, head_sha, status, started_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10)
               ON CONFLICT(id) DO UPDATE SET
                 status = 'running',
                 started_at = COALESCE(excluded.started_at, scene_executions.started_at)`,
            ).bind(
              sceneRowId(runId, p.teamIndex, p.name), runId, meta.repo, meta.prNumber, sceneId,
              p.file, p.name, p.teamIndex, meta.headSha, ts,
            ),
          )
          break
        }
        case 'scene:end': {
          // scene:end names its scene (name + teamIndex), which is the row id.
          // An event missing either names no scene; skip it rather than guess.
          if (typeof p.name !== 'string' || typeof p.teamIndex !== 'number') break
          const verdict = p.status === 'failed' ? 'failed' : p.status === 'skipped' ? 'skipped' : 'passed'
          const summary =
            p.summary != null ? JSON.stringify(p.summary) : p.error != null ? JSON.stringify({ error: p.error }) : null
          stmts.push(
            this.env.DB.prepare(
              `UPDATE scene_executions SET status = ?1, ended_at = ?2, summary_json = COALESCE(?3, summary_json)
                 WHERE id = ?4`,
            ).bind(verdict, ts, summary, sceneRowId(runId, p.teamIndex, p.name)),
          )
          break
        }
        case 'run:end': {
          // The settled verdict, derived from the run's own summary. /complete
          // stays as the box's terminal-state backstop (a non-zero exit with no
          // run:end); both share the ended_at guard, so whichever lands first
          // wins and the other no-ops.
          const verdict = (p.summary?.failed ?? 0) > 0 ? 'failed' : 'passed'
          stmts.push(
            this.env.DB.prepare(
              'UPDATE runs SET status = ?1, ended_at = ?2 WHERE id = ?3 AND ended_at IS NULL',
            ).bind(verdict, ts, runId),
          )
          break
        }
      }
    }

    // One D1 round-trip per batch. The batch is transactional and ordered, so a
    // scene:start + scene:end arriving together settle in sequence.
    if (stmts.length === 1) await stmts[0]!.run()
    else if (stmts.length > 1) await this.env.DB.batch(stmts)
  }

  // The run's immutable identity for the scene_executions projection. Cached on
  // hit; a missing run row (events before the run is recorded — shouldn't
  // happen, createRun precedes dispatch) is left uncached so a later batch
  // retries.
  private async resolveRunMeta(runId: string): Promise<RunMeta | null> {
    const cached = this.runMeta.get(runId)
    if (cached) return cached
    const row = await this.env.DB.prepare(
      'SELECT repo, pr_number AS prNumber, head_sha AS headSha FROM runs WHERE id = ?1',
    )
      .bind(runId)
      .first<RunMeta>()
    if (row) this.runMeta.set(runId, row)
    return row
  }

  // Push a coarse run-status rollup up to the singleton home view object
  // (DO-to-DO), so the home tiles tick live. Only this rollup crosses up; the
  // raw events stayed with the PR's own viewers. Computed from the run/scene
  // state projectToD1 just wrote, so it's accurate without in-memory counters
  // (which a mid-run eviction would lose). Throttled for progress; boundaries
  // (run:start/run:end) always emit.
  private async emitRollup(runId: string, boundary: BoundaryPayload[], now: number): Promise<void> {
    if (!this.env.HOME_COORDINATOR) return
    const isBoundary = boundary.some((b) => b.type === 'run:start' || b.type === 'run:end')
    if (!isBoundary) {
      const last = this.lastRollupAt.get(runId) ?? 0
      if (now - last < ROLLUP_THROTTLE_MS) return
    }
    this.lastRollupAt.set(runId, now)

    const tile = await this.computeTile(runId, now)
    if (!tile) return
    if (tile.status === 'passed' || tile.status === 'failed' || tile.status === 'cancelled') {
      this.lastRollupAt.delete(runId) // run done; drop its throttle slot
    }
    try {
      await this.env.HOME_COORDINATOR.get(this.env.HOME_COORDINATOR.idFromName('global')).fetch(
        'https://home/rollup',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tile }) },
      )
    } catch (err) {
      console.error(`home rollup(${runId}) failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // The run's current home tile, derived from D1 (the projection writer ran
  // first this batch). pct = settled scenes / scene_count; a terminal run with
  // no scene_count still reads 100.
  private async computeTile(runId: string, now: number): Promise<HomeTile | null> {
    const row = await this.env.DB.prepare(
      `SELECT r.repo AS repo, r.pr_number AS prNumber, r.status AS status, r.scene_count AS sceneCount,
              (SELECT COUNT(*) FROM scene_executions se
                 WHERE se.run_id = r.id AND se.status IN ('passed','failed','skipped')) AS settled,
              (SELECT COUNT(*) FROM scene_executions se
                 WHERE se.run_id = r.id AND se.status = 'failed') AS failing
         FROM runs r WHERE r.id = ?1`,
    )
      .bind(runId)
      .first<{ repo: string; prNumber: number; status: string; sceneCount: number | null; settled: number; failing: number }>()
    if (!row) return null
    const terminal = row.status === 'passed' || row.status === 'failed' || row.status === 'cancelled'
    const pct =
      row.sceneCount && row.sceneCount > 0
        ? Math.min(100, Math.round((row.settled / row.sceneCount) * 100))
        : terminal ? 100 : 0
    return {
      repo: row.repo,
      prNumber: row.prNumber,
      runId,
      status: row.status,
      pct,
      failing: row.failing ?? 0,
      updatedAt: now,
    }
  }

  // Fan live events to PR viewers (every viewer of this object — one DO is one
  // PR). The frame carries the PR-global `id` (cursor + client collection key),
  // run_id (channel discriminator) and the per-run seq; payload is the stored
  // JSON string so live and replay frames are byte-identical.
  private fanoutPr(runId: string, events: StoredEvent[]): void {
    const sockets = this.state.getWebSockets('prv')
    if (sockets.length === 0) return
    for (const e of events) {
      const frame = JSON.stringify({ kind: 'event', id: e.id, runId, seq: e.seq, payload: e.payload })
      for (const ws of sockets) {
        try { ws.send(frame) } catch { /* socket closing; nothing to do */ }
      }
    }
  }

  // Fold this PR's archived runs back into the log under their original ids, so
  // the PR stream is the whole history even after a teardown reset. Restored id
  // (not reassigned) means restore order is irrelevant — ORDER BY id rebuilds
  // the same stream. D1 names the PR's runs (passed in; the DO stores no id).
  private async rehydrateArchived(repo: string, prNumber: number): Promise<void> {
    if (!this.env.ARTIFACTS) return
    const runs = await this.env.DB.prepare(
      `SELECT id AS run_id, artifact_key FROM runs
         WHERE repo = ?1 AND pr_number = ?2 AND artifact_key IS NOT NULL
         ORDER BY started_at ASC`,
    )
      .bind(repo, prNumber)
      .all<{ run_id: string; artifact_key: string }>()
    for (const run of runs.results ?? []) {
      // Already live or folded in: skip the R2 read (the insert would no-op).
      const present = this.sql.exec('SELECT 1 FROM log WHERE run_id = ? LIMIT 1', run.run_id).toArray()
      if (present.length > 0) continue
      for (const row of await readArtifactLog(this.env, run.artifact_key)) {
        if (row.id == null) continue // pre-id archive: can't be slotted in order
        this.sql.exec(
          'INSERT OR IGNORE INTO log (id, run_id, seq, payload, ts) VALUES (?, ?, ?, ?, ?)',
          row.id,
          run.run_id,
          row.seq,
          row.payload,
          row.ts ?? 0,
        )
      }
    }
  }

  // Replay the whole PR's log to a PR viewer, ordered by the PR-global `id` (the
  // resume cursor). The object is the PR, so every row qualifies. Pages to keep
  // a long PR out of memory. Archived/reset runs are folded back in by
  // rehydrateArchived before this runs, so they appear here in id order too.
  private async replayPrTo(ws: WebSocket, sinceId: number): Promise<void> {
    let after = sinceId
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT id, run_id, seq, payload FROM log WHERE id > ? ORDER BY id ASC LIMIT ?',
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ id: number; run_id: string; seq: number; payload: string }>
      for (const row of rows) {
        ws.send(JSON.stringify({ kind: 'event', id: row.id, runId: row.run_id, seq: row.seq, payload: row.payload }))
        after = row.id
      }
      if (rows.length < REPLAY_PAGE) break
    }
  }

  // Serialize a run's slice of the log for R2 — the WHOLE log row per line,
  // `{"id":N,"seq":M,"ts":T,"payload":<payload>}`, so the archive can recreate
  // the log exactly (rehydrateArchived reinserts under the original id). Pages
  // the local SQLite to keep a long run out of memory.
  private buildRunArchive(runId: string): string {
    const lines: string[] = []
    let after = 0
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT id, seq, ts, payload FROM log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          runId,
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ id: number; seq: number; ts: number; payload: string }>
      for (const row of rows) {
        // payload is already a JSON string; embed it raw so we never reparse.
        lines.push(`{"id":${row.id},"seq":${row.seq},"ts":${row.ts},"payload":${row.payload}}`)
        after = row.seq
      }
      if (rows.length < REPLAY_PAGE) break
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  // Build the run's log as the box-compatible .jsonl projection, one event per
  // line as `{"seq":N,"payload":<payload>}` — the /jsonl download view, the same
  // bytes the R2 archive projects to on download (readArtifactBoxJsonl), so the
  // download reads the same live or archived. Pages SQLite to keep a long run
  // out of memory.
  private buildRunJsonl(runId: string): string {
    const lines: string[] = []
    let after = 0
    for (;;) {
      const rows = this.sql
        .exec(
          'SELECT seq, payload FROM log WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          runId,
          after,
          REPLAY_PAGE,
        )
        .toArray() as Array<{ seq: number; payload: string }>
      for (const row of rows) {
        // row.payload is already a JSON string; embed it raw so we never reparse.
        lines.push(`{"seq":${row.seq},"payload":${row.payload}}`)
        after = row.seq
      }
      if (rows.length < REPLAY_PAGE) break
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  // Flush a run's log to its durable R2 artifact and record the key on the D1
  // `runs` row. Idempotent: a run that already has a key is left alone. No-op
  // without the ARTIFACTS binding. Repo (for the object key) is resolved from
  // D1, the same place the run's metadata projection already lives.
  private async archiveRun(runId: string): Promise<string | null> {
    if (!this.env.ARTIFACTS) return null
    const run = await this.env.DB.prepare('SELECT repo, artifact_key FROM runs WHERE id = ?1')
      .bind(runId)
      .first<{ repo: string; artifact_key: string | null }>()
    if (!run) return null
    if (run.artifact_key) return run.artifact_key

    const key = artifactKey(run.repo, runId)
    await this.env.ARTIFACTS.put(key, this.buildRunArchive(runId), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    })
    await this.env.DB.prepare('UPDATE runs SET artifact_key = ?1 WHERE id = ?2').bind(key, runId).run()
    return key
  }

  private boxSocket(): WebSocket | null {
    return this.state.getWebSockets('box')[0] ?? null
  }

  private async sendOrQueue(message: object): Promise<boolean> {
    // Dispatching a command/run/update is activity too.
    await this.resetIdleAlarm()
    const box = this.boxSocket()
    if (box) {
      box.send(JSON.stringify(message))
      return true
    }
    // Keyed by time + entropy so flush order is FIFO-ish and keys never clash.
    await this.state.storage.put(
      `${QUEUE_PREFIX}${Date.now().toString().padStart(15, '0')}:${crypto.randomUUID().slice(0, 8)}`,
      message,
    )
    return false
  }

  private async flushQueue(ws: WebSocket): Promise<void> {
    const queued = await this.state.storage.list({ prefix: QUEUE_PREFIX })
    for (const [key, message] of queued) {
      ws.send(JSON.stringify(message))
      await this.state.storage.delete(key)
    }
  }

  private async clearQueue(): Promise<void> {
    const queued = await this.state.storage.list({ prefix: QUEUE_PREFIX })
    await this.state.storage.delete([...queued.keys()])
  }
}

// The DO's name is the PR identity — one coordinator per PR, found by name
// from anywhere in the worker without a lookup table.
export function prCoordinator(env: Env, repo: string, prNumber: number): DurableObjectStub {
  return env.PR_COORDINATOR.get(env.PR_COORDINATOR.idFromName(`${repo}#${prNumber}`))
}
