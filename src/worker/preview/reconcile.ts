import type { Env } from '../env.ts'
import { renderWorkerName, type PreviewConfig, type PreviewValues } from './config.ts'
import * as cf from './cloudflare.ts'
import * as sb from './supabase.ts'
import { postCommitStatus } from '../github.ts'

// One PR, one hosted preview environment: a Supabase preview branch, and the
// project's Cloudflare preview Worker pointed at it. This module is the whole
// state machine, and `stepPreview` is one step of it — it never waits, so a
// caller drives it from an alarm and asks again later
// (docs/preview-environments.md).
//
// What it waits for is the branch's *keys*, not its schema. Keys exist as
// soon as the branch project does and do not change when migrations run, so
// holding the Worker's secrets back until the migrations pass would delay the
// handover for nothing.
//
// The reconciler owns no schedule. The preview coordinator polls it.

export type PreviewStatus = 'building' | 'ready' | 'failed'

export interface PreviewState {
  status: PreviewStatus
  branchRef: string | null
  workerName: string | null
  error: string | null
}

export interface PreviewRef {
  repo: string
  prNumber: number
  headSha: string
  gitBranch: string
}

const DEFAULT_TIMEOUT_MINUTES = 20
const DEFAULT_POLL_SECONDS = 20

// 'stub' resolves a declared environment without calling Supabase or
// Cloudflare: ready after one poll. It is how dev and the e2e drive the
// machine end to end.
export function previewProvider(env: Env): 'supabase-cloudflare' | 'stub' | null {
  const p = env.PREVIEW_PROVIDER
  return p === 'supabase-cloudflare' || p === 'stub' ? p : null
}

export function previewTimeoutMs(env: Env): number {
  const minutes = Number(env.PREVIEW_TIMEOUT_MINUTES ?? DEFAULT_TIMEOUT_MINUTES)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES) * 60_000
}

export function previewPollMs(env: Env): number {
  const seconds = Number(env.PREVIEW_POLL_SECONDS ?? DEFAULT_POLL_SECONDS)
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_POLL_SECONDS) * 1000
}

interface PreviewRow {
  repo: string
  pr_number: number
  git_branch: string
  head_sha: string
  config_json: string
  status: PreviewStatus
  branch_id: string | null
  branch_ref: string | null
  worker_name: string | null
  preview_url: string | null
  last_error: string | null
  attempts: number
  deadline: number
}

async function loadRow(env: Env, repo: string, prNumber: number): Promise<PreviewRow | null> {
  return env.DB.prepare('SELECT * FROM preview_envs WHERE repo = ?1 AND pr_number = ?2')
    .bind(repo, prNumber)
    .first<PreviewRow>()
}

function rowState(row: PreviewRow): PreviewState {
  return {
    status: row.status,
    branchRef: row.branch_ref,
    workerName: row.worker_name,
    error: row.last_error,
  }
}

// Open (or re-open) this PR's preview environment for a new head sha, and say
// whether there is one to poll. A push re-opens an environment that was
// already ready: the branch re-runs its migrations and the project redeploys
// its Worker, and a redeployed Worker is a Worker whose secrets are worth
// writing again.
export async function startPreview(
  env: Env,
  ref: PreviewRef,
  config: PreviewConfig | null,
): Promise<boolean> {
  if (!config) return false
  if (!ref.gitBranch) {
    console.warn(`preview: ${ref.repo}#${ref.prNumber} has no head ref recorded; skipping`)
    return false
  }

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO preview_envs
       (repo, pr_number, git_branch, config_json, head_sha, status, attempts,
        started_at, deadline, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'building', 0, ?6, ?7, ?6)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       git_branch = excluded.git_branch,
       config_json = excluded.config_json,
       head_sha = excluded.head_sha,
       status = 'building',
       attempts = 0,
       last_error = NULL,
       ready_at = NULL,
       deadline = excluded.deadline,
       updated_at = excluded.updated_at`,
  )
    .bind(ref.repo, ref.prNumber, ref.gitBranch, JSON.stringify(config), ref.headSha, now, now + previewTimeoutMs(env))
    .run()
  return true
}

// Nothing waits on a preview environment, so its outcome has to say so
// somewhere a person looks. It gets its own commit-status context: a preview
// that failed is a fact about the environment, never a verdict on the code,
// and the two must not overwrite each other.
const STATUS_CONTEXT = 'scenetest/preview'

async function report(env: Env, row: PreviewRow, status: string, description: string): Promise<void> {
  await postCommitStatus(env, {
    repo: row.repo,
    sha: row.head_sha,
    status,
    description,
    context: STATUS_CONTEXT,
  }).catch((err) =>
    console.error(`preview status(${row.repo}#${row.pr_number}) failed: ${err instanceof Error ? err.message : err}`),
  )
}

