import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App, type Actions } from "./app"
import { demoBuckets, type Bucket, type PR } from "./data"
import type { Watch, Watcher } from "./inbox"
import { parseRepo } from "./repo"

const press = async (s: Awaited<ReturnType<typeof testRender>>, fn: () => unknown = () => {}) => {
  await act(async () => { await fn(); await new Promise(r => setTimeout(r, 10)) })
  await s.renderOnce()
}

// A lone ESC is only reported once the input parser gives up waiting for a longer sequence.
const escape = async (s: Awaited<ReturnType<typeof testRender>>) => {
  await press(s, () => s.mockInput.pressEscape())
  await press(s)
}

const repo = parseRepo("withgraphite/monologue")
const noActions: Actions = { checkout: async () => "", worktree: async () => "" }

test("arrows move, t collapses the current bucket, cursor lands on its header", async () => {
  const s = await testRender(<App repos={[repo]} load={async () => demoBuckets(repo)} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s) // let the load resolve
    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressArrow("down"))
    expect(s.captureCharFrame()).toMatch(/▌ • ◷  refactor/)
    await press(s, () => s.mockInput.pressKey("t"))
    let frame = s.captureCharFrame()
    expect(frame).toContain("▸ Needs your review")
    expect(frame).not.toContain("refactor")
    await press(s, () => s.mockInput.pressArrow("down"))   // header -> "Returned to you"
    await press(s, () => s.mockInput.pressArrow("down"))   // -> "Approved" header
    await press(s, () => s.mockInput.pressArrow("down"))   // -> first approved PR
    expect(s.captureCharFrame()).toMatch(/▌ • ✓  \[Snyk\]/)
    // scroll: walk to the bottom of a short viewport
    for (let i = 0; i < 12; i++) await press(s, () => s.mockInput.pressArrow("down"))
    frame = s.captureCharFrame()
    console.log(frame)
    expect(frame).toMatch(/▌ • ◆  fix: throw/)
    expect(frame.trimEnd().split("\n").at(-2)).toMatch(/^╰/) // last bucket fully visible
    expect(frame.split("\n")[0]).toMatch(/^ Inbox/) // a box scrolled half out of view doesn't draw over the header
  } finally { s.renderer.destroy() }
})

test("r refreshes: loading state, cursor follows its PR, a failed refresh keeps the last data", async () => {
  const withoutFirstPr = (): Bucket[] => {
    const b = demoBuckets(repo)
    b[0]!.prs.shift()
    return b
  }
  let release!: (b: Bucket[]) => void
  const loads: (() => Promise<Bucket[]>)[] = [
    () => new Promise(r => (release = r)),
    async () => withoutFirstPr(),
    async () => { throw new Error("HTTP 401: Bad credentials") },
  ]
  let calls = 0
  const load = () => loads[calls++]!()

  const s = await testRender(<App repos={[repo]} load={load} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s)
    expect(s.captureCharFrame()).toContain("Loading pull requests…")
    await press(s, () => release(demoBuckets(repo)))
    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressArrow("down"))
    expect(s.captureCharFrame()).toMatch(/▌ • ◷  refactor/)

    await press(s, () => s.mockInput.pressKey("r"))
    let frame = s.captureCharFrame()
    expect(frame).not.toContain("only find upstack")
    expect(frame).toMatch(/▌ • ◷  refactor/) // same PR, now the first row

    await press(s, () => s.mockInput.pressKey("r"))
    frame = s.captureCharFrame()
    expect(frame).toContain("✗ HTTP 401: Bad credentials")
    expect(frame).toMatch(/▌ • ◷  refactor/)
    expect(calls).toBe(3)
  } finally { s.renderer.destroy() }
})

test("a PR listed in two buckets selects and moves from the copy the cursor is on", async () => {
  const dup = demoBuckets(repo)[0]!.prs[0]!
  const buckets: Bucket[] = [
    { name: "Needs your review", prs: [dup] },
    { name: "Open", prs: [dup, { ...dup, number: 999, title: "second open pull request" }] },
  ]
  const s = await testRender(<App repos={[repo]} load={async () => buckets} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s)
    // header -> the copy in "Needs your review" -> "Open" header -> the copy in "Open"
    for (let i = 0; i < 3; i++) await press(s, () => s.mockInput.pressArrow("down"))
    const lines = s.captureCharFrame().split("\n")
    const openHeader = lines.findIndex(l => l.includes("▾ Open"))
    expect(lines[openHeader + 1]).toContain("▌") // the copy under Open, not the one above
    expect(lines.slice(0, openHeader).join("\n")).not.toContain("▌")

    await press(s, () => s.mockInput.pressArrow("down"))
    expect(s.captureCharFrame()).toMatch(/▌ • ◷  second open pull request/)
  } finally { s.renderer.destroy() }
})

