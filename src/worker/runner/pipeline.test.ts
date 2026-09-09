import { describe, expect, it } from 'vitest'
import {
  computeVector,
  defaultPipeline,
  firstDivergentStage,
  globToRegExp,
  matchesAny,
  parsePipeline,
  type StagePlan,
  type TreeEntry,
} from './pipeline.ts'

describe('parsePipeline', () => {
  it('accepts a minimal valid file and defaults watch to **', () => {
    const cfg = parsePipeline('{"version":1,"stages":[{"name":"deps","run":"pnpm i"}]}')
    expect(cfg).toEqual({
      version: 1,
      stages: [{ name: 'deps', watch: ['**'], run: 'pnpm i' }],
      preview: null,
      scenes: 'bash scenetest/box-run.sh',
    })
  })

  it('carries the scenes command, defaulting to the legacy hook', () => {
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}],"scenes":"pnpm scenes run"}')?.scenes)
      .toBe('pnpm scenes run')
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}]}')?.scenes)
      .toBe('bash scenetest/box-run.sh')
    expect(parsePipeline('{"version":1,"stages":[{"name":"a"}],"scenes":3}')).toBeNull()
  })

  it('tolerates reserved fields (save/restore/toolchain) silently', () => {
    const cfg = parsePipeline(
      '{"version":1,"stages":[{"name":"db","watch":["supabase/**"],"run":"x","save":"s","restore":"r"}]}',
    )
    expect(cfg?.stages[0]).toEqual({ name: 'db', watch: ['supabase/**'], run: 'x' })
  })

  it.each([
    ['not json', 'nope{'],
    ['wrong version', '{"version":2,"stages":[{"name":"a"}]}'],
    ['empty stages', '{"version":1,"stages":[]}'],
    ['bad name', '{"version":1,"stages":[{"name":"Has Spaces"}]}'],
    ['duplicate names', '{"version":1,"stages":[{"name":"a"},{"name":"a"}]}'],
    ['non-string glob', '{"version":1,"stages":[{"name":"a","watch":[3]}]}'],
  ])('rejects %s (falls back to default)', (_label, raw) => {
    expect(parsePipeline(raw)).toBeNull()
  })
})

describe('glob matching', () => {
  it.each([
    ['**', 'anything/at/all.ts', true],
    ['supabase/**', 'supabase/migrations/0001.sql', true],
    ['supabase/**', 'supabase', false], // blobs only; the dir itself never appears
    ['supabase/**', 'src/supabase.ts', false],
    ['*.lock', 'pnpm-lock.yaml', false],
    ['pnpm-lock.yaml', 'pnpm-lock.yaml', true],
    ['src/**', 'src/a/b/c.tsx', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/notes.md', false], // single * does not cross '/'
    ['docs/*.md', 'docs/notes.md', true],
  ])('%s vs %s → %s', (glob, path, want) => {
    expect(globToRegExp(glob).test(path)).toBe(want)
  })

  it('matchesAny over several globs', () => {
    expect(matchesAny('vite.config.ts', ['src/**', '*.config.ts'])).toBe(true)
    expect(matchesAny('LICENSE', ['src/**', '*.config.ts'])).toBe(false)
  })
})

const TREE: TreeEntry[] = [
  { path: 'pnpm-lock.yaml', sha: 'lock1' },
  { path: 'supabase/migrations/0001.sql', sha: 'mig1' },
  { path: 'src/app.tsx', sha: 'app1' },
  { path: 'docs/readme.md', sha: 'doc1' },
]

const CONFIG = parsePipeline(JSON.stringify({
  version: 1,
  stages: [
    { name: 'deps', watch: ['pnpm-lock.yaml'], run: 'pnpm i' },
    { name: 'db', watch: ['supabase/**'], run: 'supabase db reset' },
    { name: 'build', watch: ['src/**'], run: 'pnpm build' },
  ],
}))!

describe('computeVector', () => {
  it('is deterministic and cascades parent hashes', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root', 'pf1')
    expect(a.vector).toEqual(b.vector)
    expect(Object.keys(a.vector)).toEqual(['deps', 'db', 'build'])
  })

  it('an unwatched change (docs) changes nothing', async () => {
    const docsChanged = TREE.map((e) => (e.path === 'docs/readme.md' ? { ...e, sha: 'doc2' } : e))
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, docsChanged, 'root', 'pf1')
    expect(b.vector).toEqual(a.vector)
  })

  it('a db change invalidates db and build but not deps', async () => {
    const dbChanged = TREE.map((e) => (e.path.startsWith('supabase/') ? { ...e, sha: 'mig2' } : e))
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, dbChanged, 'root', 'pf1')
    expect(b.vector.deps).toBe(a.vector.deps)
    expect(b.vector.db).not.toBe(a.vector.db)
    expect(b.vector.build).not.toBe(a.vector.build) // cascade via parent hash
  })

  it('editing the pipeline file itself invalidates every stage', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root', 'pf2')
    for (const name of Object.keys(a.vector)) expect(b.vector[name]).not.toBe(a.vector[name])
  })

  it('a new image (root hash) invalidates every stage', async () => {
    const a = await computeVector(CONFIG, TREE, 'root', 'pf1')
    const b = await computeVector(CONFIG, TREE, 'root2', 'pf1')
    for (const name of Object.keys(a.vector)) expect(b.vector[name]).not.toBe(a.vector[name])
  })
})

describe('firstDivergentStage', () => {
  const plan = (vector: Record<string, string>): StagePlan => ({
    vector,
    stages: Object.keys(vector).map((name) => ({ name })),
    scenes: 'bash scenetest/box-run.sh',
    preview: null,
    coarse: false,
  })

  it('null when realized matches exactly (full reuse)', () => {
    expect(firstDivergentStage(plan({ a: '1', b: '2' }), { a: '1', b: '2' })).toBeNull()
  })

  it('0 when nothing is realized yet', () => {
    expect(firstDivergentStage(plan({ a: '1' }), null)).toBe(0)
  })

  it('picks the first mismatch, not the last', () => {
    expect(firstDivergentStage(plan({ a: '1', b: '2', c: '3' }), { a: '1', b: 'X', c: 'X' })).toBe(1)
  })

  it('a stage rename or coarse↔fine transition diverges at 0', () => {
    expect(firstDivergentStage(plan({ renamed: '1' }), { '*coarse*': 'sha1' })).toBe(0)
  })

  it('default pipeline keeps the legacy setup hook', () => {
    expect(defaultPipeline().stages[0]!.run).toContain('box-setup.sh')
  })
})
