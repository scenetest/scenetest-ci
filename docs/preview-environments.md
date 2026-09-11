# Preview environments

Some projects deploy the thing they test. The app is a Cloudflare Worker, its
database is a hosted Supabase project, and a PR's environment is a preview
Worker talking to a Supabase preview branch. Supabase branching builds the
branch on a push to the git branch; Workers Builds deploys the Worker. Neither
one tells the other anything, so the preview Worker has no idea which database
it just got.

Scenetest Cloud closes that gap and nothing else: wait until the PR's preview
branch will hand out its keys, then write them to the PR's preview Worker.

**This does not touch the box.** A PR's scenes build and run exactly as they
would without a preview environment — no waiting, no variables passed, no
coupling in either direction. The two are separate features that happen to
share a PR.

## What a PR gets

- **A Supabase preview branch**, matched to the PR's own git branch. Created
  on the first push if the project has none for that branch, reused after.
- **Its keys written to the project's Cloudflare preview Worker**, as Worker
  secrets, under whatever names the project wants them.
- **A commit status** on its own `scenetest/preview` context, so an
  environment that failed to build says so on the PR without ever being
  confused for a verdict about the code.

The environment follows the PR, and a push re-opens it: the branch re-runs its
migrations, the project redeploys its Worker, and a redeployed Worker is one
whose secrets are worth writing again.

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
        "SUPABASE_ANON_KEY": "anon_key",
        "SUPABASE_SERVICE_ROLE_KEY": "service_role_key"
      }
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
- `cloudflare.secrets` — secret name → field, written to that Worker.

The fields a secret can name:

| Field | What it is |
| --- | --- |
| `url` | The branch's API URL, `https://<branch ref>.supabase.co` |
| `anon_key` | The branch's anon (publishable) key |
| `service_role_key` | The branch's service role (secret) key |
| `db_url` | Session-mode connection string; empty if the API withholds the credentials |
| `branch_ref` | The branch's own project ref |
| `preview_url` | The Worker's `workers.dev` URL (fetched only if a secret asks for it) |
| `pr` | The PR number |
| `branch` | The PR's git branch |

The `preview` block rides the pipeline file, so editing it rebuilds the box
like any other pipeline change — the one incidental tie between the two, and
only because they share a file.

## What it waits for

The branch's **keys**, not its schema. A branch project's keys exist as soon
as the project does, and migrations don't change them, so there is nothing to
gain by holding the handover until the migrations pass — the Worker would
spend those minutes pointed at the *previous* PR's database instead of at its
own.

The consequence, stated plainly: for a minute or two the preview Worker talks
to a branch whose migrations are still running, and the app sees tables that
don't exist yet. That is a better failure than silently reading the wrong
database, and with the box decoupled nothing is asserting against it.

A step therefore goes: find or create the branch → ask it for keys, and come
back later if it has none yet → check the preview Worker exists (the project
deploys it, this never does) → write the secrets → done. Only a branch project
that failed to come up or is gone (`INIT_FAILED`, `REMOVED`, …) fails the
environment outright; failed *migrations* do not, because the keys still work.

## The schedule

One Durable Object per PR with a preview environment, and it owns exactly one
thing: the clock. It polls every `PREVIEW_POLL_SECONDS` (default 20) and stops
as soon as the environment settles. `PREVIEW_TIMEOUT_MINUTES` (default 20) is
the give-up point, and the cron sweep re-pokes anything that has been building
and untouched for five minutes, in case an object lost its alarm.

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

With `PREVIEW_PROVIDER` unset, a repo that declares a preview marks the
environment failed with that as the reason — a declared environment is never
skipped silently.

For the project itself: turn on Supabase branching (the GitHub integration
that creates a preview branch per git branch), and deploy the preview Worker
from the PR — Workers Builds, or a `wrangler deploy --name` step in the
project's own CI.

## Where the keys go

Nowhere but the Worker. The reconciler reads them, writes them, and drops
them. D1 keeps the branch ref, the Worker name, and the preview URL — enough
to find the same two things on the next push, and nothing that unlocks
anything.

## Dev and e2e

`PREVIEW_PROVIDER=stub` resolves a declared environment without calling
Supabase or Cloudflare: no keys on the first poll, ready on the second. The
debug routes (`ENABLE_DEBUG_ROUTES=1`) drive it: `POST
/api/debug/preview-start` opens one for a PR, `POST /api/debug/preview-step`
runs a poll now instead of waiting for the alarm, and `GET
/api/debug/preview?repo=…&prNumber=…` shows the row and what the object last
decided. `pnpm e2e` uses all three.
