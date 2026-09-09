import { describe, expect, it } from 'vitest'
import { branchPhase, dbUrl, projectUrl } from './supabase.ts'

const branch = (status?: string, project?: string) => ({
  id: 'b1',
  name: 'feat/login',
  project_ref: 'previewrefpreviewref',
  ...(status ? { status } : {}),
  ...(project ? { preview_project_status: project } : {}),
})

describe('branchPhase', () => {
  it('is building until the branch project is healthy', () => {
    expect(branchPhase(branch('RUNNING_MIGRATIONS', 'COMING_UP'))).toBe('building')
    expect(branchPhase(branch(undefined, 'COMING_UP'))).toBe('building')
  })

  it('is still building when a healthy project has migrations left to run', () => {
    expect(branchPhase(branch('RUNNING_MIGRATIONS', 'ACTIVE_HEALTHY'))).toBe('building')
  })

  it('is ready when the project is healthy and its migrations passed', () => {
    expect(branchPhase(branch('MIGRATIONS_PASSED', 'ACTIVE_HEALTHY'))).toBe('ready')
    expect(branchPhase(branch('FUNCTIONS_DEPLOYED', 'ACTIVE_HEALTHY'))).toBe('ready')
  })

  it('trusts health alone once the migration field goes away', () => {
    expect(branchPhase(branch(undefined, 'ACTIVE_HEALTHY'))).toBe('ready')
  })

  it('fails on a failed migration or a failed branch project', () => {
    expect(branchPhase(branch('MIGRATIONS_FAILED', 'ACTIVE_HEALTHY'))).toBe('failed')
    expect(branchPhase(branch('FUNCTIONS_FAILED', 'ACTIVE_HEALTHY'))).toBe('failed')
    expect(branchPhase(branch('MIGRATIONS_PASSED', 'INIT_FAILED'))).toBe('failed')
  })
})

describe('dbUrl', () => {
  const detail = {
    ref: 'previewrefpreviewref',
    status: 'ACTIVE_HEALTHY',
    db_host: 'db.example.supabase.co',
    db_port: 5432,
  }

  it('builds a connection string when the API returned credentials', () => {
    expect(dbUrl({ ...detail, db_user: 'postgres', db_pass: 'p@ss word' })).toBe(
      'postgresql://postgres:p%40ss%20word@db.example.supabase.co:5432/postgres',
    )
  })

  it('is empty when the API withheld them', () => {
    expect(dbUrl(detail)).toBe('')
  })
})

describe('projectUrl', () => {
  it('is the branch project ref on supabase.co', () => {
    expect(projectUrl('previewrefpreviewref')).toBe('https://previewrefpreviewref.supabase.co')
  })
})