test("footer lists / c w between enter and r", async () => {
  const s = await testRender(<App repos={[repo]} load={async () => demoBuckets(repo)} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s)
    expect(s.captureCharFrame().trimEnd().split("\n").at(-1)).toMatch(/enter open PR {3}\/ search {3}c checkout {3}w worktree {3}r refresh {3}q quit/)
  } finally { s.renderer.destroy() }
})

test("/ types a search that only loads on enter; esc clears it", async () => {
  const searches: (string | undefined)[] = []
  const load = async (search?: string) => {
    searches.push(search)
    return search ? [{ name: "Open", prs: demoBuckets(repo)[0]!.prs.slice(1, 2) }] : demoBuckets(repo)
  }
  const s = await testRender(<App repos={[repo]} load={load} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s)
    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText("refactor rtq"))
    await press(s, () => s.mockInput.pressBackspace())
    let frame = s.captureCharFrame()
    expect(frame).toContain("/ refactor rt█")
    expect(frame).toContain("only find upstack") // nothing filtered while typing
    expect(searches).toEqual([undefined]) // and r, t, q were text, not keys

    await press(s, () => s.mockInput.pressEnter())
    frame = s.captureCharFrame()
    expect(searches).toEqual([undefined, "refactor rt"])
    expect(frame).toMatch(/Inbox {2}\/ refactor rt/)
    expect(frame).not.toContain("only find upstack")
    expect(frame).toContain("refactor: add logic")
    // The footer is back, with a way out in place of "/ search".
    expect(frame.trimEnd().split("\n").at(-1)).toMatch(/^ esc clear search {3}↑↓ move .* enter open PR {3}c checkout .* q quit/)

    await press(s, () => s.mockInput.pressKey("r")) // refresh keeps the search
    expect(searches.at(-1)).toBe("refactor rt")

    await press(s, () => s.mockInput.pressEscape())
    await press(s)
    expect(searches).toEqual([undefined, "refactor rt", "refactor rt"]) // cleared without a fetch
    frame = s.captureCharFrame()
    expect(frame).toContain("only find upstack")
    expect(frame.trimEnd().split("\n").at(-1)).toMatch(/^ ↑↓ move .* enter open PR {3}\/ search {3}c checkout/)

    // esc in the prompt also clears an applied search
    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText("@someone"))
    await press(s, () => s.mockInput.pressEnter())
    expect(searches.at(-1)).toBe("@someone")
    await press(s, () => s.mockInput.pressKey("/"))
    expect(s.captureCharFrame()).toContain("/ @someone█") // reopens with the current search
    await press(s, () => s.mockInput.pressEscape())
    await press(s)
    expect(searches.at(-1)).toBe("@someone")
    expect(s.captureCharFrame()).toContain("only find upstack")
  } finally { s.renderer.destroy() }
})

// A load per call that the test resolves by hand, recording what each was for.
function manualLoads() {
  const calls: { search?: string; resolve: (b: Bucket[]) => void }[] = []
  const load = (search?: string) => new Promise<Bucket[]>(resolve => calls.push({ search, resolve }))
  return { load, calls }
}
const titled = (title: string): Bucket[] => {
  const b = demoBuckets(repo)
  b[0]!.prs[0] = { ...b[0]!.prs[0]!, title }
  return b
}
const results = (title: string): Bucket[] => [{ name: "Search results", prs: [{ ...demoBuckets(repo)[0]!.prs[1]!, title }] }]

test("clearing a search shows the last unsearched data at once, from the top; r refetches it", async () => {
  const { load, calls } = manualLoads()
  const s = await testRender(<App repos={[repo]} load={load} actions={noActions} />, { width: 110, height: 20 })
  const search = async (q: string) => {
    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText(q))
    await press(s, () => s.mockInput.pressEnter())
  }
  try {
    await press(s, () => calls[0]!.resolve(titled("first unsearched load")))
    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressArrow("down"))
    expect(s.captureCharFrame()).toMatch(/▌ • ◷  refactor/)

    await search("docs")
    await press(s, () => calls[1]!.resolve(results("docs result")))
    expect(s.captureCharFrame()).toContain("docs result")

    await escape(s)
    let frame = s.captureCharFrame()
    expect(calls.length).toBe(2)
    expect(frame).toContain("first unsearched load")
    expect(frame).not.toContain("loading…")
    expect(frame).not.toContain("▌") // back at the top, on the first header

    // A search still loading when it's cleared can't land afterwards.
    await search("slow")
    await escape(s)
    await press(s, () => calls[2]!.resolve(results("late search result")))
    frame = s.captureCharFrame()
    expect(frame).toContain("first unsearched load")
    expect(frame).not.toContain("late search result")

    await press(s, () => s.mockInput.pressKey("r"))
    expect(calls.map(c => c.search)).toEqual([undefined, "docs", "slow", undefined])
    await press(s, () => calls[3]!.resolve(titled("refreshed unsearched load")))
    expect(s.captureCharFrame()).toContain("refreshed unsearched load")
  } finally { s.renderer.destroy() }
})