async function fail(env: Env, row: PreviewRow, error: string): Promise<PreviewState> {
  await env.DB.prepare(
    `UPDATE preview_envs SET status = 'failed', last_error = ?1, updated_at = ?2
       WHERE repo = ?3 AND pr_number = ?4`,
  )
    .bind(error, Date.now(), row.repo, row.pr_number)
    .run()
  await report(env, row, 'failed', `Preview environment failed: ${error}`)
  return { status: 'failed', branchRef: row.branch_ref, workerName: row.worker_name, error }
}

async function waiting(
  env: Env,
  row: PreviewRow,
  note: string,
  patch: Partial<Pick<PreviewRow, 'branch_id' | 'branch_ref' | 'worker_name'>> = {},
): Promise<PreviewState> {
  await env.DB.prepare(
    `UPDATE preview_envs
       SET attempts = attempts + 1, last_error = ?1, updated_at = ?2,
           branch_id = COALESCE(?3, branch_id),
           branch_ref = COALESCE(?4, branch_ref),
           worker_name = COALESCE(?5, worker_name)
     WHERE repo = ?6 AND pr_number = ?7`,
  )
    .bind(
      note,
      Date.now(),
      patch.branch_id ?? null,
      patch.branch_ref ?? null,
      patch.worker_name ?? null,
      row.repo,
      row.pr_number,
    )
    .run()
  return {
    status: 'building',
    branchRef: patch.branch_ref ?? row.branch_ref,
    workerName: patch.worker_name ?? row.worker_name,
    error: note,
  }
}

