import { expect, test } from "bun:test"
import { checkoutPr, findWorktree, needsPrompt, openWorktree, worktreeDir } from "./checkout"
import { demoBuckets, type PR } from "./data"
import { parseRepo } from "./repo"
import type { Run, RunResult } from "./run"

const repo = parseRepo("cli/cli")
const home = "/home/me"
const pr: PR = { ...demoBuckets(repo)[0]!.prs[0]!, number: 42, branch: "babakks/fix-tokens" }

// A fake `run` that records every command and answers from a table keyed by "cmd arg1 arg2...".
// Nothing is ever executed, so no branch is checked out and no worktree is created.
function fakeRun(answers: Record<string, Partial<RunResult>> = {}) {
  const calls: { cmd: string; interactive: boolean }[] = []
  const run: Run = async (cmd, args, opts) => {
    const line = [cmd, ...args].join(" ")
    calls.push({ cmd: line, interactive: !!opts?.interactive })
    return { code: 0, stdout: "", stderr: "", ...answers[line] }
  }
  return { run, calls, cmds: () => calls.map(c => c.cmd) }
}

const porcelain = `worktree /home/me/src/cli
HEAD 1111111111111111111111111111111111111111
branch refs/heads/trunk

worktree /home/me/worktrees/cli/babakks-fix-tokens
HEAD 2222222222222222222222222222222222222222
branch refs/heads/babakks/fix-tokens

worktree /home/me/worktrees/cli/detached
HEAD 3333333333333333333333333333333333333333
detached
`

const NEW_GH = { stdout: "Flags:\n  -b, --branch string\n      --worktree path   Check out the pull request into a worktree\n" }
const OLD_GH = { stdout: "Flags:\n  -b, --branch string\n  -f, --force\n" }
const CHECKOUT = "gh pr checkout 42 -R github.com/cli/cli --worktree=/home/me/worktrees/cli/babakks-fix-tokens --branch=babakks/fix-tokens"

test("worktreeDir flattens the branch like `wa`, under the repo's name", () => {
  expect(worktreeDir(repo, "babakks/fix/tokens", home)).toBe("/home/me/worktrees/cli/babakks-fix-tokens")
  expect(worktreeDir(repo, "main", home)).toBe("/home/me/worktrees/cli/main")
})

test("findWorktree matches the exact branch", () => {
  expect(findWorktree(porcelain, "trunk")).toBe("/home/me/src/cli")
  expect(findWorktree(porcelain, "babakks/fix-tokens")).toBe("/home/me/worktrees/cli/babakks-fix-tokens")
  expect(findWorktree(porcelain, "babakks/fix")).toBeUndefined()
  expect(findWorktree("", "trunk")).toBeUndefined()
})

test("c runs gh pr checkout against the repo on screen, with the terminal", async () => {
  const f = fakeRun()
  expect(await checkoutPr(pr, repo, f.run)).toBe("Checked out PR #42")
  expect(f.calls).toEqual([{ cmd: "gh pr checkout 42 -R github.com/cli/cli", interactive: true }])
})

test("c reports git's error line, not its fetch progress", async () => {
  const stderr = [
    "From github.com:cli/cli",
    " * [new ref]  refs/pull/42/head -> babakks/fix-tokens",
    "error: Your local changes to the following files would be overwritten by checkout:",
    "\tREADME.md",
    "Aborting",
    "failed to run git: exit status 1",
  ].join("\n")
  const f = fakeRun({ "gh pr checkout 42 -R github.com/cli/cli": { code: 1, stderr } })
  await expect(checkoutPr(pr, repo, f.run)).rejects.toThrow(/^error: Your local changes/)

  const bare = fakeRun({ "gh pr checkout 42 -R github.com/cli/cli": { code: 1 } })
  await expect(checkoutPr(pr, repo, bare.run)).rejects.toThrow("gh pr checkout exited with code 1")
})

test("c reports the prompt it couldn't show, so the error can point at --show-git-prompt", async () => {
  const stderr = [
    "git@github.com: Permission denied (publickey).",
    "fatal: Could not read from remote repository.",
    "",
    "Please make sure you have the correct access rights",
    "failed to run git: exit status 128",
  ].join("\n")
  const f = fakeRun({ "gh pr checkout 42 -R github.com/cli/cli": { code: 1, stderr } })
  await expect(checkoutPr(pr, repo, f.run)).rejects.toThrow("git@github.com: Permission denied (publickey).")

  for (const msg of ["Host key verification failed.", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"]) {
    expect(needsPrompt(msg)).toBe(true)
  }
  expect(needsPrompt("fatal: not a git repository")).toBe(false)
})

test("c without gh installed says so", async () => {
  const run: Run = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }
  await expect(checkoutPr(pr, repo, run)).rejects.toThrow("gh is not installed")
})

