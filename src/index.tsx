#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { parseArgs } from "node:util"
import { App, type Actions } from "./app"
import { checkoutPr, needsPrompt, openWorktree } from "./checkout"
import { demoBuckets } from "./data"
import { fetchBuckets, matches, parseSearch } from "./github"
import { detectRepo, ghHosts, parseRepo, repoLabel, type Repo } from "./repo"
import { run, type Run } from "./run"

const USAGE = `Usage: tungsten [flags]

Flags:
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
      --demo                     Show sample data instead of fetching from GitHub
      --show-git-prompt          Let c and w show git's prompts (ssh passphrase, credentials);
                                 the app is hidden while they run
  -h, --help                     Show help`

let repo: Repo
let demo: boolean
let showGitPrompt: boolean
let notLocal: string | undefined // why c and w can't work from here
try {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", short: "R" },
      demo: { type: "boolean" },
      "show-git-prompt": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  demo = values.demo ?? false
  showGitPrompt = values["show-git-prompt"] ?? false
  // Like gh: OWNER/REPO uses gh's default host, and no flag means the current folder's git remotes.
  // --demo shouldn't need a clone, so it falls back to a sample repo.
  const hosts = ghHosts()
  repo =
    values.repo ? parseRepo(values.repo, hosts.defaultHost) :
    demo ? parseRepo("withgraphite/monologue") :
    detectRepo(process.cwd(), hosts)
  // Checkouts happen in the current folder, so it has to be a clone of the repo on screen.
  if (demo) notLocal = "not available with --demo"
  else if (values.repo) {
    const key = (r: Repo) => `${r.host}/${r.owner}/${r.name}`.toLowerCase()
    let here: Repo | undefined
    try { here = detectRepo(process.cwd(), hosts) } catch {}
    if (!here || key(here) !== key(repo)) {
      notLocal = `run tungsten from a clone of ${repoLabel(repo)} to check out its PRs`
    }
  }
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`)
  process.exit(1)
}

const load = async (search?: string) => {
  const s = search ? parseSearch(search) : undefined
  if (!demo) return fetchBuckets(repo, s)
  const buckets = demoBuckets(repo)
  return s ? buckets.map(b => ({ name: b.name, prs: b.prs.filter(pr => matches(pr, s)) })) : buckets
}

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

const actions: Actions = notLocal
  ? { checkout: () => Promise.reject(new Error(notLocal)), worktree: () => Promise.reject(new Error(notLocal)) }
  : {
      checkout: pr => withHint(checkoutPr(pr, repo, runGit)),
      worktree: pr => withHint(openWorktree(pr, repo, { run: runGit, tmux: !!process.env.TMUX })),
    }

createRoot(renderer).render(<App repo={repo} load={load} actions={actions} />)