async function ready(
  env: Env,
  row: PreviewRow,
  branchRef: string,
  worker: string,
  previewUrl: string | null,
): Promise<PreviewState> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE preview_envs
       SET status = 'ready', preview_url = ?1, worker_name = ?2, branch_ref = ?3,
           last_error = NULL, ready_at = ?4, updated_at = ?4
     WHERE repo = ?5 AND pr_number = ?6`,
  )
    .bind(previewUrl, worker, branchRef, now, row.repo, row.pr_number)
    .run()
  await report(env, row, 'passed', `Preview environment ready on ${worker}`)
  return { status: 'ready', branchRef, workerName: worker, error: null }
}

// Advance this PR's preview environment by one step and report where it got
// to. Safe to call at any cadence and from more than one caller: every step
// re-reads the world and writes the same row.
export async function stepPreview(env: Env, repo: string, prNumber: number): Promise<PreviewState | null> {
  const row = await loadRow(env, repo, prNumber)
  if (!row) return null
  if (row.status !== 'building') return rowState(row)

  const config = JSON.parse(row.config_json) as PreviewConfig
  const provider = previewProvider(env)

  if (!provider) {
    return fail(
      env,
      row,
      'scenetest/pipeline.json declares a preview environment, but PREVIEW_PROVIDER is not set on this deployment',
    )
  }
  if (Date.now() > row.deadline) {
    return fail(
      env,
      row,
      `preview environment timed out after ${Math.round(previewTimeoutMs(env) / 60_000)}m: ${row.last_error ?? 'still building'}`,
    )
  }
  if (provider === 'stub') return stubStep(env, row, config)

  for (const [name, value] of Object.entries({
    SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
  })) {
    if (!value) return fail(env, row, `preview environment needs ${name} on this deployment`)
  }

  try {
    const branch =
      (await sb.findBranch(env, config.supabase.projectRef, row.git_branch)) ??
      (await sb.createBranch(env, config.supabase.projectRef, {
        gitBranch: row.git_branch,
        withData: config.supabase.withData,
        ...(config.supabase.region ? { region: config.supabase.region } : {}),
      }))

    if (sb.branchDead(branch)) {
      return fail(
        env,
        row,
        `Supabase branch ${branch.project_ref} is ${branch.preview_project_status ?? branch.status ?? 'gone'}`,
      )
    }

    const worker = renderWorkerName(config.cloudflare.worker, prNumber, row.git_branch)
    const found = { branch_id: branch.id, branch_ref: branch.project_ref, worker_name: worker }

    // The gate on the whole handover: keys the branch project will answer
    // with. They appear once the branch project exists and do not change when
    // its migrations run, so this is as early as the Worker can be pointed at
    // a database that will answer it.
    const keys = await sb.getApiKeys(env, branch.project_ref).catch((err) => {
      console.log(`preview: ${branch.project_ref} has no keys yet: ${err instanceof Error ? err.message : err}`)
      return null
    })
    if (!keys) {
      return waiting(env, row, `Supabase branch ${branch.project_ref} has no keys yet`, found)
    }

    if (!(await cf.workerExists(env, worker))) {
      return waiting(env, row, `Cloudflare Worker ${worker} is not deployed yet`, found)
    }

    const needsUrl = Object.values(config.cloudflare.secrets).includes('preview_url')
    const [detail, subdomain] = await Promise.all([
      sb.getBranch(env, branch.project_ref),
      needsUrl ? cf.accountSubdomain(env) : Promise.resolve(null),
    ])
    const previewUrl = subdomain ? cf.workersDevUrl(worker, subdomain) : null

    const values: PreviewValues = {
      url: sb.projectUrl(branch.project_ref),
      anon_key: keys.anonKey,
      service_role_key: keys.serviceRoleKey,
      db_url: sb.dbUrl(detail),
      branch_ref: branch.project_ref,
      preview_url: previewUrl ?? '',
      pr: String(prNumber),
      branch: row.git_branch,
    }

    // Serially, so a rejected token stops at the first secret rather than
    // leaving the Worker holding half a new environment and half an old one.
    for (const [name, field] of Object.entries(config.cloudflare.secrets)) {
      await cf.putSecret(env, worker, name, values[field])
    }

    return ready(env, row, branch.project_ref, worker, previewUrl)
  } catch (err) {
    // Transient by assumption: the deadline is what makes a repeated failure
    // terminal, so a rate limit or a 502 costs one poll, not the environment.
    return waiting(env, row, err instanceof Error ? err.message : String(err))
  }
}

async function stubStep(env: Env, row: PreviewRow, config: PreviewConfig): Promise<PreviewState> {
  const worker = renderWorkerName(config.cloudflare.worker, row.pr_number, row.git_branch)
  const branchRef = `stub-${row.pr_number}`
  if (row.attempts < 1) {
    return waiting(env, row, 'stub branch has no keys yet', {
      branch_id: `stub-branch-${row.pr_number}`,
      branch_ref: branchRef,
      worker_name: worker,
    })
  }
  return ready(env, row, branchRef, worker, `https://${worker}.stub.workers.dev`)
}

export async function getPreview(env: Env, repo: string, prNumber: number): Promise<PreviewState | null> {
  const row = await loadRow(env, repo, prNumber)
  return row ? rowState(row) : null
}

// A closed PR keeps nothing: the Supabase branch is deleted (it is billable)
// and the row goes with it. The Cloudflare Worker is left alone — the
// project's own deploy created it, so the project's own deploy retires it.
export async function cleanupPreview(env: Env, repo: string, prNumber: number): Promise<void> {
  const row = await loadRow(env, repo, prNumber)
  if (!row) return
  if (row.branch_ref && previewProvider(env) === 'supabase-cloudflare') {
    await sb.deleteBranch(env, row.branch_ref).catch((err) => {
      console.error(`preview: deleting branch ${row.branch_ref} failed: ${err instanceof Error ? err.message : err}`)
    })
  }
  await env.DB.prepare('DELETE FROM preview_envs WHERE repo = ?1 AND pr_number = ?2')
    .bind(repo, prNumber)
    .run()
}
