import type { Env } from '../env.ts'

// Supabase Management API, the branching subset (api.supabase.com/api/v1-json).
// SUPABASE_ACCESS_TOKEN is a personal access token with environment:write and
// secrets:read.

const API = 'https://api.supabase.com'

export interface SupabaseBranch {
  id: string
  name: string
  project_ref: string
  git_branch?: string
  // Migration progress. Upstream marks it deprecated but still populates it,
  // and it is the only field that reports a failed migration, so it is read
  // when present and never required.
  status?: string
  // The branch project's own health.
  preview_project_status?: string
}

export interface SupabaseBranchDetail {
  ref: string
  status: string
  db_host: string
  db_port: number
  db_user?: string
  db_pass?: string
}

export type BranchPhase = 'building' | 'ready' | 'failed'

const MIGRATIONS_FAILED = new Set(['MIGRATIONS_FAILED', 'FUNCTIONS_FAILED'])
const MIGRATIONS_DONE = new Set(['MIGRATIONS_PASSED', 'FUNCTIONS_DEPLOYED'])
const PROJECT_FAILED = new Set(['INIT_FAILED', 'RESTORE_FAILED', 'PAUSE_FAILED', 'REMOVED'])

// Two independent signals have to agree before a branch is usable: the branch
// project is healthy, and its migrations ran. A branch reports ACTIVE_HEALTHY
// while migrations are still running, so health alone would hand out a
// database with no schema in it.
export function branchPhase(branch: SupabaseBranch): BranchPhase {
  const migration = branch.status
  const project = branch.preview_project_status
  if ((migration && MIGRATIONS_FAILED.has(migration)) || (project && PROJECT_FAILED.has(project))) {
    return 'failed'
  }
  if (project !== 'ACTIVE_HEALTHY') return 'building'
  if (migration && !MIGRATIONS_DONE.has(migration)) return 'building'
  return 'ready'
}

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN ?? ''}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (!resp.ok) {
    throw new Error(`supabase ${init.method ?? 'GET'} ${path}: ${resp.status} ${(await resp.text()).slice(0, 200)}`)
  }
  return (await resp.json()) as T
}

export async function findBranch(
  env: Env,
  projectRef: string,
  gitBranch: string,
): Promise<SupabaseBranch | null> {
  const branches = await call<SupabaseBranch[]>(env, `/v1/projects/${projectRef}/branches`)
  return branches.find((b) => b.git_branch === gitBranch) ?? null
}

export async function createBranch(
  env: Env,
  projectRef: string,
  opts: { gitBranch: string; withData: boolean; region?: string },
): Promise<SupabaseBranch> {
  return call<SupabaseBranch>(env, `/v1/projects/${projectRef}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch_name: opts.gitBranch,
      git_branch: opts.gitBranch,
      with_data: opts.withData,
      ...(opts.region ? { region: opts.region } : {}),
    }),
  })
}

export async function getBranch(env: Env, branchRef: string): Promise<SupabaseBranchDetail> {
  return call<SupabaseBranchDetail>(env, `/v1/branches/${branchRef}`)
}

export async function deleteBranch(env: Env, branchRef: string): Promise<void> {
  await call(env, `/v1/branches/${branchRef}`, { method: 'DELETE' })
}

interface ApiKey {
  name: string
  type?: string | null
  api_key?: string | null
}

// The branch project's anon and service_role keys. `reveal=true` returns the
// key material itself; without it the endpoint returns hashes.
export async function getApiKeys(
  env: Env,
  branchRef: string,
): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const keys = await call<ApiKey[]>(env, `/v1/projects/${branchRef}/api-keys?reveal=true`)
  const pick = (name: string, type: string): string => {
    const match = keys.find((k) => k.name === name) ?? keys.find((k) => k.type === type)
    if (!match?.api_key) throw new Error(`supabase: no ${name} key on ${branchRef}`)
    return match.api_key
  }
  return { anonKey: pick('anon', 'publishable'), serviceRoleKey: pick('service_role', 'secret') }
}

export function projectUrl(branchRef: string): string {
  return `https://${branchRef}.supabase.co`
}

// The session-mode connection string, for a scenes command that seeds or
// asserts against the database directly. Empty when the API withheld the
// credentials, which the caller passes through as an empty variable rather
// than failing the whole environment.
export function dbUrl(detail: SupabaseBranchDetail): string {
  if (!detail.db_user || !detail.db_pass) return ''
  return `postgresql://${detail.db_user}:${encodeURIComponent(detail.db_pass)}@${detail.db_host}:${detail.db_port}/postgres`
}
