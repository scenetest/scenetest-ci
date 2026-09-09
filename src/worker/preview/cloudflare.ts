import type { Env } from '../env.ts'

// Cloudflare API, the Workers subset needed to point a preview Worker at a
// preview database. CLOUDFLARE_API_TOKEN needs Workers Scripts:Edit on the
// account in CLOUDFLARE_ACCOUNT_ID.

const API = 'https://api.cloudflare.com/client/v4'

interface CfEnvelope<T> {
  success: boolean
  result: T
  errors?: Array<{ code: number; message: string }>
}

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN ?? ''}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const body = (await resp.json().catch(() => null)) as CfEnvelope<T> | null
  if (!resp.ok || !body?.success) {
    const detail = body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? resp.status
    throw new Error(`cloudflare ${init.method ?? 'GET'} ${path}: ${detail}`)
  }
  return body.result
}

// Whether the preview Worker exists yet. It is deployed by the project's own
// pipeline (Workers Builds, or a wrangler step), not by scenetest-cloud — so
// a missing script means "not deployed yet", which is a wait, not an error.
export async function workerExists(env: Env, script: string): Promise<boolean> {
  const resp = await fetch(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}`, {
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN ?? ''}` },
  })
  if (resp.status === 404) return false
  if (!resp.ok) throw new Error(`cloudflare GET workers/scripts/${script}: ${resp.status}`)
  return true
}

// Write one secret to the Worker. Cloudflare applies it to the script's
// current version, so the next request to the Worker sees the new value.
export async function putSecret(
  env: Env,
  script: string,
  name: string,
  text: string,
): Promise<void> {
  await call(env, `/workers/scripts/${script}/secrets`, {
    method: 'PUT',
    body: JSON.stringify({ name, text, type: 'secret_text' }),
  })
}

export async function accountSubdomain(env: Env): Promise<string> {
  const result = await call<{ subdomain: string }>(env, '/workers/subdomain')
  return result.subdomain
}

export function workersDevUrl(script: string, subdomain: string): string {
  return `https://${script}.${subdomain}.workers.dev`
}
