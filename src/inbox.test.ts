import { expect, test } from "bun:test"
import { demoBuckets, type Bucket, type PR } from "./data"
import { JUST_MERGED, place, withJustMerged } from "./inbox"
import { parseRepo } from "./repo"

const repo = parseRepo("withgraphite/monologue")
const [a, b] = demoBuckets(repo)[0]!.prs as [PR, PR]
const at = (iso: string) => ({ updatedAt: iso })
const names = (bucket: Bucket) => bucket.prs.map(pr => pr.number)

test("place moves a changed PR out of the buckets it left and into those that accept it, newest first", () => {
  const buckets: Bucket[] = [
    { name: "Approved", total: 1, prs: [a], accepts: pr => pr.review === "pass" },
    { name: "Waiting", total: 1, prs: [{ ...b, ...at("2026-01-01T00:00:00Z") }], accepts: pr => pr.review === "pending" },
    { name: "Search results", prs: [a] }, // no rule: only updated where it is
  ]
  const changed = { ...a, review: "pending" as const, ...at("2026-02-01T00:00:00Z") }
  const [approved, waiting, results] = place(buckets, [changed])
  expect(approved).toMatchObject({ total: 0, prs: [] })
  expect(names(waiting!)).toEqual([a.number, b.number])
  expect(waiting!.total).toBe(2)
  expect(results!.prs).toEqual([changed])

  // Unchanged buckets come back as they were, so nothing redraws for them.
  expect(place(buckets, [{ ...b, review: "pending" }])[0]).toBe(buckets[0]!)
})

test("place: a paged bucket doesn't count a PR it didn't list, which it may count already", () => {
  const open: Bucket = { name: "Open", total: 42, prs: [a], accepts: pr => pr.open }
  expect(place([open], [b])[0]).toMatchObject({ total: 42 })
  expect(place([open], [{ ...a, open: false }])[0]).toMatchObject({ total: 41, prs: [] })
  expect(place([{ ...open, total: 1 }], [b])[0]).toMatchObject({ total: 2 })
})

test("withJustMerged lists merged PRs right under Approved, only while there are some", () => {
  const buckets: Bucket[] = [{ name: "Approved", prs: [] }, { name: "Open", prs: [] }]
  expect(withJustMerged(buckets, [])).toBe(buckets)
  expect(withJustMerged(buckets, [a]).map(b => b.name)).toEqual(["Approved", JUST_MERGED, "Open"])
  expect(withJustMerged([{ name: "Search results", prs: [] }], [a]).map(b => b.name)).toEqual(["Search results"])
})
