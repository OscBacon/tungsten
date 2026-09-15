import { expect, test } from "bun:test"
import { BUCKETS, buildQuery, relativeTime, searchQuery, toBuckets } from "./github"
import { parseRepo } from "./repo"

const now = new Date("2026-09-15T15:00:00Z")

// Shaped like a real node from `gh api graphql` against cli/cli.
const node = (over: Record<string, unknown> = {}) => ({
  number: 14456,
  title: "Refreshable tokens (7/7): guided end-to-end verification scripts",
  url: "https://github.com/cli/cli/pull/14456",
  isDraft: false,
  state: "OPEN",
  additions: 1118,
  deletions: 0,
  updatedAt: "2026-09-15T01:49:02Z",
  reviewDecision: "REVIEW_REQUIRED",
  author: { login: "babakks" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
})
const rollup = (state: string | null) => ({ nodes: [{ commit: { statusCheckRollup: state && { state } } }] })
const search = (...nodes: object[]) => ({ issueCount: 318, nodes })

test("buildQuery searches every bucket in one request", () => {
  const q = buildQuery()
  expect(q).toContain("fragment pr on PullRequest")
  BUCKETS.forEach((_, i) => expect(q).toContain(`b${i}: search(query: $q${i}, type: ISSUE, first: 25)`))
  expect(searchQuery(parseRepo("cli/cli"), 0)).toBe("repo:cli/cli is:pr sort:updated-desc is:open user-review-requested:@me")
})

test("toBuckets maps search results onto PR rows", () => {
  const buckets = toBuckets({
    data: {
      b0: search(node(), {}), // {} is a non-PR search hit
      b1: search(node({ reviewDecision: "CHANGES_REQUESTED", author: null, commits: rollup("FAILURE") })),
      b2: search(node({ reviewDecision: "APPROVED", commits: { nodes: [] } })),
      b3: search(node({ reviewDecision: null, updatedAt: "2026-08-26T15:00:00Z", commits: rollup("PENDING") })),
      b4: search(node({ isDraft: true, commits: rollup("EXPECTED") })),
      b5: search(node({ author: { login: "someone-else" } })),
      b6: search(node({ state: "MERGED", reviewDecision: "APPROVED", updatedAt: "2025-01-01T00:00:00Z" })),
    },
  }, now)

  expect(buckets.map(b => b.name)).toEqual(BUCKETS.map(b => b.name))
  expect(buckets[0]).toEqual({
    name: "Needs your review",
    total: 318,
    prs: [{
      number: 14456, title: "Refreshable tokens (7/7): guided end-to-end verification scripts", author: "babakks",
      state: "review", ci: "pass", review: "pending", additions: 1118, deletions: 0, updated: "13h", stale: false,
      url: "https://github.com/cli/cli/pull/14456",
    }],
  })
  const row = (i: number) => buckets[i]!.prs[0]!
  expect(row(1)).toMatchObject({ state: "author", ci: "fail", review: "fail", author: "ghost" })
  expect(row(2)).toMatchObject({ state: "approved", ci: "pending", review: "pass" })
  expect(row(3)).toMatchObject({ state: "review", ci: "running", review: "pending", updated: "20d", stale: true })
  expect(row(4)).toMatchObject({ state: "draft", ci: "pending" })
  expect(buckets[5]!.name).toBe("Open")
  expect(row(5)).toMatchObject({ state: "review", author: "someone-else" })
  expect(row(6)).toMatchObject({ state: "merged", ci: "pass", review: "merged", updated: "1y", stale: false })
})

test("toBuckets: missing searches are empty, GraphQL errors throw", () => {
  expect(toBuckets({ data: {} }, now).every(b => b.total === 0 && b.prs.length === 0)).toBe(true)
  expect(() => toBuckets({ errors: [{ message: "Field 'bogus' doesn't exist on type 'Query'" }] }, now)).toThrow("Field 'bogus'")
})

test("relativeTime", () => {
  const ago = (s: number) => relativeTime(new Date(now.getTime() - s * 1000).toISOString(), now)
  expect([ago(5), ago(59 * 60), ago(3600), ago(23 * 3600), ago(86400), ago(400 * 86400), ago(-30)])
    .toEqual(["now", "59m", "1h", "23h", "1d", "1y", "now"])
})
