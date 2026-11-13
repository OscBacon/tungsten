#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { parseArgs } from "node:util"
import { App, type Actions } from "./app"
import { checkoutPr, needsPrompt, openWorktree } from "./checkout"
import { demoBuckets, type PR } from "./data"
import { fetchBuckets, matches, parseSearch } from "./github"
import type { Watch } from "./inbox"
import { watchRepos } from "./poll"
import { detectRepo, ghHosts, parseRepo, repoKey, repoLabel, type Repo } from "./repo"
import { run, type Run } from "./run"

const USAGE = `Usage: tungsten [flags]

Flags:
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format;
                                 repeat it or separate repos with commas to list them together
      --demo                     Show sample data instead of fetching from GitHub
      --demo-multiple            Like --demo, with PRs from several repos
      --show-git-prompt          Let c and w show git's prompts (ssh passphrase, credentials);
                                 the app is hidden while they run
      --no-watch                 Don't poll GitHub for changes; r still refreshes
  -h, --help                     Show help`

let repos: Repo[]
let demo: boolean
let showGitPrompt: boolean
let noWatch: boolean
let here: Repo | undefined // the repo cloned in the current folder, where c and w work
try {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", short: "R", multiple: true },
      demo: { type: "boolean" },
      "demo-multiple": { type: "boolean" },
      "show-git-prompt": { type: "boolean" },
      "no-watch": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const demoMultiple = values["demo-multiple"] ?? false
  demo = (values.demo ?? false) || demoMultiple
  showGitPrompt = values["show-git-prompt"] ?? false
  noWatch = values["no-watch"] ?? false
  // Like gh: OWNER/REPO uses gh's default host, and no flag means the current folder's git remotes.
  // --demo shouldn't need a clone, so it falls back to sample repos.
  const hosts = ghHosts()
  const named = (values.repo ?? []).flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean)
  repos =
    named.length ? named.map(r => parseRepo(r, hosts.defaultHost)).filter((r, i, all) => all.findIndex(o => repoKey(o) === repoKey(r)) === i) :
    demoMultiple ? ["withgraphite/monologue", "withgraphite/graphite-cli", "withgraphite/retype"].map(r => parseRepo(r)) :
    demo ? [parseRepo("withgraphite/monologue")] :
    [detectRepo(process.cwd(), hosts)]
  // One GraphQL request serves every repo, and it goes to a single host.
  if (new Set(repos.map(r => r.host)).size > 1) throw new Error("all repos must be on the same GitHub host")
  if (!demo) {
    if (!named.length) here = repos[0]
    else try { here = detectRepo(process.cwd(), hosts) } catch {}
  }
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`)
  process.exit(1)
}

const load = async (search?: string) => {
  const s = search ? parseSearch(search) : undefined
  if (!demo) return fetchBuckets(repos, s)
  const buckets = demoBuckets(...repos)
  return s ? buckets.map(b => ({ name: b.name, prs: b.prs.filter(pr => matches(pr, s)) })) : buckets
}

// Demo data never changes.
const watch: Watch | undefined = demo || noWatch ? undefined : (on, onScreen) => watchRepos(repos, on, onScreen)

const renderer = await createCliRenderer({ exitOnCtrlC: true })

// Commands that may prompt fail instead, so the app stays on screen;
// --show-git-prompt hands them the real terminal, hiding the app while they run.
const runGit: Run = async (cmd, args, opts) => {
  if (!opts?.interactive) return run(cmd, args)
  if (!showGitPrompt) return run(cmd, args, { noPrompts: true })
  renderer.suspend()
  try {
    return await run(cmd, args, { terminal: true })
  } finally {
    renderer.resume()
  }
}

const withHint = (p: Promise<string>) => p.catch((e: Error) => {
  throw showGitPrompt || !needsPrompt(e.message) ? e : new Error(`${e.message} (run with --show-git-prompt to answer git's prompts)`)
})

// Checkouts happen in the current folder, so it has to be a clone of the PR's repo.
const local = (pr: PR, fn: () => Promise<string>) =>
  demo ? Promise.reject(new Error("not available with --demo")) :
  !here || repoKey(here) !== repoKey(pr.repo) ? Promise.reject(new Error(`run tungsten from a clone of ${repoLabel(pr.repo)} to check out its PRs`)) :
  withHint(fn())

const actions: Actions = {
  checkout: pr => local(pr, () => checkoutPr(pr, pr.repo, runGit)),
  worktree: pr => local(pr, () => openWorktree(pr, pr.repo, { run: runGit, tmux: !!process.env.TMUX })),
}

createRoot(renderer).render(<App repos={repos} load={load} watch={watch} actions={actions} />)
