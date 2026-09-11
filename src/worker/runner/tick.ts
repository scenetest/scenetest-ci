import type { Env } from '../env.ts'
import type { BoxSpec } from './types.ts'
import { hashToken } from '../middleware/bearer.ts'
import { advanceImageBuilds, ensureImage } from './image.ts'
import { provisionDroplet, reapRunners } from './digitalocean.ts'
import { prCoordinator } from '../do/pr-coordinator.ts'
import { previewProvider } from '../preview/reconcile.ts'
import { previewCoordinator } from '../do/preview-coordinator.ts'

// The scheduled heartbeat (wrangler.toml [triggers]): walk every async chain
// forward one step. Order matters — builds first (they may unblock boxes),
// then pending boxes, then the reaper.
export async function tick(env: Env): Promise<void> {
  // Archive backstop, provider-independent (the stub ends runs just like a real
  // box): each PR object flushes a run's log to R2 at end of run, but an object
  // evicted before it ran — or a cancellation that skipped the flush — leaves a
  // terminal run with no artifact_key. Poke its object to archive. Nothing is
  // pruned here: the log lives in the object's SQLite, never in D1.
  await archiveTerminalRuns(env).catch((err) => {
    console.error(`tick: archive backstop failed: ${err instanceof Error ? err.message : err}`)
  })
  // Preview environments are provider-independent: a PR waiting on one is
  // waiting whatever its box runs on.
  await advanceStalePreviews(env).catch((err) => {
    console.error(`tick: preview backstop failed: ${err instanceof Error ? err.message : err}`)
  })
  if (env.RUNNER_PROVIDER !== 'digitalocean' || !env.DO_API_TOKEN) return
  await advanceImageBuilds(env)
  await provisionPendingBoxes(env)
  await reapRunners(env)
}

// Terminal runs still missing their R2 artifact: ask each run's PR object to
// flush its log. No-op without the ARTIFACTS binding (archiveRun returns null).
async function archiveTerminalRuns(env: Env): Promise<void> {
  if (!env.ARTIFACTS) return
  const pending = await env.DB.prepare(
    `SELECT id, repo, pr_number FROM runs
       WHERE artifact_key IS NULL AND status IN ('passed', 'failed', 'cancelled')
       LIMIT 100`,
  ).all<{ id: string; repo: string; pr_number: number }>()
  for (const row of pending.results ?? []) {
    try {
      await prCoordinator(env, row.repo, row.pr_number).fetch('https://do/archive', {
        method: 'POST',
        body: JSON.stringify({ runId: row.id }),
      })
    } catch (err) {
      console.error(`tick: archiving ${row.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// A preview environment's poll schedule belongs to its own object's alarm.
// This is the backstop for an object that lost the alarm (a crash between the
// storage write and the alarm write, an eviction mid-step): anything still
// building and untouched for well past a poll interval gets one poke.
const PREVIEW_STALE_MS = 5 * 60_000

async function advanceStalePreviews(env: Env): Promise<void> {
  if (!previewProvider(env)) return
  const stale = await env.DB.prepare(
    `SELECT repo, pr_number FROM preview_envs
       WHERE status = 'building' AND updated_at < ?1 LIMIT 50`,
  )
    .bind(Date.now() - PREVIEW_STALE_MS)
    .all<{ repo: string; pr_number: number }>()
  for (const row of stale.results ?? []) {
    try {
      await previewCoordinator(env, row.repo, row.pr_number).fetch('https://do/step', {
        method: 'POST',
      })
    } catch (err) {
      console.error(`tick: preview step ${row.repo}#${row.pr_number} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// Boxes whose provision() went pending (image was still building): give each
// a droplet now that the image is ready. The original bearer token's
// plaintext is gone (only its hash is stored), so a fresh token is minted
// and the hash replaced — sound because no machine ever held the old one.
async function provisionPendingBoxes(env: Env): Promise<void> {
  const image = await ensureImage(env).catch((err) => {
    console.error(`tick: ${err instanceof Error ? err.message : err}`)
    return null
  })
  if (!image || !('ready' in image)) return

  const rows = await env.DB.prepare(
    `SELECT b.id, b.repo, b.pr_number, b.head_sha, p.base_ref,
            (SELECT r.base_sha FROM runs r WHERE r.box_id = b.id ORDER BY rowid DESC LIMIT 1) AS base_sha
       FROM boxes b JOIN prs p ON p.repo = b.repo AND p.pr_number = b.pr_number
     WHERE b.status = 'provisioning' AND b.runner_instance_id IS NULL`,
  ).all<{ id: string; repo: string; pr_number: number; head_sha: string; base_ref: string; base_sha: string | null }>()

  for (const row of rows.results ?? []) {
    const bearerToken = crypto.randomUUID()
    await env.DB.prepare('UPDATE boxes SET bearer_token_hash = ?1 WHERE id = ?2')
      .bind(await hashToken(bearerToken), row.id)
      .run()

    const spec: BoxSpec = {
      boxId: row.id,
      repo: row.repo,
      prNumber: row.pr_number,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      baseRef: row.base_ref,
      imageVersion: image.ready,
    }
    try {
      const runnerId = await provisionDroplet(env, spec, bearerToken, image.ready)
      await env.DB.prepare('UPDATE boxes SET runner_instance_id = ?1 WHERE id = ?2')
        .bind(runnerId, row.id)
        .run()
      console.log(`tick: provisioned pending box ${row.id} (droplet ${runnerId})`)
    } catch (err) {
      console.error(`tick: provisioning box ${row.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}
