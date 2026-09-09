import { devRoutesEnabled, type Env } from './env.ts'
import { Router } from './router.ts'
import {
  prDashboardWs,
  postPrCommand,
  getRunLog,
  homeDashboardWs,
  listPrRuns,
  getPrRunReport,
} from './scenetest-bridge/routes.ts'
import { postEvents, postRunComplete } from './routes/runner-ingest.ts'
import {
  debugStubRun,
  debugBoxUpdate,
  debugBoxDispatch,
  debugResetPrLog,
  debugIdleCheck,
  debugPreview,
  debugPreviewStart,
  debugPreviewStep,
} from './routes/debug.ts'
import { postGithubWebhook } from './routes/webhook-github.ts'
import { boxChannel, boxReady } from './routes/box-channel.ts'
import { tick } from './runner/tick.ts'

export { PrCoordinator } from './do/pr-coordinator.ts'
export { HomeCoordinator } from './do/home-coordinator.ts'
import {
  getGithubLogin,
  getGithubCallback,
  postLogout,
} from './auth/github-oauth.ts'
import {
  addRepo,
  addUser,
  deleteRepo,
  repoStatus,
  deleteUser,
  listRepos,
  listUsers,
} from './routes/admin.ts'
import { withSession } from './auth/session.ts'
import { getDevLogin } from './auth/dev-login.ts'
import { devOnly } from './middleware/dev-only.ts'
import { getConfig } from './routes/config.ts'
import { getOverview, getRepoPrs } from './routes/cloud.ts'

// Auth is declared per route: withSession() for cookie-authed routes (json
// 401 or login redirect on failure), devOnly() for routes that must not exist
// outside local dev; everything else is either public by design (/auth/*) or
// carries its own auth (bearer for runner ingest, HMAC for webhooks).
const router = new Router()
  // Auth
  .get('/auth/github/login', getGithubLogin)
  .get('/auth/github/callback', getGithubCallback)
  .post('/auth/logout', postLogout)
  // Local dev sign-in, no GitHub round trip.
  .get('/auth/dev-login', devOnly(getDevLogin))
  .get('/api/config', getConfig)
  .get('/api/me', withSession((_req, _env, _ctx, _params, user) => Response.json(user)))
  // Admin
  .get('/api/admin/users', withSession(listUsers))
  .post('/api/admin/users', withSession(addUser))
  .delete('/api/admin/users/:github_id', withSession(deleteUser))
  .get('/api/admin/repos', withSession(listRepos))
  .post('/api/admin/repos', withSession(addRepo))
  .delete('/api/admin/repos/:owner/:name', withSession(deleteRepo))
  .get('/api/admin/repos/:owner/:name/status', withSession(repoStatus))
  // Cloud dashboard data
  .get('/api/cloud/overview', withSession(getOverview))
  .get('/api/cloud/repos/:owner/:name', withSession(getRepoPrs))
  // PR-anchored viewer stream: the whole PR's events over one WebSocket — the
  // only viewer. The PR is the unit; there is no run-scoped page or stream.
  .get('/api/cloud/repos/:owner/:name/pr/:number/ws', prDashboardWs)
  // Home view live layer: one cross-PR WebSocket served by the HomeCoordinator
  // (owns its auth, like the PR viewer — cookie always; ?session= dev-gated).
  .get('/api/cloud/home/ws', homeDashboardWs)
  // The PR's runs, and one run's folded report. The widget's run picker lists
  // the first and renders the second — it is how a finished run is read back
  // once its events have gone by (the `?run=<id>` deep link).
  .get('/api/cloud/repos/:owner/:name/pr/:number/runs', withSession(listPrRuns))
  .get('/api/cloud/repos/:owner/:name/pr/:number/runs/:runId', withSession(getPrRunReport))
  // Commands are PR-scoped: the PR names the coordinator, the run (if any) is a
  // field in the body, not the address.
  .post('/api/cloud/repos/:owner/:name/pr/:number/commands', withSession(postPrCommand))
  // Per-run resource: the raw log download (runId names a real artifact here).
  .get('/api/runs/:runId/log', withSession(getRunLog))
  // GitHub webhooks (HMAC-authed inside the handler)
  .post('/webhook/github', postGithubWebhook)
  // Box channel + readiness (bearer-authed inside the handlers)
  .get('/api/boxes/:boxId/channel', boxChannel)
  .post('/api/boxes/:boxId/ready', boxReady)
  // Runner ingest (bearer-authed). scene_executions are no longer reported by
  // the box: the PR coordinator derives them from the event stream (#36).
  // /complete stays as the terminal-state backstop (a non-zero exit with no
  // run:end event).
  .post('/api/events/:runId', postEvents)
  .post('/api/runs/:runId/complete', postRunComplete)
  // Debug
  .post('/api/debug/stub-run', devOnly(debugStubRun))
  .post('/api/debug/box-update', devOnly(debugBoxUpdate))
  .post('/api/debug/box-dispatch', devOnly(debugBoxDispatch))
  .post('/api/debug/reset-pr-log', devOnly(debugResetPrLog))
  .post('/api/debug/idle-check', devOnly(debugIdleCheck))
  .get('/api/debug/preview', devOnly(debugPreview))
  .post('/api/debug/preview-start', devOnly(debugPreviewStart))
  .post('/api/debug/preview-step', devOnly(debugPreviewStep))

const REQUIRED_VARS = ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'] as const

// One list, minus what the mode makes optional: with debug routes on,
// /auth/dev-login replaces the GitHub round trip, so the OAuth credentials are
// not needed to sign in. SESSION_SECRET stays required in both modes by
// construction — it signs the cookie either way.
function missingConfig(env: Env): string[] {
  const optional = devRoutesEnabled(env) ? (k: string) => k.startsWith('GITHUB_OAUTH') : () => false
  return REQUIRED_VARS.filter((k) => !env[k] && !optional(k))
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const missing = missingConfig(env)
    if (missing.length > 0) {
      return new Response(
        `Missing config: ${missing.join(', ')}. Set in .dev.vars (local) or via wrangler vars/secrets.`,
        { status: 500 },
      )
    }

    try {
      const path = new URL(req.url).pathname
      if (
        path.startsWith('/api/') ||
        path.startsWith('/auth/') ||
        path.startsWith('/webhook/')
      ) {
        return await router.handle(req, env, ctx)
      }
      // Everything else is the SPA shell — public. The SPA decides what to
      // render (signed-in vs not, 404s) client-side.
      return env.ASSETS.fetch(req)
    } catch (err) {
      const requestId = crypto.randomUUID()
      console.error(`[req ${requestId}]`, err instanceof Error ? err.stack ?? err.message : err)
      if (new URL(req.url).pathname.startsWith('/api/')) {
        return Response.json({ error: 'internal_error', requestId }, { status: 500 })
      }
      return new Response(`Internal error (request ${requestId})`, { status: 500 })
    }
  },

  // Cron (see wrangler.toml [triggers]): advance image builds, provision
  // boxes that were waiting on them, reap dead droplets. No-ops unless the
  // DO provider is configured.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env))
  },
}
