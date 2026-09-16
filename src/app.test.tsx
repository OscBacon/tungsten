import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App } from "./app"
import { demoBuckets, type Bucket } from "./data"
import { parseRepo } from "./repo"

const press = async (s: Awaited<ReturnType<typeof testRender>>, fn: () => void = () => {}) => {
  await act(async () => { fn(); await new Promise(r => setTimeout(r, 10)) })
  await s.renderOnce()
}

const repo = parseRepo("withgraphite/monologue")

test("arrows move, t collapses the current bucket, cursor lands on its header", async () => {
  const s = await testRender(<App repo={repo} load={async () => demoBuckets(repo)} />, { width: 110, height: 20 })
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

  const s = await testRender(<App repo={repo} load={load} />, { width: 110, height: 20 })
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
  const s = await testRender(<App repo={repo} load={async () => buckets} />, { width: 110, height: 20 })
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
