# The pipeline file

`scenetest/pipeline.json`, in **your** repo (the app being tested). It tells
scenetest-cloud what it takes to make a test machine ready for your app, and
— more importantly — what it *doesn't* have to redo when you push.

This page is written to be handed directly to a person or an LLM setting up
a repo. The system design behind it is in
[architecture.md](./architecture.md) ("The build pipeline").

## The mental model (read this even if you read nothing else)

Your PR gets one warm machine (a "box"). Every push, scenetest decides what
work the box actually needs by hashing the files each stage *watches*:

- Stage hashes chain: a stage's identity includes its parent's, so a change
  early in the list re-runs everything after it.
- If no watched file changed (docs, README, a rebase), **nothing runs** —
  scenes execute against the already-ready box in seconds.
- If `pnpm-lock.yaml` alone changed, only `deps` and the stages after it
  run. Your database doesn't reset because you added a dependency — unless
  you ordered it after `deps`, which you did on purpose (schema → types →
  build).

The stages are a **flat list that runs in order**. There are no triggers, no
conditionals, no DAG, no expressions. If you need those, you have a build
tool — call it from a `run` line.

## Schema (version 1)

```json
{
  "version": 1,
  "stages": [
    { "name": "deps",  "watch": ["pnpm-lock.yaml"],            "run": "pnpm install --frozen-lockfile" },
    { "name": "db",    "watch": ["supabase/**"],               "run": "supabase start && supabase db reset" },
    { "name": "build", "watch": ["src/**", "*.config.*"],      "run": "pnpm build" },
    { "name": "serve", "watch": [],                            "run": "(pnpm preview --port 4173 &) && sleep 2" }
  ],
  "scenes": "pnpm exec scenetest"
}
```

Top-level `scenes` is **how one batch of scenes executes** — deliberately
not a stage: stages are content-addressed and skipped when nothing changed,
while scene batches run on dispatch (every push, every manual re-run,
subsets, different teams). It still lives in this file, so there is exactly
one repo-side contract; editing it re-runs the pipeline like any other edit
to this file. When omitted it falls back to the legacy hook,
`bash scenetest/box-run.sh`.

An optional top-level `preview` block says the scenes run against a hosted
preview — a Cloudflare Worker backed by a Supabase preview branch — instead of
a server this box started. The run then waits for that environment before any
scene executes. Fields and setup: docs/preview-environments.md.

The box runs this command at the repo root and sets these for it:

| Variable | Meaning |
|---|---|
| `SCENETEST_RUN_ID` | id of this batch |
| `SCENETEST_REPORT_URL` | where the scenes CLI streams its events — already wired to the box's live relay, so `pnpm exec scenetest` reports to the dashboard with no flags |
| `SCENETEST_SUBSET` | JSON array of scene ids this batch wants, empty = all (advisory; the CLI has no `--subset`, so a command that subsets expands this to positional scene paths) |
| `SCENETEST_LOCAL_INGEST` | base of the local relay (same body as the cloud API), for commands that POST events themselves |

`@scenetest/scenes` ≥ 0.15 reads `SCENETEST_REPORT_URL` (or `--report-url
<url>`) and POSTs its protocol events there as the run executes — so the
command is just `pnpm exec scenetest`, no HTTP plumbing of your own. A
non-zero exit marks the run failed; otherwise the `run:end` event the CLI
emits settles passed/failed from its summary.

Per stage:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | `[a-z0-9_-]`, max 32 chars, unique in the file |
| `watch` | no (default `["**"]`) | globs over repo paths; a change in any matched file re-runs this stage and everything after it. `[]` = re-runs only when an earlier stage does (or this file / the toolchain changes) |
| `run` | no | one shell line, executed at the repo root on the box. Multi-step? Point at a script in your repo: `"bash scenetest/db.sh"` |

Reserved for future versions, accepted and ignored today: `save`, `restore`
(per-stage artifact caching), `toolchain` (per-project machine image).
Writing them now is harmless.

Glob rules (deliberately minimal): `**` crosses directories, `*` stays
within one path segment, everything else is literal. `supabase/**` matches
files under `supabase/`; `*.md` matches `README.md` but **not**
`docs/notes.md`. No negation, no braces.

## Rules of thumb

