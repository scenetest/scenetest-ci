import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.ts'
import { stepPreview } from './reconcile.ts'
import type { PreviewConfig } from './config.ts'

// The reconciler's whole job is deciding what one poll means, so these tests
// drive it against a recorded D1 (the row it reads, the writes it makes) and
// a scripted Management/Cloudflare API.

const CONFIG: PreviewConfig = {
  supabase: { projectRef: 'abcdefghijklmnopqrst', withData: false },
  cloudflare: {
    worker: 'sunlo-pr-{pr}',
    secrets: { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'service_role_key' },
  },
}

function row(over: Record<string, unknown> = {}) {
  return {
    repo: 'mhsnook/sunlo',
    pr_number: 42,
    git_branch: 'feat/login',
    config_json: JSON.stringify(CONFIG),
    status: 'building',
    branch_id: null,
    branch_ref: null,
    worker_name: null,
    preview_url: null,
    last_error: null,
    attempts: 0,
    deadline: Date.now() + 600_000,
    ...over,
  }
}

interface Call {
  sql: string
  args: unknown[]
}

function fakeEnv(seeded: Record<string, unknown> | null, over: Partial<Env> = {}) {
  const calls: Call[] = []
  const DB = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args
          return stmt
        },
        async first() {
          calls.push({ sql, args: stmt.args })
          return seeded
        },
        async run() {
          calls.push({ sql, args: stmt.args })
          return { meta: { changes: 1 } }
        },
        async all() {
          calls.push({ sql, args: stmt.args })
          return { results: seeded ? [seeded] : [] }
        },
      }
      return stmt
    },
  }
  const env = {
    DB,
    PREVIEW_PROVIDER: 'supabase-cloudflare',
    SUPABASE_ACCESS_TOKEN: 'sb-token',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    ...over,
  } as unknown as Env
  return { env, calls }
}

const writes = (calls: Call[]) => calls.filter((c) => !c.sql.trim().startsWith('SELECT'))

// A Supabase + Cloudflare API that answers from a script keyed by URL
// fragment. Anything unscripted throws, so a test never passes on a request
// it didn't mean to make.
function scriptFetch(script: Array<[string, unknown, number?]>) {
  const seen: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'
    seen.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null })
    for (const [match, body, status] of script) {
      // 'POST:/branches' pins the method too, for the two calls that share a
      // path: listing a project's branches and creating one.
      const [wantMethod, fragment] = match.includes(':/') ? match.split(':') : [null, match]
      if (url.includes(fragment!) && (!wantMethod || wantMethod === method)) {
        return new Response(JSON.stringify(body), { status: status ?? 200 })
      }
    }
    throw new Error(`unscripted request: ${method} ${url}`)
  })
  return seen
}

const healthyBranch = {
  id: 'branch-uuid',
  name: 'feat/login',
  project_ref: 'previewrefpreviewref',
  git_branch: 'feat/login',
  status: 'MIGRATIONS_PASSED',
  preview_project_status: 'ACTIVE_HEALTHY',
}

const cf = <T,>(result: T) => ({ success: true, result, errors: [] })

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.unstubAllGlobals())

