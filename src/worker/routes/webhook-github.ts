import type { Handler } from '../router.ts'
import type { Env } from '../env.ts'
import { verifyWebhookSignature } from '../github.ts'
import { createRun } from '../runner/create-run.ts'
import { retireBox } from '../runner/box.ts'
import { cleanupPreview } from '../preview/reconcile.ts'

// POST /webhook/github
//
// Trigger pipeline: pull_request opened/synchronize/reopened on a watched
// repo → upsert prs → create a run for the new head sha (consuming the PR's
// next_push_filter as the scene subset, if set). 'closed' just updates PR
// state. Everything else is recorded and ignored.
//
// Responses are 200 for anything we chose to ignore — non-2xx makes GitHub
// surface the hook as failing and retry, which is only right when *we* are
// at fault (bad signature, missing config, thrown error).

interface PullRequestPayload {
  action: string
  number: number
  repository: { full_name: string }
  pull_request: {
    state: string
    title?: string
    head: { sha: string; ref?: string }
    base: { ref: string; sha: string }
  }
}

export const postGithubWebhook: Handler = async (req, env, ctx) => {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response('Webhook secret not configured', { status: 503 })
  }

  const rawBody = await req.text()
  const sigOk = await verifyWebhookSignature(
    env.GITHUB_WEBHOOK_SECRET,
    rawBody,
    req.headers.get('x-hub-signature-256'),
  )
  if (!sigOk) return new Response('Bad signature', { status: 401 })

  const deliveryId = req.headers.get('x-github-delivery') ?? crypto.randomUUID()
  const event = req.headers.get('x-github-event') ?? 'unknown'

  // Idempotency: GitHub redelivers (manually and on perceived failure).
  // First write wins; a duplicate delivery is acknowledged and dropped.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, received_at)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(deliveryId, event, Date.now())
    .run()
  if (inserted.meta.changes === 0) {
    return Response.json({ ok: true, result: 'duplicate' })
  }

  const result = await handleEvent(env, ctx, event, rawBody)

  await env.DB.prepare(
    `UPDATE webhook_deliveries SET action = ?1, repo = ?2, pr_number = ?3, result = ?4
     WHERE delivery_id = ?5`,
  )
    .bind(result.action ?? null, result.repo ?? null, result.prNumber ?? null, result.result, deliveryId)
    .run()

  return Response.json({ ok: true, result: result.result })
}

interface HandleResult {
  result: string
  action?: string
  repo?: string
  prNumber?: number
}

// What an inbound event means, independent of any I/O. The route shell does
// signature checking, dedup, the watched-repo lookup, and the DB writes; this
// just decides which of those writes to make. Kept pure so every branch is
// unit-testable without a database.
export type WebhookDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'pr-closed' }
  | { kind: 'create-run' }

export function classifyWebhook(
  event: string,
  action: string | undefined,
  isWatched: boolean,
): WebhookDecision {
  if (event === 'ping') return { kind: 'ignore', reason: 'ping' }
  if (event !== 'pull_request') return { kind: 'ignore', reason: `event:${event}` }
  if (!isWatched) return { kind: 'ignore', reason: 'unwatched-repo' }
  if (action === 'closed') return { kind: 'pr-closed' }
  if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
    return { kind: 'create-run' }
  }
  return { kind: 'ignore', reason: `action:${action}` }
}

