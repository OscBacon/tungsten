import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { spawn } from "node:child_process"
import { useEffect, useMemo, useRef, useState } from "react"
import { isStale, prKey, relativeTime, type Bucket, type PR, type State, type Status } from "./data"
import { useInbox, type Watch } from "./inbox"
import { repoLabel, type Repo } from "./repo"

const C = {
  bg: "#1c1d21", border: "#34353b", borderActive: "#7b8cff", selected: "#2b2d3a",
  text: "#ececef", muted: "#9a9ba2", faint: "#6c6d74",
  green: "#5fb865", red: "#e5534b", blue: "#7b8cff", purple: "#8e6bf2", orange: "#e3a23b",
}

const STATUS: Record<Status, [string, string]> = {
  pass: ["✓", C.green], fail: ["✗", C.red], pending: ["◷", C.faint], running: ["●", C.orange], merged: ["◆", C.purple],
}
const STATE: Record<State, [string, string]> = {
  review: ["◷", C.muted], approved: ["✓", C.green], draft: ["✎", C.muted], merged: ["◆", C.purple], author: ["↩", C.orange],
}

// Navigation walks one flat list: bucket headers plus the rows of open buckets.
// Headers stay in the list so a collapsed bucket can still be reached and reopened.
type Item =
  | { kind: "bucket"; id: string; bucket: number }
  | { kind: "pr"; id: string; bucket: number; pr: PR }

// By name, not position: the "Just merged" bucket comes and goes, shifting the ones below it.
const bucketId = (b: Bucket) => `bucket-${b.name}`
const bucketBoxId = (b: Bucket) => `bucket-box-${b.name}`
// Scoped to the bucket: one PR can sit in two buckets (say review-requested and open),
// and each copy needs its own id to be selectable and scrollable on its own.
const prId = (b: Bucket, pr: PR) => `pr-${b.name}-${prKey(pr)}`

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.env.WSL_DISTRO_NAME ? ["wslview", [url]] :
    ["xdg-open", [url]]
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref()
}

const fit = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s.padEnd(n))

// Fixed-width columns are padded strings, so rows line up without per-cell layout.
// With several repos the author column also names the PR's repo, so it's wider.
const AUTHOR_W = 20, AUTHOR_REPO_W = 36, CHANGES_W = 11, UPDATED_W = 4
const fixed = (authorW: number) => 7 + 2 + authorW + 2 + 1 + 2 + 1 + 2 + CHANGES_W + 2 + UPDATED_W
const CHROME = 2 + 2 + 1 // bucket border, row padding, scrollbar

// How a row names its repo: just REPO, unless two of the repos share that name.
function repoTags(repos: Repo[]): (r: Repo) => string {
  const name = (r: Repo) => r.name.toLowerCase()
  const clash = (r: Repo) => repos.filter(o => name(o) === name(r)).length > 1
  return r => (clash(r) ? `${r.owner}/${r.name}` : r.name)
}

// Each resolves to a success message or rejects with the error to show.
export interface Actions {
  checkout(pr: PR): Promise<string>
  worktree(pr: PR): Promise<string>
}

const printable = (s: string) => s.length > 0 && !/[\x00-\x1f\x7f]/.test(s)

// Relative times are worked out when drawn, so they keep aging while the app is open.
function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

