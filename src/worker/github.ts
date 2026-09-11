// Shared bits for talking to api.github.com (OAuth user fetch, admin lookups)
// and for verifying inbound webhooks.
export const GH_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'scenetest-cloud',
} as const

// Headers for api.github.com, authenticated when the deployment has a
// GITHUB_API_TOKEN (unauthenticated calls share the worker egress IP's
// 60/hr limit).
export function ghHeaders(env: { GITHUB_API_TOKEN?: string }): Record<string, string> {
  return env.GITHUB_API_TOKEN
    ? { ...GH_API_HEADERS, authorization: `Bearer ${env.GITHUB_API_TOKEN}` }
    : { ...GH_API_HEADERS }
}

// Map a run status to a GitHub commit-status state. The pre-terminal states
// (`queued`/`running`) become `pending` so the check shows up while the run is
// live; `cancelled` becomes `error` (commit statuses have no neutral) so a
// retired box never leaves a stale `pending` on the PR. An unknown status maps
// to nothing and is skipped.
const RUN_STATUS_STATE: Record<string, 'pending' | 'success' | 'failure' | 'error'> = {
  queued: 'pending',
  running: 'pending',
  passed: 'success',
  failed: 'failure',
  cancelled: 'error',
}

// Report a run's state back to GitHub as a commit status on the PR's head
// sha — the one leg of the loop that closes back to GitHub, so the merge
// button reflects what the dashboard already knows. Posted twice in a run's
// life: `pending` at creation (from `createRun`) and the terminal verdict
// (from `postRunComplete`); both share the `scenetest` context so they update
// the same check line. A caller can name a different context to report on
// something that is not a run — the preview environment posts its own, so its
// outcome never mixes with a verdict about the code. Best-effort by contract: callers run it through
// `ctx.waitUntil` and a GitHub hiccup must not fail the request. Needs
// GITHUB_API_TOKEN with the `repo:status` scope; when the token is absent or
// under-scoped (or on any API error) we log and skip, exactly like the read
// path degrades to the coarse plan.
//
// Commit status is the first cut (one POST, works with a PAT). Check runs are
// the upgrade path — richer (annotations, re-run, summary markdown) but
// GitHub-App-only — to land with the rest of the App story.
export async function postCommitStatus(
  env: { GITHUB_API_TOKEN?: string },
  args: {
    repo: string
    sha: string
    status: string
    description: string
    targetUrl?: string
    context?: string
  },
): Promise<void> {
  const tag = `commit-status(${args.repo}@${args.sha.slice(0, 7)})`
  if (!env.GITHUB_API_TOKEN) {
    console.log(`${tag} skipped: no GITHUB_API_TOKEN`)
    return
  }
  const state = RUN_STATUS_STATE[args.status]
  if (!state) return
  try {
    const resp = await fetch(`https://api.github.com/repos/${args.repo}/statuses/${args.sha}`, {
      method: 'POST',
      headers: { ...ghHeaders(env), 'content-type': 'application/json' },
      body: JSON.stringify({
        state,
        context: args.context ?? 'scenetest',
        description: args.description.slice(0, 140),
        target_url: args.targetUrl,
      }),
    })
    if (!resp.ok) {
      // 403/404 here usually means the token lacks `repo:status` — log and
      // move on, same graceful degrade as the read path.
      console.error(`${tag} ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    }
  } catch (err) {
    console.error(`${tag} failed: ${err instanceof Error ? err.message : err}`)
  }
}

const enc = new TextEncoder()

// GitHub signs the raw request body with HMAC-SHA256 and sends
// 'sha256=<hex>' in X-Hub-Signature-256. Verify against the raw body bytes,
// before any JSON parsing.
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? '')
  if (!m) return false
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)))
  const claimed = m[1]!
  // Constant-time compare. Both sides are 32 bytes by construction.
  let diff = 0
  for (let i = 0; i < mac.length; i++) {
    diff |= mac[i]! ^ parseInt(claimed.slice(i * 2, i * 2 + 2), 16)
  }
  return diff === 0
}
