# Preview environments

Some projects can't be tested from a server on the box. The app under test is
a Cloudflare Worker, its database is a hosted Supabase project, and a PR's
real environment is a preview Worker talking to a Supabase preview branch.
Both are built by the project's own tooling — Supabase branching on the git
branch, Workers Builds on the push — and both take minutes.

Scenetest Cloud's job is the seam between them: wait for the preview branch to
finish building, write its keys to the preview Worker, and hold the PR's scene
batches until that has happened. Without the wait, the scenes run against a
Worker still pointing at the last PR's database, or at nothing.

## What a PR gets

One preview environment per PR, keyed by the PR the same way its box is:

- **A Supabase preview branch**, matched to the PR's own git branch. Created
  on the first push if the project has none for that branch, reused after.
- **The project's Cloudflare preview Worker**, whose secrets are rewritten
  with the branch's URL and keys once the branch is healthy.
- **The scenes command's environment**, so Playwright knows which URL to open.

The environment outlives a run and follows the PR. A push re-opens it: the
branch re-runs its migrations, the Worker redeploys, and the values are read
and written again.

## Declaring one

In `scenetest/pipeline.json`, beside `stages` and `scenes`:

```json
{
  "version": 1,
  "preview": {
    "supabase": { "project_ref": "abcdefghijklmnopqrst", "with_data": false },
    "cloudflare": {
      "worker": "sunlo-pr-{pr}",
      "secrets": {
        "SUPABASE_URL": "url",
        "SUPABASE_SERVICE_ROLE_KEY": "service_role_key"
      }
    },
    "scene_env": {
      "BASE_URL": "preview_url",
      "VITE_SUPABASE_URL": "url",
      "VITE_SUPABASE_ANON_KEY": "anon_key"
    }
  },
  "stages": [
    { "name": "deps", "watch": ["pnpm-lock.yaml"], "run": "pnpm install --frozen-lockfile" }
  ],
  "scenes": "pnpm exec scenetest"
}
```

- `supabase.project_ref` — the parent project the preview branch forks from.
- `supabase.with_data` — copy the parent's data into the branch. Default false.
- `supabase.region` — optional; the branch follows the parent's region without it.
- `cloudflare.worker` — the preview Worker's script name. `{pr}` is the PR
  number and `{branch}` the git branch flattened to lowercase and dashes.
- `cloudflare.secrets` — environment variable name → field, written to that
  Worker as secrets.
- `scene_env` — environment variable name → field, handed to the scenes
  command on the box.

The fields either map can name:

| Field | What it is |
| --- | --- |
| `url` | The branch's API URL, `https://<branch ref>.supabase.co` |
| `anon_key` | The branch's anon (publishable) key |
| `service_role_key` | The branch's service role (secret) key |
| `db_url` | Session-mode connection string; empty if the API withholds the credentials |
| `branch_ref` | The branch's own project ref |
| `preview_url` | The preview Worker's `workers.dev` URL |
| `pr` | The PR number |
| `branch` | The PR's git branch |

The `preview` block rides the pipeline file, so editing it rebuilds the box
like any other pipeline change.

## What happens on a push

1. The webhook creates the run and the box as usual, and opens the preview
   environment for the PR's head commit.
2. The PR's Durable Object holds the batch. Stage updates still go to the box:
   it builds while the environment does.
3. Every `PREVIEW_POLL_SECONDS` (default 20) the object asks the reconciler for
   one step. A step reads the branch, and — once the branch is healthy, its
   migrations have passed, and the preview Worker exists — reads the keys,
   writes them to the Worker, and resolves the scene variables.
4. Ready: the held batches go to the box with `scene_env` merged into the
   scenes command's environment.
5. Failed, or still building at `PREVIEW_TIMEOUT_MINUTES` (default 20): the
   PR's unfinished runs fail with the reason, and the commit status says
   "Preview environment failed: …".

A closed PR deletes its Supabase branch. The Worker is left alone: the
project's own deploy created it, so the project's own deploy retires it.

## Setting it up

On the deployment, once:

```
wrangler secret put SUPABASE_ACCESS_TOKEN   # scopes: environment:write, secrets:read
wrangler secret put CLOUDFLARE_API_TOKEN    # permission: Workers Scripts:Edit
```

and in `wrangler.toml` `[vars]`:

```toml
PREVIEW_PROVIDER = "supabase-cloudflare"
CLOUDFLARE_ACCOUNT_ID = "…"                 # the account the preview Workers live in
```

With `PREVIEW_PROVIDER` unset, a repo that declares a preview fails its runs
with that as the reason — a declared environment is never skipped silently.

For the project itself: turn on Supabase branching (the GitHub integration
that creates a preview branch per git branch), and deploy the preview Worker
from the PR — Workers Builds, or a `wrangler deploy --name` step in the
project's own CI. Scenetest Cloud waits for that Worker; it never creates one.

## Where the keys go

The reconciler reads the branch's keys, writes them to the Worker, and drops
them. D1 keeps the branch ref, the Worker name, the preview URL — and the
`scene_env` values, because every later run on the PR needs them again. So a
key named in `cloudflare.secrets` only passes through memory; a key named in
`scene_env` is stored for the life of the PR and travels to the box with each
dispatch. Name in `scene_env` only what the scenes actually need.

## Dev and e2e

`PREVIEW_PROVIDER=stub` resolves a declared environment without calling
Supabase or Cloudflare: building on the first poll, ready on the second, with
values that name themselves. The debug routes (`ENABLE_DEBUG_ROUTES=1`) drive
it: `POST /api/debug/preview-start` opens one for a PR, `POST
/api/debug/preview-step` runs a poll now instead of waiting for the alarm, and
`GET /api/debug/preview?repo=…&prNumber=…` shows both the reconciler's row and
the PR object's gate. `pnpm e2e` uses all three.