1. **Order by cost and dependency, expensive first**: deps → db → build →
   serve. The schema generates types your build consumes, so db sits before
   build.
2. **Watch inputs, not outputs.** Watch `pnpm-lock.yaml`, never
   `node_modules`; watch `src/**`, never `dist/**`. (Outputs aren't in git,
   so watching them does nothing — listed here because everyone tries.)
3. **Too coarse is slow; too narrow is wrong.** A glob that over-matches
   wastes minutes; one that under-matches ships a stale box that lies to
   you. When unsure, widen. The system's own failures degrade the same
   direction: if it can't compute hashes at all, it rebuilds everything.
4. **Editing `pipeline.json` re-runs every stage.** The file is one of its
   own inputs. This is also the lever: pushing a whitespace change to it is
   a full rebuild on demand.
5. **The machine itself is not yours to define (yet).** Node, pnpm, docker,
   the supabase CLI, and Playwright system libraries are preinstalled in the
   box image. Need an extra apt package today? Install it in a `run` line.
   When that's too slow, the `toolchain` field is the planned fix.
6. **No file = everything coarse.** Without `pipeline.json`, every push
   rebuilds the whole box (running `scenetest/box-setup.sh` if present).
   Correct, just slower — adding the file is pure optimization.

What stages can rely on: repo checked out at the PR's head commit (cwd =
repo root, public repos only for now), previous stages' effects present
(warm box) or freshly re-run, and a non-zero exit failing the box — the
next push provisions a fresh one. Scene batches arrive separately after
the pipeline is ready, via the top-level `scenes` command above (the box
sets `SCENETEST_REPORT_URL` so the CLI streams results back).

## For LLMs setting up a repo

Do this, in order:

1. Find the lockfile (`pnpm-lock.yaml` / `package-lock.json` /
   `yarn.lock`) → that's the `deps` stage's `watch`, and the matching
   frozen-lockfile install is its `run`.
2. Find the database directory (`supabase/`, `prisma/`, `drizzle/`,
   `migrations/`) → the `db` stage: watch the whole directory, `run` the
   project's reset command (for supabase: `supabase start && supabase db
   reset` — `start` is idempotent).
3. Find the build (`package.json` scripts: `build`, plus typegen if the
   project runs one) → the `build` stage: watch source dirs and config
   files (`src/**`, `*.config.*`, `tsconfig*.json`, `public/**` if used).
4. Add a `serve` stage that starts the app on a port in the background and
   returns (the run line must exit; `(cmd &)` + a readiness sleep or
   wait-on is fine).
5. Set top-level `scenes`: run the scenes CLI (`pnpm exec scenetest`). The
   box sets `SCENETEST_REPORT_URL`, so the CLI (`@scenetest/scenes` ≥ 0.15)
   streams events to the dashboard automatically — no flag, no event file.
   Point the scenes at the served app via your Playwright/scene config, not
   a CLI flag.
6. Do **not**: watch generated/output paths; combine unrelated concerns
   into one stage; write conditionals into `run` lines to simulate
   branching (the watch globs are the conditional); invent stages the repo
   doesn't need.
7. Validate: the file is strict JSON, `version` is the number 1, stage
   names are unique `[a-z0-9_-]`. A file that fails validation is ignored
   (the repo silently gets the coarse default), so prefer fewer, simpler
   stages over clever ones.
8. Sanity-check your globs against the repo tree: for each stage ask "which
   files, when edited, should re-run this?" and confirm the globs match
   exactly those files. Then check the cascade reads sensibly: a lockfile
   change should hit `deps`+`db`+`build`+`serve`; a `src/` change only
   `build`+`serve`; a docs change nothing.

## Troubleshooting

- **Run started but scenes see stale code** → some source path isn't
  watched by `build` (or anything). Widen the glob; rule 3.
- **Everything rebuilds every push** → either no/invalid `pipeline.json`
  (check it parses, `version: 1`), or stage hashing fell back to coarse —
  the operator can set `GITHUB_API_TOKEN` on the deployment to lift GitHub
  API rate limits (see [setup.md](./setup.md)).
- **Force a full rebuild** → push any edit to `pipeline.json`.
- **A stage failed** → the box is retired and the run cancelled; fix the
  command and push. Stage output appears in the worker logs today (in-run
  build logs are planned).