// justMergedMs: how long a PR merged while watching stays listed; tests shorten it.
export function App({ repos, load, watch, actions, justMergedMs }: { repos: Repo[]; load: (search?: string) => Promise<Bucket[]>; watch?: Watch; actions: Actions; justMergedMs?: number }) {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const now = useNow()
  const scroll = useRef<ScrollBoxRenderable>(null)
  const { buckets, loading, error, search, applySearch: apply, refresh } = useInbox(load, watch, justMergedMs)
  // By name, so a bucket stays collapsed across refreshes and searches that change the bucket list.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [cursorId, setCursorId] = useState<string>()
  const lastIndex = useRef(0)
  // The search being typed, while the "/" prompt is open. Keys can arrive faster than renders
  // (typing fast, pasting), so each one reads and writes the ref, not a stale render's value.
  const [input, setInputState] = useState<string>()
  const inputRef = useRef<string>(undefined)
  const setInput = (v: string | undefined) => { inputRef.current = v; setInputState(v) }
  const [notice, setNotice] = useState<{ text: string; color: string }>()
  const [busy, setBusy] = useState(false)

  const applySearch = (next: string) => {
    if (!apply(next)) return
    setCursorId(undefined) // new results: start from the top
    lastIndex.current = 0
  }

  const items = useMemo<Item[]>(() => buckets.flatMap((b, i) => [
    { kind: "bucket" as const, id: bucketId(b), bucket: i },
    ...(collapsed.has(b.name) ? [] : b.prs.map(pr => ({ kind: "pr" as const, id: prId(b, pr), bucket: i, pr }))),
  ]), [buckets, collapsed])

  // The cursor follows an id so it stays on the same PR across refreshes;
  // if that PR is gone, it keeps its position instead.
  const found = items.findIndex(it => it.id === cursorId)
  const index = found >= 0 ? found : Math.min(lastIndex.current, items.length - 1)
  lastIndex.current = Math.max(0, index)
  const current = items[index]

  useEffect(() => {
    const box = scroll.current
    if (!box || !current) return
    // At a bucket's edge, first reveal the whole bucket so its bottom border isn't clipped.
    const bucket = buckets[current.bucket]!
    const rows = collapsed.has(bucket.name) ? [] : bucket.prs
    const atBucketEnd = rows.length === 0 || (current.kind === "pr" && current.pr === rows.at(-1))
    if (atBucketEnd) box.scrollChildIntoView(bucketBoxId(bucket))
    box.scrollChildIntoView(current.id)
  }, [current?.id, buckets, collapsed])

  const move = (delta: number) => {
    const next = items[Math.min(items.length - 1, Math.max(0, index + delta))]
    if (next) setCursorId(next.id)
  }

  // PgUp/PgDn jump between bucket headers, from anywhere inside a bucket.
  const jumpBucket = (delta: number) => {
    if (!current) return
    const target = Math.min(buckets.length - 1, Math.max(0, current.bucket + delta))
    setCursorId(bucketId(buckets[target]!))
  }

  const toggle = (bucket: number) => {
    const name = buckets[bucket]!.name
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
    // Park the cursor on the header: the rows below it may vanish.
    setCursorId(bucketId(buckets[bucket]!))
  }

  const runAction = (fn: (pr: PR) => Promise<string>, pending: string) => {
    if (busy || current?.kind !== "pr") return
    setBusy(true)
    setNotice({ text: `${pending} PR #${current.pr.number}…`, color: C.muted })
    fn(current.pr)
      .then(text => setNotice({ text: `✓ ${text}`, color: C.green }),
        (e: unknown) => setNotice({ text: `✗ ${e instanceof Error ? e.message : String(e)}`, color: C.red }))
      .finally(() => setBusy(false))
  }

  useKeyboard(key => {
    // While typing a search, keys are text; only enter and esc leave the prompt.
    const input = inputRef.current
    if (input !== undefined) {
      if (key.name === "escape") { setInput(undefined); applySearch("") }
      else if (key.name === "return") { setInput(undefined); applySearch(input.trim()) }
      else if (key.name === "backspace") setInput(input.slice(0, -1))
      else if (!key.ctrl && !key.meta && printable(key.sequence)) setInput(input + key.sequence)
      return
    }
    if (key.ctrl || key.meta) return
    if (key.sequence === "/") return setInput(search)
    switch (key.name) {
      case "up":
      case "k":
        move(-1)
        break
      case "down":
      case "j":
        move(1)
        break
      case "pageup":
        jumpBucket(-1)
        break
      case "pagedown":
        jumpBucket(1)
        break
      case "t":
        if (current) toggle(current.bucket)
        break
      case "return":
        if (current?.kind === "pr") openInBrowser(current.pr.url)
        else if (current) toggle(current.bucket)
        break
      case "c":
        runAction(actions.checkout, "Checking out")
        break
      case "w":
        runAction(actions.worktree, "Opening a worktree for")
        break
      case "escape":
        applySearch("")
        break
      case "r":
        if (!loading) refresh()
        break
      case "q":
        renderer.destroy()
        process.exit(0)
    }
  })

  const multi = repos.length > 1
  const authorW = multi ? AUTHOR_REPO_W : AUTHOR_W
  const tag = useMemo(() => repoTags(repos), [repos])
  const titleW = Math.max(12, width - fixed(authorW) - CHROME)
  const all = repos.map(repoLabel).join(", ")
  const label = all.length <= width / 2 ? all : `${repos.length} repos`

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
      <box style={{ height: 1, paddingLeft: 1, flexDirection: "row", justifyContent: "space-between", paddingRight: 1 }}>
        <text fg={C.text}><b>Inbox</b>{search && <span fg={C.muted}>{fit(`  / ${search}`, Math.max(0, width - label.length - 20))}</span>}</text>
        <text fg={C.muted}>{loading && <span fg={C.faint}>loading…  </span>}{label}</text>
      </box>

      {(error || notice) && (
        <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={error ? C.red : notice!.color}>{fit(error ? `✗ ${error}` : notice!.text, Math.max(0, width - 2))}</text>
        </box>
      )}

      <scrollbox ref={scroll} style={{ flexGrow: 1 }}>
        {buckets.length === 0 && (
          <box style={{ height: 1, paddingLeft: 1 }}>
            <text fg={C.faint}>{loading ? "Loading pull requests…" : "No pull requests loaded. Press r to retry."}</text>
          </box>
        )}
        {buckets.map((b, i) => {
          const count = b.total ?? b.prs.length
          const open = !collapsed.has(b.name)
          const onHeader = current?.id === bucketId(b)
          return (
            <box
              key={b.name}
              id={bucketBoxId(b)}
              border
              borderStyle="rounded"
              borderColor={current?.bucket === i ? C.borderActive : C.border}
              style={{ flexDirection: "column" }}
            >
              <box id={bucketId(b)} style={{ height: 1, paddingLeft: 1, backgroundColor: onHeader ? C.selected : C.bg }}>
                <text fg={C.text}>
                  <span fg={C.muted}>{count === 0 ? " " : open ? "▾" : "▸"}</span> {b.name}{" "}
                  <span fg={C.faint}>{count === 0 ? "- No pull requests" : String(count)}</span>
                </text>
              </box>
              {open && b.prs.map(pr => (
                <PrRow key={prKey(pr)} id={prId(b, pr)} pr={pr} now={now} repoTag={multi ? tag(pr.repo) : undefined} authorW={authorW} titleW={titleW} selected={current?.id === prId(b, pr)} />
              ))}
            </box>
          )
        })}
      </scrollbox>

      <box style={{ height: 1, paddingLeft: 1 }}>
        {input !== undefined ? (
          <text fg={C.faint}>
            <span fg={C.text}>/ {input}█</span>   <span fg={C.text}>enter</span> search   <span fg={C.text}>esc</span> clear   words match titles, @login authors, #123 numbers
          </text>
        ) : (
          <text fg={C.faint}>
            {search && <><span fg={C.text}>esc</span> clear search   </>}<span fg={C.text}>↑↓</span> move   <span fg={C.text}>t</span> toggle bucket   <span fg={C.text}>enter</span> open PR   {!search && <><span fg={C.text}>/</span> search   </>}<span fg={C.text}>c</span> checkout   <span fg={C.text}>w</span> worktree   <span fg={C.text}>r</span> refresh   <span fg={C.text}>q</span> quit
          </text>
        )}
      </box>
    </box>
  )
}

