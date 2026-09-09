import type { Env } from '../env.ts'
import { ghHeaders } from '../github.ts'
import { sha256Hex } from '../hash.ts'
import { imageStageHash } from './image.ts'
import { parsePreview, type PreviewConfig } from '../preview/config.ts'

// The pipeline file: scenetest/pipeline.json in the user's repo. v0 fields
// are `watch` and `run`; `save`, `restore`, and `toolchain` are reserved for
// later versions and validated-but-ignored so files written today survive
// upgrades. Spec and user instructions in docs/pipeline.md.
//
// Semantics (architecture.md, "The build pipeline"): a linear chain of
// stages, each keyed by hash(parent hash, watched tree hashes, stage config,
// pipeline file). A stage re-runs only when its hash changes; a changed
// stage re-runs everything after it. The root parent is the runner image's
// own hash, so a toolchain change rebuilds everything.
//
// Hashes are computed here, in the worker, at webhook time, from the GitHub
// trees API — no checkout. Every failure path degrades to COARSE: a single
// pseudo-stage keyed by the commit sha, which reproduces the old
// rebuild-everything-on-any-change behavior. Degradation can over-rebuild
// but never under-rebuilds.

export interface PipelineStage {
  name: string
  watch: string[]
  run?: string
}

export interface PipelineConfig {
  version: 1
  stages: PipelineStage[]
  // How one batch of scenes executes. NOT a stage: stages are
  // content-addressed and skipped when nothing changed; the scenes command
  // is dispatch-triggered and parameterized per run. It still rides the
  // pipeline file, so editing it cascades (the file hashes into every
  // stage) and the box always holds the current command.
  scenes: string
  // Optional hosted preview environment: the scenes run against a deployed
  // Worker backed by a Supabase preview branch, not against a server the box
  // started (docs/preview-environments.md).
  preview: PreviewConfig | null
}

export interface StagePlan {
  // Stage name → input hash, in stage order. Coarse plans have one
  // pseudo-stage '*coarse*' keyed by the commit sha.
  vector: Record<string, string>
  // What the box must execute on divergence, in order.
  stages: Array<{ name: string; run?: string }>
  scenes: string
  preview: PreviewConfig | null
  coarse: boolean
}

export const PIPELINE_PATH = 'scenetest/pipeline.json'
// Legacy hook fallback, also the default when the file omits `scenes`.
export const DEFAULT_SCENES_COMMAND = 'bash scenetest/box-run.sh'

// Absent or unreadable pipeline file: one stage watching everything, running
// the legacy setup hook if the repo has one. Exactly yesterday's behavior.
export function defaultPipeline(): PipelineConfig {
  return {
    version: 1,
    stages: [
      {
        // Reserved name: '*' can't appear in user stage names (parsePipeline
        // rejects it), so system pseudo-stages are unambiguous downstream
        // (e.g. repoStatus telling "real pipeline" from "coarse default").
        name: '*setup*',
        watch: ['**'],
        run: 'if [ -f scenetest/box-setup.sh ]; then bash scenetest/box-setup.sh; fi',
      },
    ],
    scenes: DEFAULT_SCENES_COMMAND,
    preview: null,
  }
}

// Strict on what we act on, silent on what we reserve. Returns null (caller
// falls back to default) rather than throwing: a malformed pipeline file
// must never block a run, only un-optimize it.
export function parsePipeline(raw: string): PipelineConfig | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const cfg = data as { version?: unknown; stages?: unknown; scenes?: unknown; preview?: unknown }
  if (cfg.version !== 1 || !Array.isArray(cfg.stages) || cfg.stages.length === 0) return null
  if (cfg.scenes !== undefined && typeof cfg.scenes !== 'string') return null

  const seen = new Set<string>()
  const stages: PipelineStage[] = []
  for (const s of cfg.stages as Array<Record<string, unknown>>) {
    if (typeof s?.name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(s.name)) return null
    if (seen.has(s.name)) return null
    seen.add(s.name)
    if (s.run !== undefined && typeof s.run !== 'string') return null
    const watch = s.watch === undefined ? ['**'] : s.watch
    if (!Array.isArray(watch) || !watch.every((g) => typeof g === 'string' && g.length > 0)) return null
    stages.push({ name: s.name, watch: watch as string[], ...(s.run !== undefined ? { run: s.run as string } : {}) })
  }
  // An unparseable preview block drops only the preview: the rest of the file
  // is still a better plan than the coarse fallback, and the run fails on the
  // missing environment rather than on a silently coarse rebuild.
  const preview = cfg.preview === undefined ? null : parsePreview(cfg.preview)
  if (cfg.preview !== undefined && !preview) console.warn('pipeline: invalid preview block; ignoring it')
  return {
    version: 1,
    stages,
    scenes: typeof cfg.scenes === 'string' ? cfg.scenes : DEFAULT_SCENES_COMMAND,
    preview,
  }
}

