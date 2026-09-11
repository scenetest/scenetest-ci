// The `preview` block of scenetest/pipeline.json: "this project's scenes run
// against a hosted preview, not a server on the box". Spec and worked
// examples in docs/preview-environments.md.
//
// It rides the pipeline file like everything else, so editing it cascades a
// rebuild (the file's blob sha hashes into every stage) and the box always
// holds the current one.

// The values a resolved preview environment offers. A pipeline file names
// these on the right-hand side of `cloudflare.secrets`; the left-hand side is
// the environment variable the preview Worker wants them under.
export const PREVIEW_FIELDS = [
  'url',
  'anon_key',
  'service_role_key',
  'db_url',
  'branch_ref',
  'preview_url',
  'pr',
  'branch',
] as const

export type PreviewField = (typeof PREVIEW_FIELDS)[number]

export type PreviewValues = Record<PreviewField, string>

export interface PreviewConfig {
  supabase: {
    // The parent project the preview branch forks from.
    projectRef: string
    // Copy the parent's data into the branch (Supabase `with_data`).
    withData: boolean
    region?: string
  }
  cloudflare: {
    // Worker script name; '{pr}' and '{branch}' are substituted.
    worker: string
    // env var name → preview field, written as Worker secrets.
    secrets: Record<string, PreviewField>
  }
}

function parseFieldMap(raw: unknown): Record<string, PreviewField> | null {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<string, PreviewField> = {}
  for (const [name, field] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
    if (typeof field !== 'string' || !PREVIEW_FIELDS.includes(field as PreviewField)) return null
    out[name] = field as PreviewField
  }
  return out
}

// Strict: a preview block that doesn't parse is dropped whole (the caller
// falls back to no preview) rather than half-applied. A project that wanted a
// preview and doesn't get one fails loudly in its scenes; a project that gets
// half a preview fails mysteriously.
export function parsePreview(raw: unknown): PreviewConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const cfg = raw as { supabase?: unknown; cloudflare?: unknown }

  const sb = cfg.supabase as { project_ref?: unknown; with_data?: unknown; region?: unknown } | undefined
  if (!sb || typeof sb.project_ref !== 'string' || !/^[a-z]{20}$/.test(sb.project_ref)) return null
  if (sb.with_data !== undefined && typeof sb.with_data !== 'boolean') return null
  if (sb.region !== undefined && typeof sb.region !== 'string') return null

  const cf = cfg.cloudflare as { worker?: unknown; secrets?: unknown } | undefined
  if (!cf || typeof cf.worker !== 'string' || !/^[a-z0-9{}_-]{1,80}$/.test(cf.worker)) return null

  const secrets = parseFieldMap(cf.secrets)
  if (!secrets) return null

  return {
    supabase: {
      projectRef: sb.project_ref,
      withData: sb.with_data === true,
      ...(typeof sb.region === 'string' ? { region: sb.region } : {}),
    },
    cloudflare: { worker: cf.worker, secrets },
  }
}

// '{pr}' and '{branch}' in a Worker name. Branch names carry '/' and other
// characters Cloudflare rejects in a script name, so they are flattened the
// same way Cloudflare's own git integration flattens them.
export function renderWorkerName(template: string, prNumber: number, gitBranch: string): string {
  return template
    .replaceAll('{pr}', String(prNumber))
    .replaceAll('{branch}', gitBranch.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40))
}

export function renderFieldMap(
  map: Record<string, PreviewField>,
  values: PreviewValues,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, field] of Object.entries(map)) out[name] = values[field]
  return out
}