describe('stepPreview', () => {
  it('is a no-op for a PR with no preview environment', async () => {
    const { env } = fakeEnv(null)
    expect(await stepPreview(env, 'mhsnook/sunlo', 42)).toBeNull()
  })

  it('reports a settled environment without touching either API', async () => {
    const { env } = fakeEnv(
      row({ status: 'ready', branch_ref: 'previewrefpreviewref', worker_name: 'sunlo-pr-42' }),
    )
    scriptFetch([])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state).toEqual({
      status: 'ready',
      branchRef: 'previewrefpreviewref',
      workerName: 'sunlo-pr-42',
      error: null,
    })
  })

  it('creates the branch when the project has none for this git branch', async () => {
    const { env, calls } = fakeEnv(row())
    const seen = scriptFetch([
      ['GET:/branches', [], 200],
      ['POST:/branches', { ...healthyBranch, status: 'CREATING_PROJECT', preview_project_status: 'COMING_UP' }],
    ])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('building')
    const created = seen.find((r) => r.method === 'POST')
    expect(created?.body).toMatchObject({ branch_name: 'feat/login', git_branch: 'feat/login', with_data: false })
    // The branch it just created is remembered, so the next poll finds it.
    expect(writes(calls)[0]?.args).toContain('branch-uuid')
  })

  it('waits on a Worker the project has not deployed yet', async () => {
    const { env } = fakeEnv(row())
    scriptFetch([
      ['api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches', [healthyBranch]],
      ['/api-keys', [
        { name: 'anon', type: 'legacy', api_key: 'anon-key' },
        { name: 'service_role', type: 'legacy', api_key: 'service-key' },
      ]],
      ['workers/scripts/sunlo-pr-42', { success: false }, 404],
    ])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('building')
    expect(state?.error).toContain('sunlo-pr-42')
  })

  it('writes the branch keys to the Worker', async () => {
    const { env, calls } = fakeEnv(row())
    const seen = scriptFetch([
      ['api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches', [healthyBranch]],
      ['workers/scripts/sunlo-pr-42/secrets', cf({ name: 'x', type: 'secret_text' })],
      ['workers/scripts/sunlo-pr-42', cf({ id: 'sunlo-pr-42' })],
      ['/v1/branches/previewrefpreviewref', {
        ref: 'previewrefpreviewref',
        status: 'ACTIVE_HEALTHY',
        db_host: 'db.previewrefpreviewref.supabase.co',
        db_port: 5432,
        db_user: 'postgres',
        db_pass: 'secret',
      }],
      ['/api-keys', [
        { name: 'anon', type: 'legacy', api_key: 'anon-key' },
        { name: 'service_role', type: 'legacy', api_key: 'service-key' },
      ]],
    ])

    const state = await stepPreview(env, 'mhsnook/sunlo', 42)

    expect(state).toMatchObject({ status: 'ready', branchRef: 'previewrefpreviewref', workerName: 'sunlo-pr-42' })
    const secrets = seen.filter((r) => r.url.includes('/secrets'))
    expect(secrets.map((r) => r.body)).toEqual([
      { name: 'SUPABASE_URL', text: 'https://previewrefpreviewref.supabase.co', type: 'secret_text' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY', text: 'service-key', type: 'secret_text' },
    ])
    // The keys reach the Worker and stop there.
    expect(JSON.stringify(writes(calls))).not.toContain('service-key')
    expect(JSON.stringify(writes(calls))).not.toContain('anon-key')
    // No secret asks for the preview URL, so the subdomain is never fetched.
    expect(seen.some((r) => r.url.includes('workers/subdomain'))).toBe(false)
  })

  it('hands over the keys without waiting for the branch migrations', async () => {
    const { env } = fakeEnv(row())
    scriptFetch([
      ['api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches', [
        { ...healthyBranch, status: 'RUNNING_MIGRATIONS', preview_project_status: 'COMING_UP' },
      ]],
      ['workers/scripts/sunlo-pr-42/secrets', cf({ name: 'x', type: 'secret_text' })],
      ['workers/scripts/sunlo-pr-42', cf({ id: 'sunlo-pr-42' })],
      ['/v1/branches/previewrefpreviewref', {
        ref: 'previewrefpreviewref', status: 'COMING_UP', db_host: 'db.x', db_port: 5432,
      }],
      ['/api-keys', [
        { name: 'anon', type: 'legacy', api_key: 'anon-key' },
        { name: 'service_role', type: 'legacy', api_key: 'service-key' },
      ]],
    ])
    expect((await stepPreview(env, 'mhsnook/sunlo', 42))?.status).toBe('ready')
  })

  it('waits while the branch has no keys to give yet', async () => {
    const { env } = fakeEnv(row())
    scriptFetch([
      ['api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches', [
        { ...healthyBranch, status: 'CREATING_PROJECT', preview_project_status: 'COMING_UP' },
      ]],
      ['/api-keys', { message: 'project not ready' }, 503],
    ])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('building')
    expect(state?.error).toContain('no keys yet')
  })

  it('fails the environment when the branch project never comes up', async () => {
    const { env } = fakeEnv(row())
    scriptFetch([
      ['api.supabase.com/v1/projects/abcdefghijklmnopqrst/branches', [
        { ...healthyBranch, preview_project_status: 'INIT_FAILED' },
      ]],
    ])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('failed')
    expect(state?.error).toContain('INIT_FAILED')
  })

  it('keeps waiting through a transient API failure', async () => {
    const { env } = fakeEnv(row())
    scriptFetch([['api.supabase.com', { message: 'rate limited' }, 429]])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('building')
    expect(state?.error).toContain('429')
  })

  it('gives up at the deadline', async () => {
    const { env } = fakeEnv(row({ deadline: Date.now() - 1, last_error: 'Supabase branch is COMING_UP' }))
    scriptFetch([])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('failed')
    expect(state?.error).toContain('COMING_UP')
  })

  it('fails with what is missing when the deployment has no credentials', async () => {
    const { env } = fakeEnv(row(), { SUPABASE_ACCESS_TOKEN: undefined })
    scriptFetch([])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('failed')
    expect(state?.error).toContain('SUPABASE_ACCESS_TOKEN')
  })

  it('fails a declared preview on a deployment with the feature off', async () => {
    const { env } = fakeEnv(row(), { PREVIEW_PROVIDER: undefined })
    scriptFetch([])
    const state = await stepPreview(env, 'mhsnook/sunlo', 42)
    expect(state?.status).toBe('failed')
    expect(state?.error).toContain('PREVIEW_PROVIDER')
  })

  it('stubs an environment in two polls for dev and e2e', async () => {
    scriptFetch([])
    const first = await stepPreview(fakeEnv(row(), { PREVIEW_PROVIDER: 'stub' }).env, 'mhsnook/sunlo', 42)
    expect(first?.status).toBe('building')
    const second = await stepPreview(
      fakeEnv(row({ attempts: 1 }), { PREVIEW_PROVIDER: 'stub' }).env,
      'mhsnook/sunlo',
      42,
    )
    expect(second).toMatchObject({ status: 'ready', workerName: 'sunlo-pr-42' })
  })
})
