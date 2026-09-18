import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App, type Actions } from "./app"
import { demoBuckets, type Bucket } from "./data"
import { parseRepo } from "./repo"

const press = async (s: Awaited<ReturnType<typeof testRender>>, fn: () => unknown = () => {}) => {
  await act(async () => { await fn(); await new Promise(r => setTimeout(r, 10)) })
  await s.renderOnce()
}

const repo = parseRepo("withgraphite/monologue")
const noActions: Actions = { checkout: async () => "", worktree: async () => "" }

test("arrows move, t collapses the current bucket, cursor lands on its header", async () => {
  const s = await testRender(<App repo={repo} load={async () => demoBuckets(repo)} actions={noActions} />, { width: 110, height: 20 })
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

  const s = await testRender(<App repo={repo} load={load} actions={noActions} />, { width: 110, height: 20 })
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
  const s = await testRender(<App repo={repo} load={async () => buckets} actions={noActions} />, { width: 110, height: 20 })
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
  const s = await testRender(<App repo={repo} load={async () => demoBuckets(repo)} actions={noActions} />, { width: 110, height: 20 })
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
  const s = await testRender(<App repo={repo} load={load} actions={noActions} />, { width: 110, height: 20 })
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
    expect(frame).toContain("r refresh") // the footer is back

    await press(s, () => s.mockInput.pressKey("r")) // refresh keeps the search
    expect(searches.at(-1)).toBe("refactor rt")

    await press(s, () => s.mockInput.pressEscape())
    await press(s)
    expect(searches.at(-1)).toBeUndefined()
    expect(s.captureCharFrame()).toContain("only find upstack")

    // esc in the prompt also clears an applied search
    await press(s, () => s.mockInput.pressKey("/"))
    await press(s, () => s.mockInput.typeText("@someone"))
    await press(s, () => s.mockInput.pressEnter())
    expect(searches.at(-1)).toBe("@someone")
    await press(s, () => s.mockInput.pressKey("/"))
    expect(s.captureCharFrame()).toContain("/ @someone█") // reopens with the current search
    await press(s, () => s.mockInput.pressEscape())
    await press(s)
    expect(searches.at(-1)).toBeUndefined()
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
  const s = await testRender(<App repo={repo} load={async () => demoBuckets(repo)} actions={actions} />, { width: 110, height: 20 })
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
