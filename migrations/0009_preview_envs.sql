-- Hosted preview environments (docs/preview-environments.md).
--
-- A PR whose pipeline file declares a `preview` block gets one Supabase
-- preview branch and one Cloudflare preview Worker. Both are per-PR and
-- outlive any single run, like the box — so this table is keyed by PR, and
-- the row is deleted when the PR closes.
--
-- What is NOT here: the Supabase keys. The reconciler reads them, writes them
-- to the preview Worker, and drops them. Only the values the pipeline file
-- asks to hand to the scenes command are kept (scene_env_json), because every
-- later run on this PR needs them again.
CREATE TABLE preview_envs (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  git_branch TEXT NOT NULL,      -- the PR's head ref; Supabase keys its branch by this
  config_json TEXT NOT NULL,     -- the pipeline file's `preview` block, as planned for head_sha
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,          -- 'building' | 'ready' | 'failed'
  branch_id TEXT,                -- Supabase branch uuid
  branch_ref TEXT,               -- the branch's own project ref ('<ref>.supabase.co')
  worker_name TEXT,              -- the Cloudflare Worker the secrets were written to
  preview_url TEXT,              -- that Worker's workers.dev URL
  scene_env_json TEXT,           -- resolved env handed to the box with each dispatch
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL,     -- give up here and fail the PR's runs
  ready_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, pr_number),
  FOREIGN KEY (repo, pr_number) REFERENCES prs(repo, pr_number) ON DELETE CASCADE
);

-- The head ref, from the pull_request payload. Supabase branching matches its
-- preview branch to a git branch by name, so the PR's own branch name is the
-- join key between a PR here and a preview branch there. Nullable: rows
-- written before this column have none, and the next push fills it in.
ALTER TABLE prs ADD COLUMN head_ref TEXT;