test("w creates the worktree with gh and reports where, outside tmux", async () => {
  const f = fakeRun({ "git worktree list --porcelain": { stdout: porcelain.split("\n\n")[0] }, "gh pr checkout --help": NEW_GH })
  expect(await openWorktree(pr, repo, { run: f.run, tmux: false, home })).toBe("Worktree at ~/worktrees/cli/babakks-fix-tokens")
  expect(f.calls).toEqual([
    { cmd: "git worktree list --porcelain", interactive: false },
    { cmd: "gh pr checkout --help", interactive: false },
    { cmd: CHECKOUT, interactive: true },
  ])
})

test("w inside tmux opens a window in the new worktree", async () => {
  const f = fakeRun({ "gh pr checkout --help": NEW_GH })
  expect(await openWorktree(pr, repo, { run: f.run, tmux: true, home })).toBe("Opened ~/worktrees/cli/babakks-fix-tokens in a new tmux window")
  expect(f.cmds().slice(-2)).toEqual([CHECKOUT, "tmux new-window -c /home/me/worktrees/cli/babakks-fix-tokens"])
})

test("w reuses a worktree that already has the branch, wherever it is", async () => {
  const f = fakeRun({ "git worktree list --porcelain": { stdout: porcelain } })
  expect(await openWorktree(pr, repo, { run: f.run, tmux: true, home })).toBe("Opened ~/worktrees/cli/babakks-fix-tokens in a new tmux window")
  expect(f.cmds()).toEqual(["git worktree list --porcelain", "tmux new-window -c /home/me/worktrees/cli/babakks-fix-tokens"])

  // The branch checked out in the main clone, outside ~/worktrees.
  const main = fakeRun({ "git worktree list --porcelain": { stdout: porcelain } })
  expect(await openWorktree({ ...pr, branch: "trunk" }, repo, { run: main.run, tmux: false, home })).toBe("Worktree already at ~/src/cli")
  expect(main.cmds()).toEqual(["git worktree list --porcelain"])
})

test("w passes gh the branch name from the PR (a fork's may carry an owner prefix)", async () => {
  const f = fakeRun({ "gh pr checkout --help": NEW_GH })
  await openWorktree({ ...pr, branch: "octo/trunk" }, repo, { run: f.run, tmux: false, home })
  expect(f.cmds().at(-1)).toBe("gh pr checkout 42 -R github.com/cli/cli --worktree=/home/me/worktrees/cli/octo-trunk --branch=octo/trunk")
})

test("w needs gh 2.98+, and runs nothing when gh is older", async () => {
  const f = fakeRun({ "gh pr checkout --help": OLD_GH })
  await expect(openWorktree(pr, repo, { run: f.run, tmux: true, home })).rejects.toThrow("w needs gh 2.98 or newer")
  expect(f.cmds()).toEqual(["git worktree list --porcelain", "gh pr checkout --help"])
})

test("w surfaces gh, git and tmux failures", async () => {
  const gitFails = fakeRun({ "git worktree list --porcelain": { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" } })
  await expect(openWorktree(pr, repo, { run: gitFails.run, tmux: false, home })).rejects.toThrow("fatal: not a git repository")

  const ghFails = fakeRun({ "gh pr checkout --help": NEW_GH, [CHECKOUT]: { code: 1, stderr: "--worktree path must be a directory: /home/me/worktrees/cli/babakks-fix-tokens\n" } })
  await expect(openWorktree(pr, repo, { run: ghFails.run, tmux: true, home })).rejects.toThrow("--worktree path must be a directory")
  expect(ghFails.cmds()).not.toContain("tmux new-window -c /home/me/worktrees/cli/babakks-fix-tokens")

  const tmuxFails = fakeRun({ "git worktree list --porcelain": { stdout: porcelain }, "tmux new-window -c /home/me/worktrees/cli/babakks-fix-tokens": { code: 1, stderr: "no server running on /tmp/tmux-1000/default" } })
  await expect(openWorktree(pr, repo, { run: tmuxFails.run, tmux: true, home })).rejects.toThrow("no server running")
})
