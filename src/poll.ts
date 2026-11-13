import { prKey, type PR } from "./data"
import { fetchPrs, fetchPullsPage, PULLS_PAGE, type PullsPage } from "./github"
import type { Watcher } from "./inbox"
import { repoKey, type Repo } from "./repo"

// Webhooks need admin on the repo, so changes are polled instead. Each poll is one request per repo
// for its recently updated PRs; an unchanged answer is a free 304 (see fetchPullsPage()).
export const POLL_MS = 15_000
const MAX_BACKOFF_MS = 5 * 60_000

// The PRs on a page whose updatedAt differs from the last one seen. The first page only sets the
// baseline. When every PR on a full page changed, more may have changed past it: that's an overflow.
export function diffPulls(seen: ReadonlyMap<number, string> | undefined, pulls: PullsPage["pulls"]): { changed: number[]; overflow: boolean } {
  if (!seen) return { changed: [], overflow: false }
  const changed = pulls.filter(p => seen.get(p.number) !== p.updatedAt).map(p => p.number)
  return { changed, overflow: pulls.length === PULLS_PAGE && changed.length === pulls.length }
}

// The PRs whose CI is still running, once each.
export const runningCi = (prs: PR[]) => [...new Map(prs.filter(pr => pr.open && pr.ci === "running").map(pr => [prKey(pr), pr])).values()]

// Polls the repos and hands `on` fresh copies of the PRs that changed, plus those on screen whose CI
// is running: finished CI doesn't touch a PR's updatedAt, so they're refetched until it settles.
// Returns a function that stops it.
export function watchRepos(repos: Repo[], on: Watcher, onScreen: () => PR[]): () => void {
  const state = repos.map(repo => ({ repo, etag: undefined as string | undefined, seen: undefined as Map<number, string> | undefined }))
  let stopped = false
  let delay = POLL_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async () => {
    const wanted = new Map<string, { repo: Repo; numbers: Set<number> }>()
    const want = (repo: Repo, number: number) => {
      const key = repoKey(repo)
      if (!wanted.has(key)) wanted.set(key, { repo, numbers: new Set() })
      wanted.get(key)!.numbers.add(number)
    }
    let overflow = false
    for (const s of state) {
      const page = await fetchPullsPage(s.repo, s.etag)
      if (!page) continue
      const diff = diffPulls(s.seen, page.pulls)
      s.etag = page.etag
      s.seen ??= new Map()
      for (const p of page.pulls) s.seen.set(p.number, p.updatedAt)
      overflow ||= diff.overflow
      for (const n of diff.changed) want(s.repo, n)
    }
    if (overflow) return on.refetch()
    for (const pr of runningCi(onScreen())) want(pr.repo, pr.number)
    const prs = await fetchPrs(repos[0]!.host, [...wanted.values()].map(w => ({ repo: w.repo, numbers: [...w.numbers] })))
    if (prs.length && !stopped) on.prs(prs)
  }

  const tick = async () => {
    try {
      await poll()
      delay = POLL_MS
      if (!stopped) on.error(undefined)
    } catch (e) {
      // Rate limits and outages: back off, and keep the last data on screen.
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
      if (!stopped) on.error(e instanceof Error ? e.message : String(e))
    }
    if (!stopped) timer = setTimeout(tick, delay)
  }
  timer = setTimeout(tick, 0)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
