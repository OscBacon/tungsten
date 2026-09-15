import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Repository resolution mirrors gh (cli/cli git/client.go, git/url.go, internal/ghrepo,
// pkg/cmd/factory/remote_resolver.go; cli/go-gh pkg/ssh, pkg/auth, pkg/config)
// so we pick the same repo `gh pr list` would.

export interface Repo {
  host: string
  owner: string
  name: string
}

export const DEFAULT_HOST = "github.com"

const normalizeHost = (h: string) => h.toLowerCase().replace(/^www\./, "")

// Accepts gh's [HOST/]OWNER/REPO format.
export function parseRepo(s: string, fallbackHost = DEFAULT_HOST): Repo {
  const parts = s.split("/")
  if ((parts.length === 2 || parts.length === 3) && parts.every(Boolean)) {
    const [owner, name] = parts.slice(-2) as [string, string]
    return { host: normalizeHost(parts.length === 3 ? parts[0]! : fallbackHost), owner, name }
  }
  throw new Error(`expected the "[HOST/]OWNER/REPO" format, got "${s}"`)
}

// Like gh, only show the host when it isn't the default.
export const repoLabel = (r: Repo) =>
  `${r.host === DEFAULT_HOST ? "" : r.host + "/"}${r.owner}/${r.name}`

export interface GhHosts {
  known: string[] // hosts whose remotes gh will consider
  defaultHost: string
  source: "GH_HOST" | "hosts" | "default"
}

function configDir(env: NodeJS.ProcessEnv) {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh")
  if (process.platform === "win32" && env.AppData) return join(env.AppData, "GitHub CLI")
  return join(homedir(), ".config", "gh")
}

// Top-level keys of hosts.yml. Only key lines are matched, so tokens are never read.
function configHosts(env: NodeJS.ProcessEnv): string[] {
  try {
    return readFileSync(join(configDir(env), "hosts.yml"), "utf8")
      .split("\n")
      .map(line => line.match(/^(["']?)([^\s#"':][^"':]*)\1:/)?.[2])
      .filter((h): h is string => !!h)
  } catch {
    return []
  }
}

export function ghHosts(env = process.env): GhHosts {
  const fromConfig = configHosts(env)
  const known = [...new Set([env.GH_HOST, ...fromConfig, DEFAULT_HOST].filter((h): h is string => !!h).map(normalizeHost))]
  if (env.GH_HOST) return { known, defaultHost: normalizeHost(env.GH_HOST), source: "GH_HOST" }
  if (fromConfig.length === 1) return { known, defaultHost: normalizeHost(fromConfig[0]!), source: "hosts" }
  return { known, defaultHost: DEFAULT_HOST, source: "default" }
}

const POSSIBLE_PROTOCOL = /^(ssh|git\+ssh|git|http|git\+https|https|ftp|ftps|file):/

// `sshHostname` resolves ~/.ssh/config aliases; it is only applied to ssh URLs.
export function parseRemoteUrl(raw: string, sshHostname: (host: string) => string = h => h): Repo | null {
  // scp-like syntax (git@host:owner/repo) is ssh; a backslash means a Windows path.
  const s = !POSSIBLE_PROTOCOL.test(raw) && raw.includes(":") && !raw.includes("\\") ? "ssh://" + raw.replace(":", "/") : raw
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!u.hostname) return null

  let host = u.hostname
  if (u.protocol.replace(/^git\+/, "") === "ssh:") {
    host = sshHostname(host)
    if (host.toLowerCase() === "ssh.github.com") host = DEFAULT_HOST
  }

  const parts = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, "").split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts as [string, string]
  return { host: normalizeHost(host), owner, name: name.replace(/\.git$/, "") }
}

const sshCache = new Map<string, string>()

function sshHostname(host: string): string {
  const key = host.toLowerCase()
  let resolved = sshCache.get(key)
  if (resolved === undefined) {
    try {
      const out = execFileSync("ssh", ["-G", "--", host], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      resolved = out.match(/^hostname (.+)$/m)?.[1] ?? host
    } catch {
      resolved = host // no ssh, or it failed: keep the hostname unchanged
    }
    sshCache.set(key, resolved)
  }
  return resolved
}

export interface Remote {
  name: string
  fetchUrl?: string
  pushUrl?: string
  resolved?: string // set by `gh repo set-default` or cloning a fork: "base" or "OWNER/REPO"
}

export function readRemotes(cwd: string): Remote[] {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      return "" // not a git repo, or no gh-resolved entries (git config exits 1)
    }
  }

  // `git remote -v` rather than raw config, so pushurl and insteadOf rewrites apply.
  const remotes: Remote[] = []
  for (const line of git("remote", "-v").split("\n")) {
    const m = line.match(/(.+)\s+(.+)\s+\((push|fetch)\)/)
    if (!m) continue
    const [name, url, kind] = [m[1]!.trim(), m[2]!.trim(), m[3]]
    let remote = remotes.at(-1)
    if (remote?.name !== name) remotes.push((remote = { name }))
    if (kind === "fetch") remote.fetchUrl = url
    else remote.pushUrl = url
  }

  for (const line of git("config", "--get-regexp", String.raw`^remote\..*\.gh-resolved$`).split("\n")) {
    const space = line.indexOf(" ")
    if (space < 0) continue
    const name = line.slice(0, space).split(".")[1] // gh takes the second dot-separated segment
    const remote = remotes.find(r => r.name === name)
    if (remote) remote.resolved = line.slice(space + 1)
  }
  return remotes
}

const PRIORITY = ["upstream", "github", "origin"]
const rank = (name: string) => {
  const i = PRIORITY.indexOf(name.toLowerCase())
  return i < 0 ? PRIORITY.length : i
}

export function resolveRepo(remotes: Remote[], hosts: GhHosts, translate: (host: string) => string = h => h): Repo {
  if (remotes.length === 0) throw new Error("no git remotes found; run inside a clone or pass --repo")

  const parse = (url?: string) => (url ? parseRemoteUrl(url, translate) : null)
  let candidates = remotes
    .map(r => ({ ...r, repo: parse(r.fetchUrl) ?? parse(r.pushUrl) }))
    .filter((c): c is typeof c & { repo: Repo } => c.repo !== null && hosts.known.includes(c.repo.host))
    .sort((a, b) => rank(a.name) - rank(b.name))

  // A default host from GH_HOST is strict; one from hosts.yml only wins when a remote matches it.
  if (hosts.source !== "default") {
    const onDefault = candidates.filter(c => c.repo.host === hosts.defaultHost)
    if (hosts.source === "GH_HOST" || onDefault.length > 0) candidates = onDefault
  }

  if (candidates.length === 0) {
    throw new Error(hosts.source === "GH_HOST"
      ? "none of the git remotes configured for this repository correspond to the GH_HOST environment variable; add a matching remote, unset the variable, or pass --repo"
      : "none of the git remotes configured for this repository point to a known GitHub host; run `gh auth login` or pass --repo")
  }

  const resolved = candidates.find(c => c.resolved)
  if (resolved) return resolved.resolved === "base" ? resolved.repo : parseRepo(resolved.resolved!, hosts.defaultHost)
  return candidates[0]!.repo
}

export function detectRepo(cwd = process.cwd(), hosts = ghHosts()): Repo {
  return resolveRepo(readRemotes(cwd), hosts, sshHostname)
}
