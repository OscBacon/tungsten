import { expect, test } from "bun:test"
import { demoBuckets } from "./data"
import { PULLS_PAGE } from "./github"
import { diffPulls, runningCi } from "./poll"
import { parseRepo } from "./repo"

const page = (...pulls: [number, string][]) => pulls.map(([number, updatedAt]) => ({ number, updatedAt }))

test("diffPulls: the first page is the baseline, later ones name what changed", () => {
  expect(diffPulls(undefined, page([1, "t1"], [2, "t1"]))).toEqual({ changed: [], overflow: false })
  const seen = new Map([[1, "t1"], [2, "t1"]])
  expect(diffPulls(seen, page([2, "t2"], [3, "t2"], [1, "t1"]))).toEqual({ changed: [2, 3], overflow: false })
})

test("diffPulls: a full page where everything changed may hide more changes", () => {
  const full = Array.from({ length: PULLS_PAGE }, (_, i): [number, string] => [i, "new"])
  expect(diffPulls(new Map(), page(...full)).overflow).toBe(true)
  expect(diffPulls(new Map([[0, "new"]]), page(...full)).overflow).toBe(false)
})

test("runningCi picks open PRs whose CI is running, once each", () => {
  const prs = demoBuckets(parseRepo("withgraphite/monologue")).flatMap(b => b.prs)
  const running = prs.filter(pr => pr.ci === "running")
  expect(running.length).toBeGreaterThan(0)
  expect(runningCi([...prs, ...prs]).map(pr => pr.number)).toEqual(running.map(pr => pr.number))
  expect(runningCi(running.map(pr => ({ ...pr, open: false })))).toEqual([])
})