async function handleEvent(
  env: Env,
  ctx: ExecutionContext,
  event: string,
  rawBody: string,
): Promise<HandleResult> {
  // Cheap event-type gate before parsing or touching the DB. (isWatched is
  // irrelevant here — classifyWebhook short-circuits on event type first.)
  // Pings still record which repo they came from: GitHub fires one when a
  // webhook is created, so a ping delivery row with the repo name is the
  // "wiring verified" signal project onboarding (and its UI) checks for.
  if (event !== 'pull_request') {
    const d = classifyWebhook(event, undefined, false) as { kind: 'ignore'; reason: string }
    let repo: string | undefined
    try {
      repo = (JSON.parse(rawBody) as { repository?: { full_name?: string } }).repository?.full_name
    } catch {
      // non-JSON body; nothing to attribute
    }
    return { result: `ignored:${d.reason}`, ...(repo ? { repo } : {}) }
  }

  const payload = JSON.parse(rawBody) as PullRequestPayload
  const { action, number: prNumber } = payload
  const repo = payload.repository.full_name
  const base = { result: '', action, repo, prNumber }

  const [owner, name] = repo.split('/')
  // Case-insensitive: GitHub treats owner/repo names case-insensitively, and
  // a row may have been registered with non-canonical casing (e.g. when the
  // add-repo GitHub lookup was rate-limited and couldn't canonicalize it).
  const watched = await env.DB.prepare(
    'SELECT 1 FROM watched_repo WHERE owner = ?1 COLLATE NOCASE AND name = ?2 COLLATE NOCASE',
  )
    .bind(owner ?? '', name ?? '')
    .first()

  const decision = classifyWebhook(event, action, watched !== null)
  if (decision.kind === 'ignore') {
    return { ...base, result: `ignored:${decision.reason}` }
  }

  const now = Date.now()

  if (decision.kind === 'pr-closed') {
    await env.DB.prepare(
      `UPDATE prs SET state = 'closed', updated_at = ?1 WHERE repo = ?2 AND pr_number = ?3`,
    )
      .bind(now, repo, prNumber)
      .run()
    // Tear the box down now: a closed or merged PR gets no more pushes, so
    // holding its droplet only bills until the age-cap reaper would have
    // caught it (up to RUNNER_MAX_AGE_MINUTES later). retireBox cancels the
    // PR's unfinished runs, tells the coordinator to drop its queue and close
    // sockets, and marks the box for the reaper to destroy on its next pass.
    // The box may already be gone (a prior retire, or never provisioned), so
    // this is a no-op when there's no live box.
    const box = await env.DB.prepare(
      `SELECT id FROM boxes WHERE repo = ?1 AND pr_number = ?2 AND status != 'destroyed'`,
    )
      .bind(repo, prNumber)
      .first<{ id: string }>()
    if (box) await retireBox(env, box.id)
    // The PR's Supabase preview branch is billable and no longer has a PR to
    // serve. Deleting it is best-effort and off the response path; the row
    // goes either way, so a later push re-creates the branch from scratch.
    ctx.waitUntil(
      cleanupPreview(env, repo, prNumber).catch((err) =>
        console.error(`preview cleanup(${repo}#${prNumber}) failed: ${err instanceof Error ? err.message : err}`),
      ),
    )
    pokeHome(env, ctx, repo, prNumber) // PR left the open set → tile disappears live
    return { ...base, result: box ? 'pr-closed:retired' : 'pr-closed' }
  }

  const headSha = payload.pull_request.head.sha
  // Nullable: a payload without it (a hand-rolled delivery, a fixture) still
  // opens a PR, it just can't be matched to a Supabase preview branch.
  const headRef = payload.pull_request.head.ref ?? null
  const baseRef = payload.pull_request.base.ref
  const baseSha = payload.pull_request.base.sha
  const title = payload.pull_request.title ?? null

  await env.DB.prepare(
    `INSERT INTO prs (repo, pr_number, head_sha, head_ref, base_ref, state, title, opened_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?7)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       head_sha = excluded.head_sha, head_ref = excluded.head_ref,
       base_ref = excluded.base_ref,
       title = excluded.title, state = 'open', updated_at = ?7`,
  )
    .bind(repo, prNumber, headSha, headRef, baseRef, title, now)
    .run()

  // A queued filter ("on the next push, only re-run these scenes") is
  // consumed by exactly one run, then cleared.
  const prRow = await env.DB.prepare(
    'SELECT next_push_filter FROM prs WHERE repo = ?1 AND pr_number = ?2',
  )
    .bind(repo, prNumber)
    .first<{ next_push_filter: string | null }>()
  const filter = prRow?.next_push_filter
  const subset = filter ? (JSON.parse(filter) as string[]) : null
  if (filter) {
    await env.DB.prepare(
      'UPDATE prs SET next_push_filter = NULL WHERE repo = ?1 AND pr_number = ?2',
    )
      .bind(repo, prNumber)
      .run()
  }

  const { runId } = await createRun(env, ctx, {
    repo,
    prNumber,
    headSha,
    baseSha,
    baseRef,
    ...(headRef ? { headRef } : {}),
    trigger: subset ? 'auto-filter' : 'push',
    subset,
  })
  pokeHome(env, ctx, repo, prNumber) // new/updated open PR → tile appears/refreshes live
  return { ...base, result: `run-created:${runId}` }
}

// Tell the singleton home view object that a PR's list state changed
// (opened/closed/merged) so its tiles tick live. Best-effort and off the
// webhook response path; the home object re-reads the PR from D1.
function pokeHome(env: Env, ctx: ExecutionContext, repo: string, prNumber: number): void {
  ctx.waitUntil(
    env.HOME_COORDINATOR.get(env.HOME_COORDINATOR.idFromName('global'))
      .fetch('https://home/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo, prNumber }),
      })
      .then(() => undefined)
      .catch((err) =>
        console.error(`home refresh(${repo}#${prNumber}) failed: ${err instanceof Error ? err.message : err}`),
      ),
  )
}
