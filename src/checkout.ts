import { homedir } from "node:os"
import { join } from "node:path"
import type { PR } from "./data"
import type { Repo } from "./repo"
import type { Run, RunResult } from "./run"

// Both keys delegate to `gh pr checkout`, which already handles forks, remotes and upstream config
// (cli/cli pkg/cmd/pr/checkout). This module only decides what to ask it for.

const repoArg = (r: Repo) => `${r.host}/${r.owner}/${r.name}`

// ~/worktrees/<repo>/<branch>, with slashes in the branch flattened like the `wa` shell function.
export const worktreeDir = (repo: Repo, branch: string, home = homedir()) =>
  join(home, "worktrees", repo.name, branch.replaceAll("/", "-"))

// The path of the worktree that has `branch` checked out, from `git worktree list --porcelain`.
export function findWorktree(porcelain: string, branch: string): string | undefined {
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n")
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find(l => l.startsWith("worktree "))?.slice("worktree ".length)
  }
}

// What ssh and git print when they needed to prompt but couldn't (see RunOptions.noPrompts).
const PROMPT_NEEDED = /Permission denied \(publickey|Host key verification failed|terminal prompts disabled|can't open \/dev\/tty/
export const needsPrompt = (message: string) => PROMPT_NEEDED.test(message)

// git's fetch progress goes to stderr too, so prefer the line that explains the failure over the first one.
function failure(r: RunResult, what: string): Error {
  const lines = r.stderr.split("\n").map(l => l.trim()).filter(Boolean)
  const line = lines.find(needsPrompt) ?? lines.find(l => /^(error|fatal):/.test(l)) ?? lines.at(-1)
  return new Error(line ?? `${what} exited with code ${r.code}`)
}

async function gh(run: Run, args: string[], interactive = false) {
  try {
    return await run("gh", args, { interactive })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("gh is not installed (https://cli.github.com)")
    throw e
  }
}

export async function checkoutPr(pr: PR, repo: Repo, run: Run): Promise<string> {
  const r = await gh(run, ["pr", "checkout", String(pr.number), "-R", repoArg(repo)], true)
  if (r.code !== 0) throw failure(r, "gh pr checkout")
  return `Checked out PR #${pr.number}`
}

export interface WorktreeEnv {
  run: Run
  tmux: boolean // inside a tmux session ($TMUX is set)
  home?: string
}

// Reuses the worktree that already has the PR's branch, or creates one; then opens a tmux window there.
export async function openWorktree(pr: PR, repo: Repo, { run, tmux, home = homedir() }: WorktreeEnv): Promise<string> {
  const list = await run("git", ["worktree", "list", "--porcelain"])
  if (list.code !== 0) throw failure(list, "git worktree list")

  // gh doesn't check this, and `git worktree add` refuses a branch that's checked out elsewhere.
  let dir = findWorktree(list.stdout, pr.branch)
  const existed = dir !== undefined
  if (dir === undefined) {
    const help = await gh(run, ["pr", "checkout", "--help"])
    if (!`${help.stdout}${help.stderr}`.includes("--worktree")) {
      throw new Error("w needs gh 2.98 or newer (for gh pr checkout --worktree); please upgrade gh")
    }
    dir = worktreeDir(repo, pr.branch, home)
    // --branch pins the name we looked up above; `=` keeps a leading "-" from reading as a flag.
    const args = ["pr", "checkout", String(pr.number), "-R", repoArg(repo), `--worktree=${dir}`, `--branch=${pr.branch}`]
    const r = await gh(run, args, true)
    if (r.code !== 0) throw failure(r, "gh pr checkout")
  }

  const shown = dir === home || dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir
  if (tmux) {
    const t = await run("tmux", ["new-window", "-c", dir])
    if (t.code !== 0) throw failure(t, "tmux new-window")
    return `Opened ${shown} in a new tmux window`
  }
  return existed ? `Worktree already at ${shown}` : `Worktree at ${shown}`
}
