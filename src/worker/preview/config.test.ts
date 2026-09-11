import { describe, expect, it } from 'vitest'
import { parsePreview, renderFieldMap, renderWorkerName } from './config.ts'

const REF = 'abcdefghijklmnopqrst'

const valid = {
  supabase: { project_ref: REF, with_data: true },
  cloudflare: {
    worker: 'sunlo-pr-{pr}',
    secrets: { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'service_role_key' },
  },
}

describe('parsePreview', () => {
  it('reads a full block', () => {
    expect(parsePreview(valid)).toEqual({
      supabase: { projectRef: REF, withData: true },
      cloudflare: {
        worker: 'sunlo-pr-{pr}',
        secrets: { SUPABASE_URL: 'url', SUPABASE_SERVICE_ROLE_KEY: 'service_role_key' },
      },
    })
  })

  it('defaults with_data off and the secret map empty', () => {
    const cfg = parsePreview({ supabase: { project_ref: REF }, cloudflare: { worker: 'w' } })
    expect(cfg?.supabase.withData).toBe(false)
    expect(cfg?.cloudflare.secrets).toEqual({})
  })

  it('rejects a block naming a field the environment does not have', () => {
    expect(parsePreview({ ...valid, cloudflare: { worker: 'w', secrets: { KEY: 'jwt_secret' } } })).toBeNull()
  })

  it('rejects a project ref that is not a project ref', () => {
    expect(parsePreview({ ...valid, supabase: { project_ref: 'nope' } })).toBeNull()
  })

  it('rejects an environment variable name a shell would not accept', () => {
    expect(parsePreview({ ...valid, cloudflare: { worker: 'w', secrets: { 'BASE-URL': 'url' } } })).toBeNull()
  })

  it('rejects a missing half', () => {
    expect(parsePreview({ supabase: { project_ref: REF } })).toBeNull()
    expect(parsePreview({ cloudflare: { worker: 'w' } })).toBeNull()
    expect(parsePreview('nope')).toBeNull()
  })
})

describe('renderWorkerName', () => {
  it('substitutes the PR number', () => {
    expect(renderWorkerName('sunlo-pr-{pr}', 42, 'feat/login')).toBe('sunlo-pr-42')
  })

  it('flattens a branch name into something Cloudflare accepts', () => {
    expect(renderWorkerName('sunlo-{branch}', 42, 'Feat/Login Page')).toBe('sunlo-feat-login-page')
  })
})

describe('renderFieldMap', () => {
  it('maps secret names onto environment fields', () => {
    const values = {
      url: 'https://x.supabase.co',
      anon_key: 'anon',
      service_role_key: 'service',
      db_url: 'postgresql://',
      branch_ref: 'x',
      preview_url: 'https://w.workers.dev',
      pr: '42',
      branch: 'feat/login',
    }
    expect(renderFieldMap({ BASE_URL: 'preview_url', KEY: 'anon_key' }, values)).toEqual({
      BASE_URL: 'https://w.workers.dev',
      KEY: 'anon',
    })
  })
})