// Minimal glob-to-regex: '**' crosses directories, '*' stays within one path
// segment, everything else is literal. No negation, no braces — documented
// in docs/pipeline.md. Coarse globs are safe; clever ones aren't needed.
export function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        // swallow a '/' directly after '**' so 'dir/**' also matches 'dir/x'
        if (glob[i + 1] === '/') i++
        if (glob[i] === '/') out += '/?'
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path))
}

export interface TreeEntry {
  path: string
  sha: string
}

// Pure: vector from a tree listing + config. Exposed for tests; the network
// wrapper below feeds it.
export async function computeVector(
  config: PipelineConfig,
  tree: TreeEntry[],
  rootHash: string,
  pipelineFileSha: string,
): Promise<{ vector: Record<string, string>; stages: Array<{ name: string; run?: string }> }> {
  const vector: Record<string, string> = {}
  let prev = rootHash
  for (const stage of config.stages) {
    // Compile each stage's globs once, not once per tree entry — large
    // repos have tens of thousands of blobs.
    const globs = stage.watch.map(globToRegExp)
    const matched = tree
      .filter((e) => globs.some((g) => g.test(e.path)))
      .map((e) => `${e.path}:${e.sha}`)
      .sort()
    const input = [JSON.stringify({ name: stage.name, run: stage.run ?? null, watch: stage.watch }), prev, pipelineFileSha, ...matched].join('\n')
    const hash = (await sha256Hex(input)).slice(0, 16)
    vector[stage.name] = hash
    prev = hash
  }
  return {
    vector,
    stages: config.stages.map((s) => ({ name: s.name, ...(s.run !== undefined ? { run: s.run } : {}) })),
  }
}

function coarsePlan(headSha: string): StagePlan {
  const fallback = defaultPipeline()
  return {
    vector: { '*coarse*': headSha },
    stages: fallback.stages.map((s) => ({ name: s.name, run: s.run })),
    scenes: fallback.scenes,
    preview: null,
    coarse: true,
  }
}

// The webhook-time entry point: pipeline file + recursive tree → stage plan.
// Unauthenticated GitHub API calls are rate-limited from worker egress IPs
// (set GITHUB_API_TOKEN to lift that); any failure, truncation, or parse
// problem degrades to the coarse plan.
export async function computeStagePlan(env: Env, repo: string, headSha: string): Promise<StagePlan> {
  try {
    const treeResp = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${headSha}?recursive=1`,
      { headers: ghHeaders(env) },
    )
    if (!treeResp.ok) throw new Error(`trees API ${treeResp.status}`)
    const treeData = (await treeResp.json()) as {
      truncated: boolean
      tree: Array<{ path: string; sha: string; type: string }>
    }
    if (treeData.truncated) throw new Error('tree truncated')
    const tree: TreeEntry[] = treeData.tree
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, sha: e.sha }))

    const pipelineEntry = treeData.tree.find((e) => e.path === PIPELINE_PATH && e.type === 'blob')
    let config = defaultPipeline()
    let pipelineFileSha = 'default'
    if (pipelineEntry) {
      const blobResp = await fetch(
        `https://api.github.com/repos/${repo}/git/blobs/${pipelineEntry.sha}`,
        { headers: ghHeaders(env) },
      )
      if (!blobResp.ok) throw new Error(`blobs API ${blobResp.status}`)
      const blob = (await blobResp.json()) as { content: string }
      const parsed = parsePipeline(atob(blob.content.replaceAll('\n', '')))
      if (parsed) {
        config = parsed
        pipelineFileSha = pipelineEntry.sha
      } else {
        console.warn(`pipeline: ${repo}@${headSha} has invalid ${PIPELINE_PATH}; using default`)
      }
    }

    const { vector, stages } = await computeVector(config, tree, await imageStageHash(), pipelineFileSha)
    return { vector, stages, scenes: config.scenes, preview: config.preview, coarse: false }
  } catch (err) {
    console.warn(`pipeline: coarse fallback for ${repo}@${headSha}: ${err instanceof Error ? err.message : err}`)
    return coarsePlan(headSha)
  }
}

// Index of the first stage whose hash differs from what the box has
// realized; null when nothing diverges (full reuse). A realized vector from
// a different stage list (renames, coarse↔fine transitions) diverges at 0.
export function firstDivergentStage(
  plan: StagePlan,
  realized: Record<string, string> | null,
): number | null {
  const names = Object.keys(plan.vector)
  if (!realized) return 0
  for (let i = 0; i < names.length; i++) {
    if (realized[names[i]!] !== plan.vector[names[i]!]) return i
  }
  return null
}
