import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { prKey, type Bucket, type PR } from "./data"

// What a watcher reports; see watchRepos() in poll.ts.
export interface Watcher {
  prs(prs: PR[]): void // fresh copies of PRs that changed
  refetch(): void // too much changed to patch: load the buckets again
  error(message: string | undefined): void // undefined once it works again
}

// Starts watching, given the PRs on screen; returns a function that stops it.
export type Watch = (on: Watcher, onScreen: () => PR[]) => () => void

export const JUST_MERGED = "Just merged"
export const JUST_MERGED_MS = 60_000
// GitHub's search index trails changes, so a load can miss a PR's move; see settle().
const SEARCH_LAG_MS = 2 * 60_000

const byUpdated = (a: PR, b: PR) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)

// Puts fresh copies of PRs where they now belong: out of buckets they left, into the ones that
// accept them, newest first like the searches. Buckets without a rule only update their copies.
export function place(buckets: Bucket[], prs: PR[]): Bucket[] {
  if (prs.length === 0) return buckets
  const fresh = new Map(prs.map(pr => [prKey(pr), pr]))
  return buckets.map(b => {
    if (!b.accepts) {
      return b.prs.some(pr => fresh.has(prKey(pr))) ? { ...b, prs: b.prs.map(pr => fresh.get(prKey(pr)) ?? pr) } : b
    }
    const kept = b.prs.filter(pr => !fresh.has(prKey(pr)))
    const added = [...fresh.values()].filter(b.accepts)
    if (kept.length === b.prs.length && added.length === 0) return b
    const removed = b.prs.length - kept.length
    // A paged bucket may already count a PR it doesn't list, so only a fully listed one counts additions.
    const listedAll = b.total === undefined || b.total <= b.prs.length
    const newcomers = listedAll ? added.length : added.filter(pr => b.prs.some(o => prKey(o) === prKey(pr))).length
    const total = b.total === undefined ? undefined : b.total - removed + newcomers
    return { ...b, total, prs: [...kept, ...added].sort(byUpdated) }
  })
}

// PRs merged while watching, listed under "Approved" for a minute.
export function withJustMerged(buckets: Bucket[], prs: PR[]): Bucket[] {
  const i = buckets.findIndex(b => b.name === "Approved")
  if (prs.length === 0 || i < 0) return buckets
  return [...buckets.slice(0, i + 1), { name: JUST_MERGED, prs }, ...buckets.slice(i + 1)]
}

const findPr = (buckets: Bucket[], key: string) => buckets.flatMap(b => b.prs).find(pr => prKey(pr) === key)

// The PR data behind the inbox: loads (with or without a search) and the watcher's updates.
export function useInbox(load: (search?: string) => Promise<Bucket[]>, watch?: Watch, justMergedMs = JUST_MERGED_MS) {
  const [buckets, setBucketsState] = useState<Bucket[]>([])
  const shown = useRef<Bucket[]>([]) // the same, for callbacks that outlive a render
  const setBuckets = (b: Bucket[]) => {
    shown.current = b
    setBucketsState(b)
  }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [watchError, setWatchError] = useState<string>()
  const [search, setSearch] = useState("") // applied: loads and refreshes use it
  const searchRef = useRef("")
  const [justMerged, setJustMerged] = useState<PR[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  // The last unsearched buckets, so clearing a search puts them back without a fetch; r refreshes them.
  const home = useRef<Bucket[]>(undefined)

  // PRs patched lately. A load may have started before the patch, or come from a search index that
  // hasn't caught up; either way these are placed again on top of it.
  const recent = useRef(new Map<string, { pr: PR; at: number }>())
  const settle = (loaded: Bucket[], startedAt: number) => {
    const now = Date.now(), fixes: PR[] = []
    for (const [key, r] of recent.current) {
      if (now - r.at > SEARCH_LAG_MS) recent.current.delete(key)
      else fixes.push(r.at > startedAt ? r.pr : findPr(loaded, key) ?? r.pr)
    }
    return place(loaded, fixes)
  }

  // A failed refresh keeps the last good data on screen. Only the latest load lands,
  // so a slow one can't overwrite the results of a newer search. Quiet ones don't show "loading…".
  const latest = useRef(0)
  const refresh = useCallback((search: string, quiet = false) => {
    const id = ++latest.current
    const startedAt = Date.now()
    if (!quiet) setLoading(true)
    load(search || undefined)
      .then(b => {
        if (id !== latest.current) return
        const settled = settle(b, startedAt)
        setBuckets(settled)
        setError(undefined)
        if (!search) home.current = settled
      }, (e: unknown) => { if (id === latest.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (id === latest.current) setLoading(false) })
  }, [load])
  useEffect(() => refresh(""), [refresh])

  // Whether the search changed.
  const applySearch = (next: string) => {
    if (next === search) return false
    setSearch(next)
    searchRef.current = next
    setJustMerged([])
    if (next || !home.current) {
      refresh(next)
      return true
    }
    latest.current++ // drop a search still loading
    setBuckets(home.current)
    setError(undefined)
    setLoading(false)
    return true
  }

  // Patches both what's shown and the unsearched buckets kept for clearing a search.
  const patch = (prs: PR[]) => {
    const at = Date.now()
    for (const pr of prs) recent.current.set(prKey(pr), { pr, at })
    const before = shown.current
    const merged = prs.filter(pr => pr.state === "merged" && before.some(b => b.prs.some(o => prKey(o) === prKey(pr) && o.state !== "merged")))
    const after = place(before, prs)
    home.current = home.current === before ? after : home.current && place(home.current, prs)
    setBuckets(after)
    if (merged.length === 0) return
    setJustMerged(prev => [...merged, ...prev.filter(p => !merged.some(m => prKey(m) === prKey(p)))])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setJustMerged(prev => prev.filter(p => !merged.includes(p)))
    }, justMergedMs)
    timers.current.add(timer)
  }

  // The watcher outlives renders, so it reaches the latest patch and refresh through refs.
  const live = useRef({ patch, refresh })
  live.current = { patch, refresh }
  useEffect(() => watch?.({
    prs: prs => live.current.patch(prs),
    refetch: () => live.current.refresh(searchRef.current, true),
    error: setWatchError,
  }, () => shown.current.flatMap(b => b.prs)), [watch])

  const view = useMemo(() => withJustMerged(buckets, justMerged), [buckets, justMerged])
  return {
    buckets: view,
    loading,
    error: error ?? (watchError && `live updates paused: ${watchError}`),
    search,
    applySearch,
    refresh: () => refresh(search),
  }
}
