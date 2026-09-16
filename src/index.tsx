#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { parseArgs } from "node:util"
import { App } from "./app"
import { demoBuckets } from "./data"
import { fetchBuckets } from "./github"
import { detectRepo, ghHosts, parseRepo, type Repo } from "./repo"

const USAGE = `Usage: tungsten [flags]

Flags:
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
      --demo                     Show sample data instead of fetching from GitHub
  -h, --help                     Show help`

let repo: Repo
let demo: boolean
try {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", short: "R" },
      demo: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  demo = values.demo ?? false
  // Like gh: OWNER/REPO uses gh's default host, and no flag means the current folder's git remotes.
  // --demo shouldn't need a clone, so it falls back to a sample repo.
  const hosts = ghHosts()
  repo =
    values.repo ? parseRepo(values.repo, hosts.defaultHost) :
    demo ? parseRepo("withgraphite/monologue") :
    detectRepo(process.cwd(), hosts)
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`)
  process.exit(1)
}

const load = demo ? async () => demoBuckets(repo) : () => fetchBuckets(repo)

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App repo={repo} load={load} />)
