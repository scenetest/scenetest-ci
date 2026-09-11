export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  // Durable record of run event logs. At end of run the events are assembled
  // into a .jsonl object here; D1's `events` rows are then prunable. Optional
  // so the worker still boots when the binding is absent (the artifact path
  // no-ops). Provisioned via `wrangler r2 bucket create` — see docs/setup.md.
  ARTIFACTS?: R2Bucket
  // One Durable Object per PR: box channel, command queue, event write-through.
  PR_COORDINATOR: DurableObjectNamespace
  // Singleton Durable Object for the home view's live layer (idFromName
  // 'global'): PR coordinators push coarse run-status rollups here (DO-to-DO),
  // and it fans them out to the home dashboard's WebSocket subscribers. Holds no
  // canonical state — a rebuildable cache over the D1 projections.
  HOME_COORDINATOR: DurableObjectNamespace
  // One Durable Object per PR with a hosted preview environment: it owns the
  // poll schedule while the PR's Supabase branch builds. Separate from
  // PR_COORDINATOR on purpose — a preview environment never reaches the box.
  PREVIEW_COORDINATOR: DurableObjectNamespace
  // GitHub OAuth (identity)
  GITHUB_OAUTH_CLIENT_ID: string
  GITHUB_OAUTH_CLIENT_SECRET: string
  // First-login bootstrap: if allowed_user is empty AND the GitHub user's
  // login matches this value, they're inserted automatically. Subsequent
  // logins use the table normally.
  BOOTSTRAP_ALLOWED_LOGIN: string
  // Required for /webhook/github; the route returns 503 until it is set.
  GITHUB_WEBHOOK_SECRET?: string
  // Optional GitHub token (secret) for the trees/blobs/contents lookups the
  // pipeline stage-hashing makes at webhook time. Without it, unauthenticated
  // calls share the worker egress IP's 60/hr limit and hashing degrades to
  // the coarse rebuild-everything plan more often.
  GITHUB_API_TOKEN?: string
  SESSION_SECRET: string
  ENABLE_DEBUG_ROUTES?: string

  // Runner provisioning. RUNNER_PROVIDER selects the implementation:
  // 'stub' (default; fabricates events into the PR object's log) or 'digitalocean'.
  RUNNER_PROVIDER?: string
  // DigitalOcean provider config. DO_API_TOKEN is a secret; the rest are
  // plain vars. The runner image builds and caches itself from stock Ubuntu
  // (src/worker/runner/image.ts); RUNNER_IMAGE is an OPTIONAL pin that
  // bypasses the self-built snapshot — the escape hatch. PUBLIC_BASE_URL is
  // this deployment's origin (e.g. https://scenetest-cloud.example.workers.dev)
  // — the box needs it to reach the ingest API.
  DO_API_TOKEN?: string
  RUNNER_REGION?: string
  RUNNER_SIZE?: string
  RUNNER_IMAGE?: string
  PUBLIC_BASE_URL?: string
  // Hung-box backstop: hard cap on box lifetime in minutes (default 30). The
  // reaper destroys anything older regardless of run state, catching boxes the
  // idle alarm never retired (a crashed object, a run that never settled).
  RUNNER_MAX_AGE_MINUTES?: string
  // Hosted preview environments (docs/preview-environments.md). A PR whose
  // pipeline file declares a `preview` block waits for a Supabase preview
  // branch, then writes its keys to the project's Cloudflare preview Worker.
  // PREVIEW_PROVIDER selects the implementation: unset (the feature is off and
  // a declared preview fails the run with that reason), 'supabase-cloudflare',
  // or 'stub' (dev and e2e: ready after one poll, no external calls).
  PREVIEW_PROVIDER?: string
  // Give up on a preview that never becomes ready (default 20). The PR's
  // queued runs then fail with the last thing the reconciler was waiting on.
  PREVIEW_TIMEOUT_MINUTES?: string
  // How often the PR object re-checks a building preview (default 20).
  PREVIEW_POLL_SECONDS?: string
  // Supabase personal access token (secret), scopes environment:write and
  // secrets:read — it creates the preview branch and reads its API keys.
  SUPABASE_ACCESS_TOKEN?: string
  // Cloudflare API token (secret) with Workers Scripts:Edit, and the account
  // the preview Workers live in.
  CLOUDFLARE_API_TOKEN?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  // Primary teardown: idle window in minutes (default 5). The PR coordinator
  // resets a Durable Object alarm on every activity signal and retires the box
  // when the alarm fires with all the PR's runs settled (PrCoordinator.alarm).
  RUNNER_IDLE_TIMEOUT_MINUTES?: string
}

// The one reading of the dev switch. /auth/dev-login, /api/debug/*, the
// `?session=` WebSocket fallback and /api/config must agree on it exactly: the
// dashboard offers the dev sign-in button whenever this is true, and a button
// that 404s is worse than no button.
export function devRoutesEnabled(env: Env): boolean {
  return env.ENABLE_DEBUG_ROUTES === '1'
}

export interface AuthedUser {
  github_id: number
  github_login: string
}