test("an unsearched load still running when a search starts is dropped, so clearing fetches", async () => {
  const { load, calls } = manualLoads()
  const s = await testRender(<App repos={[repo]} load={load} actions={noActions} />, { width: 110, height: 20 })
  try {
    await press(s)
    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText("docs"))
    await press(s, () => s.mockInput.pressEnter())
    await press(s, () => calls[0]!.resolve(titled("dropped unsearched load")))
    await press(s, () => calls[1]!.resolve(results("docs result")))
    expect(s.captureCharFrame()).not.toContain("dropped unsearched load")

    await escape(s)
    expect(calls.map(c => c.search)).toEqual([undefined, "docs", undefined])
    await press(s, () => calls[2]!.resolve(titled("fresh unsearched load")))
    expect(s.captureCharFrame()).toContain("fresh unsearched load")
  } finally { s.renderer.destroy() }
})

test("collapsed buckets are tracked by name across searches", async () => {
  const load = async (search?: string) => (search ? results("docs result") : demoBuckets(repo))
  const s = await testRender(<App repos={[repo]} load={load} actions={noActions} />, { width: 110, height: 30 })
  try {
    await press(s)
    for (let i = 0; i < 5; i++) await press(s, () => s.mockInput.pressArrow("down")) // "Approved" header
    await press(s, () => s.mockInput.pressKey("t"))
    expect(s.captureCharFrame()).toContain("▸ Approved")

    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText("docs"))
    await press(s, () => s.mockInput.pressEnter())
    await press(s, () => s.mockInput.pressKey("t")) // collapse "Search results", the first bucket
    expect(s.captureCharFrame()).toContain("▸ Search results")

    await escape(s)
    const frame = s.captureCharFrame()
    expect(frame).toContain("▾ Needs your review") // not collapsed by position
    expect(frame).toContain("▸ Approved")
  } finally { s.renderer.destroy() }
})

test("c and w act on the PR under the cursor and show the outcome", async () => {
  const calls: string[] = []
  let finish!: () => void
  const actions: Actions = {
    checkout: async pr => {
      calls.push(`checkout #${pr.number}`)
      await new Promise<void>(r => (finish = r))
      return `Checked out PR #${pr.number}`
    },
    worktree: async pr => { calls.push(`worktree #${pr.number}`); throw new Error("w needs gh 2.98 or newer") },
  }
  const s = await testRender(<App repos={[repo]} load={async () => demoBuckets(repo)} actions={actions} />, { width: 110, height: 20 })
  try {
    await press(s)
    await press(s, () => s.mockInput.pressKey("c")) // on a bucket header: nothing to check out
    expect(calls).toEqual([])

    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressKey("c"))
    expect(s.captureCharFrame()).toContain("Checking out PR #21325…") // the app stays up meanwhile
    await press(s, () => s.mockInput.pressKey("c")) // ignored while busy
    expect(calls).toEqual(["checkout #21325"])
    await press(s, () => finish())
    expect(s.captureCharFrame()).toContain("✓ Checked out PR #21325")

    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressKey("w"))
    await press(s)
    expect(calls).toEqual(["checkout #21325", "worktree #21324"])
    expect(s.captureCharFrame()).toContain("✗ w needs gh 2.98 or newer")
  } finally { s.renderer.destroy() }
})

test("several repos: rows name their repo, and PRs sharing a number are told apart", async () => {
  const repos = ["acme/app", "acme/app-ios"].map(r => parseRepo(r))
  const [a, b] = demoBuckets(...repos)[0]!.prs
  const buckets: Bucket[] = [{ name: "Open", prs: [{ ...a!, number: 7 }, { ...b!, number: 7, title: "same number, other repo" }] }]
  const s = await testRender(<App repos={repos} load={async () => buckets} actions={noActions} />, { width: 140, height: 20 })
  try {
    await press(s)
    let frame = s.captureCharFrame()
    expect(frame).toContain("acme/app, acme/app-ios")
    expect(frame).toContain("aryamannaik app#7")
    expect(frame).toContain("aryamannaik app-ios#7")

    await press(s, () => s.mockInput.pressArrow("down"))
    await press(s, () => s.mockInput.pressArrow("down"))
    frame = s.captureCharFrame()
    expect(frame).toMatch(/▌ • ◷  same number, other repo/)
    expect(frame.match(/▌/g)).toHaveLength(1)
  } finally { s.renderer.destroy() }
})

