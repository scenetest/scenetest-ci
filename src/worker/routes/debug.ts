import type { Handler } from '../router.ts'
import { createRun } from '../runner/create-run.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { getPreview, previewTimeoutMs, startPreview } from '../preview/reconcile.ts'
import type { PreviewConfig } from '../preview/config.ts'

// Every handler here is registered through devOnly() in index.ts, so none of
// them exists unless ENABLE_DEBUG_ROUTES is on.

// POST /api/debug/box-update
// Body: { boxId, headSha?, vector?, stages? } — enqueue a pipeline update on
// the box's coordinator, exactly as ensureBox would. Exists so the e2e
// script can exercise the agent's update path (checkout → stages → ready
// with realized vector) without a real GitHub tree.
export const debugBoxUpdate: Handler = async (req, env) => {
  const body = await req.json<{
    boxId: string
    headSha?: string
    vector?: Record<string, string>
    stages?: Array<{ name: string; run?: string }>
    scenes?: string
  }>()
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(body.boxId)
    .first<{ repo: string; pr_number: number }>()
  if (!box) return Response.json({ error: 'box not found' }, { status: 404 })

  const res = await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/update', {
    method: 'POST',
    body: JSON.stringify({
      headSha: body.headSha,
      vector: body.vector,
      stages: body.stages ?? [],
      scenes: body.scenes,
    }),
  })
  return Response.json(await res.json(), { status: 202 })
}

// POST /api/debug/box-dispatch
// Body: { boxId, run: RunSpec-ish } — enqueue a scene batch on the box's
// coordinator, as createRun's dispatch would, so e2e can exercise the
// agent's batch path (scenes command, events-file relay, verdict).
export const debugBoxDispatch: Handler = async (req, env) => {
  const body = await req.json<{ boxId: string; run: unknown }>()
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(body.boxId)
    .first<{ repo: string; pr_number: number }>()
  if (!box) return Response.json({ error: 'box not found' }, { status: 404 })

  const res = await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/dispatch', {
    method: 'POST',
    body: JSON.stringify({ run: body.run }),
  })
  return Response.json(await res.json(), { status: 202 })
}

// POST /api/debug/reset-pr-log
// Body: { repo, prNumber } — drop a PR object's live log rows, modelling PR
// teardown so the e2e can prove an archived run re-folds back into the PR
// stream from R2.
export const debugResetPrLog: Handler = async (req, env) => {
  const { repo, prNumber } = await req.json<{ repo: string; prNumber: number }>()
  if (!repo || !Number.isFinite(prNumber)) {
    return Response.json({ error: 'repo and prNumber required' }, { status: 400 })
  }
  const res = await prCoordinator(env, repo, prNumber).fetch('https://do/reset', { method: 'POST' })
  return Response.json(await res.json(), { status: 200 })
}

// POST /api/debug/idle-check
// Body: { repo, prNumber } — run a PR coordinator's idle-alarm logic now,
// instead of waiting out the real RUNNER_IDLE_TIMEOUT_MINUTES window, so the
// e2e can prove the box is retired on idle (and kept while a run is in flight).
export const debugIdleCheck: Handler = async (req, env) => {
  const { repo, prNumber } = await req.json<{ repo: string; prNumber: number }>()
  if (!repo || !Number.isFinite(prNumber)) {
    return Response.json({ error: 'repo and prNumber required' }, { status: 400 })
  }
  const res = await prCoordinator(env, repo, prNumber).fetch('https://do/idle-check', { method: 'POST' })
  return Response.json(await res.json(), { status: 200 })
}

