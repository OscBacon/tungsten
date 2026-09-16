import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { spawn } from "node:child_process"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Bucket, PR, State, Status } from "./data"
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

const bucketId = (i: number) => `bucket-${i}`
const bucketBoxId = (i: number) => `bucket-box-${i}`
// Scoped to the bucket: one PR can sit in two buckets (say review-requested and open),
// and each copy needs its own id to be selectable and scrollable on its own.
const prId = (bucket: number, pr: PR) => `pr-${bucket}-${pr.number}`

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
const AUTHOR_W = 20, CHANGES_W = 11, UPDATED_W = 4
const FIXED = 7 + 2 + AUTHOR_W + 2 + 1 + 2 + 1 + 2 + CHANGES_W + 2 + UPDATED_W
const CHROME = 2 + 2 + 1 // bucket border, row padding, scrollbar

export function App({ repo, load }: { repo: Repo; load: () => Promise<Bucket[]> }) {
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const scroll = useRef<ScrollBoxRenderable>(null)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set())
  const [cursorId, setCursorId] = useState<string>()
  const lastIndex = useRef(0)

  // A failed refresh keeps the last good data on screen.
  const refresh = useCallback(() => {
    setLoading(true)
    load()
      .then(b => { setBuckets(b); setError(undefined) }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [load])
  useEffect(refresh, [refresh])

  const items = useMemo<Item[]>(() => buckets.flatMap((b, i) => [
    { kind: "bucket" as const, id: bucketId(i), bucket: i },
    ...(collapsed.has(i) ? [] : b.prs.map(pr => ({ kind: "pr" as const, id: prId(i, pr), bucket: i, pr }))),
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
    const rows = collapsed.has(current.bucket) ? [] : buckets[current.bucket]!.prs
    const atBucketEnd = rows.length === 0 || (current.kind === "pr" && current.pr === rows.at(-1))
    if (atBucketEnd) box.scrollChildIntoView(bucketBoxId(current.bucket))
    box.scrollChildIntoView(current.id)
  }, [current?.id, buckets, collapsed])

  const move = (delta: number) => {
    const next = items[Math.min(items.length - 1, Math.max(0, index + delta))]
    if (next) setCursorId(next.id)
  }

  const toggle = (bucket: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(bucket) ? next.delete(bucket) : next.add(bucket)
      return next
    })
    // Park the cursor on the header: the rows below it may vanish.
    setCursorId(bucketId(bucket))
  }

  useKeyboard(key => {
    if (key.ctrl || key.meta) return
    switch (key.name) {
      case "up":
      case "k":
        move(-1)
        break
      case "down":
      case "j":
        move(1)
        break
      case "t":
        if (current) toggle(current.bucket)
        break
      case "return":
        if (current?.kind === "pr") openInBrowser(current.pr.url)
        else if (current) toggle(current.bucket)
        break
      case "r":
        if (!loading) refresh()
        break
      case "q":
        renderer.destroy()
        process.exit(0)
    }
  })

  const titleW = Math.max(12, width - FIXED - CHROME)

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
      <box style={{ height: 1, paddingLeft: 1, flexDirection: "row", justifyContent: "space-between", paddingRight: 1 }}>
        <text fg={C.text}><b>Inbox</b></text>
        <text fg={C.muted}>{loading && <span fg={C.faint}>loading…  </span>}{repoLabel(repo)}</text>
      </box>

      {error && (
        <box style={{ height: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={C.red}>{fit(`✗ ${error}`, Math.max(0, width - 2))}</text>
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
          const open = !collapsed.has(i)
          const onHeader = current?.id === bucketId(i)
          return (
            <box
              key={b.name}
              id={bucketBoxId(i)}
              border
              borderStyle="rounded"
              borderColor={current?.bucket === i ? C.borderActive : C.border}
              style={{ flexDirection: "column" }}
            >
              <box id={bucketId(i)} style={{ height: 1, paddingLeft: 1, backgroundColor: onHeader ? C.selected : C.bg }}>
                <text fg={C.text}>
                  <span fg={C.muted}>{count === 0 ? " " : open ? "▾" : "▸"}</span> {b.name}{" "}
                  <span fg={C.faint}>{count === 0 ? "- No pull requests" : String(count)}</span>
                </text>
              </box>
              {open && b.prs.map(pr => (
                <PrRow key={pr.number} id={prId(i, pr)} pr={pr} titleW={titleW} selected={current?.id === prId(i, pr)} />
              ))}
            </box>
          )
        })}
      </scrollbox>

      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={C.faint}>
          <span fg={C.text}>↑↓</span> move   <span fg={C.text}>t</span> toggle bucket   <span fg={C.text}>enter</span> open PR   <span fg={C.text}>r</span> refresh   <span fg={C.text}>q</span> quit
        </text>
      </box>
    </box>
  )
}

function PrRow({ id, pr, titleW, selected }: { id: string; pr: PR; titleW: number; selected: boolean }) {
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
        {"  "}<span fg={C.muted}>{fit(`${pr.author} #${pr.number}`, AUTHOR_W)}</span>
        {"  "}<span fg={ciColor}>{ciGlyph}</span>
        {"  "}<span fg={revColor}>{revGlyph}</span>
        {"  "}{changesPad}<span fg={C.green}>{add}</span><span fg={C.muted}>/</span><span fg={C.red}>{del}</span>
        {"  "}<span fg={pr.stale ? C.red : C.text}>{pr.updated.padStart(UPDATED_W)}</span>
      </text>
    </box>
  )
}