function PrRow({ id, pr, now, repoTag, authorW, titleW, selected }: { id: string; pr: PR; now: Date; repoTag?: string; authorW: number; titleW: number; selected: boolean }) {
  const [stateGlyph, stateColor] = STATE[pr.state]
  const [ciGlyph, ciColor] = STATUS[pr.ci]
  const [revGlyph, revColor] = STATUS[pr.review]
  const add = `+${pr.additions}`, del = `-${pr.deletions}`
  const changesPad = " ".repeat(Math.max(0, CHANGES_W - add.length - del.length - 1))

  return (
    <box id={id} style={{ height: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: selected ? C.selected : C.bg }}>
      <text fg={C.text}>
        <span fg={C.blue}>{selected ? "▌" : " "}</span> <span fg={C.blue}>•</span> <span fg={stateColor}>{stateGlyph}</span>
        {"  "}{selected ? <b>{fit(pr.title, titleW)}</b> : fit(pr.title, titleW)}
        {"  "}<span fg={C.muted}>{fit(`${pr.author} ${repoTag ?? ""}#${pr.number}`, authorW)}</span>
        {"  "}<span fg={ciColor}>{ciGlyph}</span>
        {"  "}<span fg={revColor}>{revGlyph}</span>
        {"  "}{changesPad}<span fg={C.green}>{add}</span><span fg={C.muted}>/</span><span fg={C.red}>{del}</span>
        {"  "}<span fg={isStale(pr, now) ? C.red : C.text}>{relativeTime(pr.updatedAt, now).padStart(UPDATED_W)}</span>
      </text>
    </box>
  )
}