test("page down and page up jump between bucket headers", async () => {
  const s = await testRender(<App repos={[repo]} load={async () => demoBuckets(repo)} actions={noActions} />, { width: 110, height: 40 })
  const pageDown = () => press(s, () => s.mockInput.pressKey("\x1b[6~"))
  const pageUp = () => press(s, () => s.mockInput.pressKey("\x1b[5~"))
  try {
    await press(s)
    for (let i = 0; i < 4; i++) await pageDown() // -> "Drafts" header
    await press(s, () => s.mockInput.pressArrow("down")) // into the Drafts bucket
    await pageDown() // -> "Open" header
    await press(s, () => s.mockInput.pressKey("t")) // collapses whichever bucket the cursor is in
    expect(s.captureCharFrame()).toContain("▸ Open")
    await press(s, () => s.mockInput.pressKey("t"))
    await pageUp() // -> "Drafts" header
    await press(s, () => s.mockInput.pressKey("t"))
    expect(s.captureCharFrame()).toContain("▸ Drafts")
  } finally { s.renderer.destroy() }
})

test("watched changes move PRs at once, survive a lagging reload, and a merge shows under Approved for a while", async () => {
  let on!: Watcher
  const watch: Watch = w => { on = w; return () => {} }
  // Rules like toBuckets() gives its buckets, for the demo's author.
  const mine = (pr: PR) => pr.open && pr.author === "gregoryfoster"
  const rules: Record<string, (pr: PR) => boolean> = {
    "Approved": pr => mine(pr) && pr.review === "pass",
    "Waiting for reviewers": pr => mine(pr) && pr.review === "pending",
    "Open": pr => pr.open,
  }
  const withRules = (b: Bucket[]) => b.map(bucket => ({ ...bucket, accepts: rules[bucket.name] }))
  const demo = withRules(demoBuckets(repo))
  const [merging, dismissed] = demo[2]!.prs as [PR, PR]
  const fresh = { ...dismissed, review: "pending" as const, state: "review" as const }
  // The search index hasn't caught up: still under Approved, but with the fresh data.
  let loaded = demo
  const s = await testRender(<App repos={[repo]} load={async () => loaded} watch={watch} actions={noActions} justMergedMs={300} />, { width: 110, height: 40 })
  const order = () => {
    const frame = s.captureCharFrame()
    return ["Approved", "Just merged", "Waiting for reviewers", "fix(auth)", "Drafts"].map(t => frame.indexOf(t))
  }
  try {
    await press(s)
    await press(s, () => on.prs([fresh]))
    let [approved, , waiting, row, drafts] = order()
    expect(approved).toBeLessThan(waiting!)
    expect(waiting).toBeLessThan(row!)
    expect(row).toBeLessThan(drafts!)
    expect(s.captureCharFrame()).toContain("▾ Waiting for reviewers 1")

    loaded = withRules(demoBuckets(repo)).map(b => ({ ...b, prs: b.prs.map(pr => (pr.number === fresh.number ? fresh : pr)) }))
    await press(s, () => s.mockInput.pressKey("r"))
    ;[approved, , waiting, row] = order()
    expect(row).toBeGreaterThan(waiting!)

    await press(s, () => on.prs([{ ...merging, state: "merged", review: "merged", open: false }]))
    {
      const [approvedAt, justMerged, waitingAt] = order()
      expect(approvedAt).toBeLessThan(justMerged!)
      expect(justMerged).toBeLessThan(waitingAt!)
      const lines = s.captureCharFrame().split("\n")
      const header = lines.findIndex(l => l.includes("Approved - No pull requests")) // it left Approved
      expect(lines[header + 3]).toContain("▾ Just merged 1") // the next box down
    }
    await press(s, () => new Promise(r => setTimeout(r, 400)))
    expect(s.captureCharFrame()).not.toContain("Just merged")

    await press(s, () => on.error("HTTP 502"))
    expect(s.captureCharFrame()).toContain("✗ live updates paused: HTTP 502")
    await press(s, () => on.error(undefined))
    expect(s.captureCharFrame()).not.toContain("live updates paused")
  } finally { s.renderer.destroy() }
})