// POST /api/debug/stub-run
// Body: { repo?: string, prNumber?: number, title?: string, subset?: string[] }
// Upserts a fake PR and creates a run through the normal path (ensure box →
// insert run → dispatch); with the stub provider this fabricates events
// straight to D1. A wide-open execution path that must stay off anywhere with
// real users or runners — hence devOnly() at the route table.
export const debugStubRun: Handler = async (req, env, ctx) => {
  interface StubRunBody {
    repo?: string
    prNumber?: number
    title?: string
    subset?: string[]
    headRef?: string
  }
  const body = await req.json<StubRunBody>().catch(() => ({} as StubRunBody))
  const repo = body.repo ?? 'demo/repo'
  const prNumber = body.prNumber ?? 1
  const headSha = `sha-${Math.random().toString(36).slice(2, 10)}`
  const headRef = body.headRef ?? `pr-${prNumber}`
  const now = Date.now()

  await env.DB.prepare(
    `INSERT INTO prs (repo, pr_number, head_sha, head_ref, base_ref, state, title, opened_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'main', 'open', ?5, ?6, ?6)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       head_sha = excluded.head_sha,
       head_ref = excluded.head_ref,
       title = COALESCE(excluded.title, prs.title),
       updated_at = ?6`,
  )
    .bind(repo, prNumber, headSha, headRef, body.title ?? null, now)
    .run()

  const { runId } = await createRun(env, ctx, {
    repo,
    prNumber,
    headSha,
    baseSha: null,
    baseRef: 'main',
    headRef,
    trigger: 'manual',
    subset: body.subset ?? null,
  })

  return Response.json({ runId, headSha, prUrl: `/repo/${repo}/pr/${prNumber}` })
}

// GET /api/debug/preview?repo=owner/name&prNumber=1
// The PR's preview environment as both halves see it: the D1 row the
// reconciler writes, and the gate the PR object holds dispatches on.
export const debugPreview: Handler = async (req, env) => {
  const url = new URL(req.url)
  const repo = url.searchParams.get('repo') ?? ''
  const prNumber = Number(url.searchParams.get('prNumber') ?? NaN)
  if (!repo || !Number.isFinite(prNumber)) {
    return Response.json({ error: 'repo and prNumber required' }, { status: 400 })
  }
  const resp = await prCoordinator(env, repo, prNumber).fetch('https://do/preview')
  return Response.json({ row: await getPreview(env, repo, prNumber), gate: await resp.json() })
}

// POST /api/debug/preview-step
// Body: { repo, prNumber } — run one reconcile step now instead of waiting
// for the PR object's alarm, so the e2e can drive a preview to ready.
export const debugPreviewStep: Handler = async (req, env) => {
  const { repo, prNumber } = await req.json<{ repo: string; prNumber: number }>()
  const resp = await prCoordinator(env, repo, prNumber).fetch('https://do/preview-step', {
    method: 'POST',
  })
  return Response.json(await resp.json())
}

// The preview environment dev and the e2e open by hand. It names a project
// and a Worker that do not exist, which is why it only ever runs under
// PREVIEW_PROVIDER=stub.
const STUB_PREVIEW: PreviewConfig = {
  supabase: { projectRef: 'stubstubstubstubstub', withData: false },
  cloudflare: { worker: 'stub-preview-pr-{pr}', secrets: {} },
  sceneEnv: { SCENETEST_PREVIEW_URL: 'preview_url', SCENETEST_SUPABASE_URL: 'url' },
}

// POST /api/debug/preview-start
// Body: { repo, prNumber, headSha?, gitBranch?, config? } — open a preview
// environment for a PR without a pipeline file declaring one, so the gate can
// be driven end to end against the stub provider.
export const debugPreviewStart: Handler = async (req, env) => {
  const body = await req.json<{
    repo: string
    prNumber: number
    headSha?: string
    gitBranch?: string
    config?: PreviewConfig
  }>()
  const started = await startPreview(
    env,
    {
      repo: body.repo,
      prNumber: body.prNumber,
      headSha: body.headSha ?? 'debug',
      gitBranch: body.gitBranch ?? `pr-${body.prNumber}`,
    },
    body.config ?? STUB_PREVIEW,
  )
  if (!started) return Response.json({ error: 'preview not started' }, { status: 400 })

  const resp = await prCoordinator(env, body.repo, body.prNumber).fetch('https://do/preview-start', {
    method: 'POST',
    body: JSON.stringify({
      repo: body.repo,
      prNumber: body.prNumber,
      deadline: Date.now() + previewTimeoutMs(env),
    }),
  })
  return Response.json(await resp.json(), { status: 202 })
}
