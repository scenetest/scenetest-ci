import { describe, expect, it } from 'vitest'
import { branchDead, dbUrl, projectUrl } from './supabase.ts'

const branch = (status?: string, project?: string) => ({
  id: 'b1',
  name: 'feat/login',
  project_ref: 'previewrefpreviewref',
  ...(status ? { status } : {}),
  ...(project ? { preview_project_status: project } : {}),
})

describe('branchDead', () => {
  it('is alive while the branch project comes up, restores, or migrates', () => {
    expect(branchDead(branch('RUNNING_MIGRATIONS', 'COMING_UP'))).toBe(false)
    expect(branchDead(branch('MIGRATIONS_PASSED', 'ACTIVE_HEALTHY'))).toBe(false)
    expect(branchDead(branch(undefined, 'RESTORING'))).toBe(false)
  })

  it('is alive with failed migrations: the keys still work, the schema is the project\'s problem', () => {
    expect(branchDead(branch('MIGRATIONS_FAILED', 'ACTIVE_HEALTHY'))).toBe(false)
  })

  it('is dead when the branch project failed to come up or is gone', () => {
    expect(branchDead(branch('MIGRATIONS_PASSED', 'INIT_FAILED'))).toBe(true)
    expect(branchDead(branch(undefined, 'REMOVED'))).toBe(true)
  })

  it('is alive when the API reports no project status at all', () => {
    expect(branchDead(branch())).toBe(false)
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
