import type { Env } from '../env.ts'
import { getPreview, previewPollMs, stepPreview, type PreviewState } from '../preview/reconcile.ts'

// One Durable Object per PR with a hosted preview environment, and it owns
// exactly one thing: the clock. Building a Supabase preview branch takes
// minutes, so somebody has to come back and look again — this is that
// somebody, and its alarm is the only schedule in the feature.
//
// It is deliberately not the PR coordinator. Nothing about a preview
// environment reaches the box: the box builds and runs scenes as it always
// has, while this object walks the branch to ready and writes its keys to the
// project's Cloudflare Worker (docs/preview-environments.md).
//
// Internal HTTP surface (reachable only via the binding, never publicly):
//   POST /start   — { repo, prNumber } → poll this PR's environment to ready
//   POST /step    — one reconcile step now (test hook, and the cron backstop)
//   GET  /state   — what the last step decided

const PR_KEY = 'pr'

interface PrIdentity {
  repo: string
  prNumber: number
}

export class PreviewCoordinator implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/start' && req.method === 'POST') {
      // The DO can't read its own name, and the reconciler works in D1 rows
      // keyed by PR, so the identity is handed in here.
      const pr = (await req.json()) as PrIdentity
      await this.state.storage.put(PR_KEY, pr)
      // Now, not inline: /start is on the webhook's path, and a step makes
      // several API calls before it answers.
      await this.state.storage.setAlarm(Date.now())
      return Response.json({ ok: true })
    }

    if (url.pathname === '/step' && req.method === 'POST') {
      return Response.json(await this.step())
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      const pr = await this.state.storage.get<PrIdentity>(PR_KEY)
      if (!pr) return Response.json(null)
      return Response.json(await getPreview(this.env, pr.repo, pr.prNumber))
    }

    return new Response('Not Found', { status: 404 })
  }

  async alarm(): Promise<void> {
    await this.step()
  }

  // One step, then decide whether there is anything left to come back for. A
  // settled environment (ready or failed) arms no alarm: the next push starts
  // the cycle again through /start.
  private async step(): Promise<PreviewState | null> {
    const pr = await this.state.storage.get<PrIdentity>(PR_KEY)
    if (!pr) return null

    const state = await stepPreview(this.env, pr.repo, pr.prNumber).catch((err) => {
      console.error(`preview step(${pr.repo}#${pr.prNumber}) failed: ${err instanceof Error ? err.message : err}`)
      // An unexpected throw is not a verdict: come back and look again.
      return { status: 'building' } as PreviewState
    })

    if (state?.status === 'building') {
      await this.state.storage.setAlarm(Date.now() + previewPollMs(this.env))
    }
    return state
  }
}

// The object's name is the PR identity — one preview coordinator per PR,
// found by name from anywhere in the worker without a lookup table.
export function previewCoordinator(env: Env, repo: string, prNumber: number): DurableObjectStub {
  return env.PREVIEW_COORDINATOR.get(env.PREVIEW_COORDINATOR.idFromName(`${repo}#${prNumber}`))
}
