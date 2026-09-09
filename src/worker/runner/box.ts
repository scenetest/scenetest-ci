import type { Env } from '../env.ts'
import type { BoxSpec } from './types.ts'
import { hashToken } from '../middleware/bearer.ts'
import { getRunner } from './registry.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { computeStagePlan, firstDivergentStage, type StagePlan } from './pipeline.ts'
import { previewTimeoutMs, startPreview } from '../preview/reconcile.ts'

export interface PrRef {
  repo: string // 'owner/name'
  prNumber: number
  headSha: string
  baseSha: string | null
  baseRef: string
  // The PR's own branch name. Supabase matches a preview branch to a git
  // branch by name, so a preview environment can't be found without it.
  headRef?: string
}

export interface BoxRow {
  id: string
  head_sha: string
  status: string
}

// Ensure a usable box exists for this PR at pr.headSha.
//
// DigitalOcean path: the pipeline stage diff (docs/pipeline.md). The desired
// stage vector for the new commit is compared against what the live box has
// realized; no divergence = full reuse (a docs-only push does nothing), a
// divergence at stage k = the warm box re-runs stages k..end at the new sha,
// and only a missing/failed box provisions fresh hardware.
//
// Stub path: the original sha-equality model (fake boxes do no real work, so
// staged updates have nothing to optimize).
export async function ensureBox(
  env: Env,
  ctx: ExecutionContext,
  pr: PrRef,
): Promise<BoxRow> {
  const live = await env.DB.prepare(
    `SELECT id, head_sha, status, realized_stages FROM boxes
       WHERE repo = ?1 AND pr_number = ?2 AND status != 'destroyed'`,
  )
    .bind(pr.repo, pr.prNumber)
    .first<BoxRow & { realized_stages: string | null }>()

  if (env.RUNNER_PROVIDER !== 'digitalocean') {
    if (live && live.head_sha === pr.headSha) {
      await env.DB.prepare('UPDATE boxes SET last_used_at = ?1 WHERE id = ?2')
        .bind(Date.now(), live.id)
        .run()
      return live
    }
    if (live) await retireBox(env, live.id)
    return provisionBox(env, ctx, pr)
  }

  const plan = await computeStagePlan(env, pr.repo, pr.headSha)
  await openPreview(env, pr, plan)

  if (live) {
    const realized = live.realized_stages
      ? (JSON.parse(live.realized_stages) as Record<string, string>)
      : null
    const divergeAt = firstDivergentStage(plan, realized)

    if (divergeAt === null) {
      // Nothing the pipeline watches changed (rebases, docs-only pushes).
      // The box's checkout may lag the literal head sha, but its content is
      // identical in every watched respect — record the new sha and reuse.
      await env.DB.prepare('UPDATE boxes SET last_used_at = ?1, head_sha = ?2 WHERE id = ?3')
        .bind(Date.now(), pr.headSha, live.id)
        .run()
      return { ...live, head_sha: pr.headSha }
    }

    // Latest wins: verdicts in flight are for a state that no longer
    // matters. Cancel them, then have the warm box re-run from the first
    // divergent stage — the box survives; only the work repeats.
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE runs SET status = 'cancelled', ended_at = ?1
           WHERE box_id = ?2 AND ended_at IS NULL`,
      ).bind(now, live.id),
      env.DB.prepare(
        `UPDATE boxes SET status = 'rebuilding', head_sha = ?1, last_used_at = ?2 WHERE id = ?3`,
      ).bind(pr.headSha, now, live.id),
    ])
    await queueUpdate(env, pr, plan, divergeAt)
    return { id: live.id, head_sha: pr.headSha, status: 'rebuilding' }
  }

  const box = await provisionBox(env, ctx, pr)
  // The fresh box runs every stage; the update waits in the coordinator's
  // FIFO queue ahead of any dispatches, delivered when the agent connects.
  await queueUpdate(env, pr, plan, 0)
  return box
}

// Open this PR's hosted preview environment, if its pipeline file declares
// one, and tell the PR object to hold the PR's dispatches until it is ready.
// A no-op for a repo with no `preview` block, which is every repo that serves
// its app from the box. The stub runner never gets here: it computes no stage
// plan, so it reads no pipeline file (dev and e2e open a preview through
// /api/debug/preview-start instead).
async function openPreview(env: Env, pr: PrRef, plan: StagePlan | null): Promise<void> {
  const gated = await startPreview(env, {
    repo: pr.repo,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    gitBranch: pr.headRef ?? '',
  }, plan?.preview ?? null)
  if (!gated) return
  await prCoordinator(env, pr.repo, pr.prNumber).fetch('https://do/preview-start', {
    method: 'POST',
    body: JSON.stringify({
      repo: pr.repo,
      prNumber: pr.prNumber,
      deadline: Date.now() + previewTimeoutMs(env),
    }),
  })
}

async function queueUpdate(env: Env, pr: PrRef, plan: StagePlan, fromStage: number): Promise<void> {
  await prCoordinator(env, pr.repo, pr.prNumber).fetch('https://do/update', {
    method: 'POST',
    body: JSON.stringify({
      headSha: pr.headSha,
      vector: plan.vector,
      stages: plan.stages.slice(fromStage),
      scenes: plan.scenes,
    }),
  })
}

async function provisionBox(env: Env, ctx: ExecutionContext, pr: PrRef): Promise<BoxRow> {
  const boxId = crypto.randomUUID()
  const bearerToken = crypto.randomUUID()
  const now = Date.now()
  const provider = env.RUNNER_PROVIDER ?? 'stub'
  // A stub box is usable immediately; a real box reports ready once its build
  // pipeline finishes on the droplet.
  const status = provider === 'digitalocean' ? 'provisioning' : 'ready'

  await env.DB.prepare(
    `INSERT INTO boxes
       (id, repo, pr_number, head_sha, status, bearer_token_hash, created_at, last_used_at, ready_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
  )
    .bind(
      boxId,
      pr.repo,
      pr.prNumber,
      pr.headSha,
      status,
      await hashToken(bearerToken),
      now,
      status === 'ready' ? now : null,
    )
    .run()

  const spec: BoxSpec = {
    boxId,
    repo: pr.repo,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRef: pr.baseRef,
    imageVersion: env.RUNNER_IMAGE ?? 'stub',
  }
  const { runnerId } = await getRunner(env).provision(env, ctx, spec, bearerToken)

  // null = provisioning is pending (e.g. the runner image is still
  // building); the box row stays instance-less and the cron tick completes
  // it with a freshly minted token once the blocker clears.
  if (runnerId !== null) {
    await env.DB.prepare('UPDATE boxes SET runner_instance_id = ?1 WHERE id = ?2')
      .bind(runnerId, boxId)
      .run()
  }

  return { id: boxId, head_sha: pr.headSha, status }
}

// Mark the box for teardown and cancel its unfinished runs — latest wins:
// when a new commit retires the box, the only state worth a verdict is the
// new one, so in-flight batches for the old one stop counting immediately.
// The PR coordinator closes the box's WebSocket and drops its queued work;
// the reaper destroys the backing droplet on its next pass (boxes with
// status 'destroyed' are swept regardless of age) and repeats the run
// cancellation as an idempotent safety net.
export async function retireBox(env: Env, boxId: string): Promise<void> {
  const box = await env.DB.prepare('SELECT repo, pr_number FROM boxes WHERE id = ?1')
    .bind(boxId)
    .first<{ repo: string; pr_number: number }>()

  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE boxes SET status = 'destroyed', destroyed_at = ?1 WHERE id = ?2`,
    ).bind(now, boxId),
    env.DB.prepare(
      `UPDATE runs SET status = 'cancelled', ended_at = ?1
         WHERE box_id = ?2 AND ended_at IS NULL`,
    ).bind(now, boxId),
  ])

  if (box) {
    await prCoordinator(env, box.repo, box.pr_number).fetch('https://do/retire', {
      method: 'POST',
      body: JSON.stringify({ boxId }),
    })
  }
}
