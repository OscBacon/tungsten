import { expect, test } from "bun:test"
import { BUCKETS, buildNumbersQuery, buildQuery, localBranch, numberLookups, parseSearch, relativeTime, searchQuery, toBuckets, toNumbersBucket } from "./github"
import { parseRepo } from "./repo"

const now = new Date("2026-09-15T15:00:00Z")

// Shaped like a real node from `gh api graphql` against cli/cli.
const node = (over: Record<string, unknown> = {}) => ({
  number: 14456,
  title: "Refreshable tokens (7/7): guided end-to-end verification scripts",
  url: "https://github.com/cli/cli/pull/14456",
  repository: { name: "cli", owner: { login: "cli" } },
  isDraft: false,
  state: "OPEN",
  additions: 1118,
  deletions: 0,
  updatedAt: "2026-09-15T01:49:02Z",
  reviewDecision: "REVIEW_REQUIRED",
  author: { login: "babakks" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  headRefName: "babakks/refreshable-tokens-7",
  isCrossRepository: false,
  headRepositoryOwner: { login: "cli" },
  baseRepository: { defaultBranchRef: { name: "trunk" } },
  ...over,
})
const rollup = (state: string | null) => ({ nodes: [{ commit: { statusCheckRollup: state && { state } } }] })
const search = (...nodes: object[]) => ({ issueCount: 318, nodes })

test("buildQuery searches every bucket in one request", () => {
  const q = buildQuery()
  expect(q).toContain("fragment pr on PullRequest")
  BUCKETS.forEach((_, i) => expect(q).toContain(`b${i}: search(query: $q${i}, type: ISSUE, first: 25)`))
  expect(searchQuery([parseRepo("cli/cli")], 0)).toBe("repo:cli/cli is:pr sort:updated-desc is:open user-review-requested:@me")
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
      url: "https://github.com/cli/cli/pull/14456", repo: { host: "github.com", owner: "cli", name: "cli" }, branch: "babakks/refreshable-tokens-7",
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

test("localBranch follows gh: a fork's branch named like the default branch gets the owner as a prefix", () => {
  const pr = (over: object) => ({ headRefName: "fix", isCrossRepository: false, headRepositoryOwner: { login: "cli" }, baseRepository: { defaultBranchRef: { name: "trunk" } }, ...over })
  expect(localBranch(pr({}))).toBe("fix")
  expect(localBranch(pr({ isCrossRepository: true, headRepositoryOwner: { login: "octo" } }))).toBe("fix")
  expect(localBranch(pr({ isCrossRepository: true, headRefName: "trunk", headRepositoryOwner: { login: "octo" } }))).toBe("octo/trunk")
  expect(localBranch(pr({ isCrossRepository: true, headRefName: "trunk", headRepositoryOwner: null }))).toBe("ghost/trunk")
})

test("parseSearch splits words, @authors and #numbers; searchQuery adds them to every bucket", () => {
  const s = parseSearch("  fix @babakks  #123 token# ")
  expect(s).toEqual({ words: ["fix", "token#"], authors: ["babakks"], numbers: [{ number: 123 }] })
  expect(parseSearch("")).toEqual({ words: [], authors: [], numbers: [] })
  expect(parseSearch("go-gh#7 cli/cli#8 a/b/c#9").numbers).toEqual([{ number: 7, repo: "go-gh" }, { number: 8, repo: "cli/cli" }])

  const repo = [parseRepo("cli/cli")]
  expect(searchQuery(repo, 5, s)).toBe("repo:cli/cli is:pr sort:updated-desc is:open fix token# in:title author:babakks")
  expect(searchQuery(repo, 5, parseSearch("@babakks"))).toBe("repo:cli/cli is:pr sort:updated-desc is:open author:babakks")
  // GitHub would OR a second author: into author:@me, so your own buckets leave it out.
  expect(searchQuery(repo, 6, s)).toBe("repo:cli/cli is:pr sort:updated-desc is:merged author:@me fix token# in:title")
})

test("an @author search empties your own buckets unless the author is you", () => {
  const res = { data: { viewer: { login: "OscBacon" }, ...Object.fromEntries(BUCKETS.map((_, i) => [`b${i}`, search(node())])) } }
  const totals = (q: string) => toBuckets(res, now, parseSearch(q)).map(b => b.total)
  expect(totals("fix")).toEqual([318, 318, 318, 318, 318, 318, 318])
  expect(totals("@babakks")).toEqual([318, 0, 0, 0, 0, 318, 0])
  expect(totals("@babakks @oscbacon")).toEqual([318, 318, 318, 318, 318, 318, 318])
  expect(buildQuery()).toContain("viewer { login }")
})

test("#numbers are looked up directly and narrowed by the other terms", () => {
  expect(buildNumbersQuery([{ numbers: [12, 34] }])).toContain("r0: repository(owner: $owner0, name: $name0) { n12: pullRequest(number: 12) { ...pr } n34: pullRequest(number: 34) { ...pr } }")

  const res = {
    data: { r0: { n1: node({ number: 1, title: "Fix tokens" }), n2: node({ number: 2, title: "Docs" }), n3: null } },
    errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 3." }],
  }
  expect(toNumbersBucket(res, parseSearch("#1 #2 #3"), now).prs.map(p => p.number)).toEqual([1, 2])
  expect(toNumbersBucket(res, parseSearch("#1 #2 fix"), now).prs.map(p => p.number)).toEqual([1])
  expect(toNumbersBucket(res, parseSearch("#1 @someone"), now)).toEqual({ name: "Search results", prs: [] })
  expect(toNumbersBucket(res, parseSearch("#1 @someone @BABAKKS"), now).prs.map(p => p.number)).toEqual([1])
  expect(() => toNumbersBucket({ errors: [{ type: "FORBIDDEN", message: "nope" }] }, parseSearch("#1"), now)).toThrow("nope")
})

test("several repos: one search ORs their repo: terms, rows carry their repo", () => {
  const repos = ["movablevoice/workfone", "movablevoice/workfone-ios"].map(r => parseRepo(r))
  expect(searchQuery(repos, 5, parseSearch("fix"))).toBe("repo:movablevoice/workfone repo:movablevoice/workfone-ios is:pr sort:updated-desc is:open fix in:title")

  const ios = node({ number: 7, url: "https://github.com/movablevoice/workfone-ios/pull/7", repository: { name: "workfone-ios", owner: { login: "movablevoice" } } })
  expect(toBuckets({ data: { b5: search(ios) } }, now)[5]!.prs[0]!.repo).toEqual(repos[1]!)
})

test("#numbers across several repos: every repo, or only the one named", () => {
  const repos = ["movablevoice/workfone", "movablevoice/workfone-ios", "other/workfone"].map(r => parseRepo(r))
  const names = (q: string) => numberLookups(repos, parseSearch(q).numbers).map(l => `${l.repo.owner}/${l.repo.name} ${l.numbers}`)
  expect(names("#1 #2")).toEqual(["movablevoice/workfone 1,2", "movablevoice/workfone-ios 1,2", "other/workfone 1,2"])
  expect(names("workfone-ios#1 #2")).toEqual(["movablevoice/workfone 2", "movablevoice/workfone-ios 1,2", "other/workfone 2"])
  expect(names("Movablevoice/Workfone#1")).toEqual(["movablevoice/workfone 1"])
  expect(names("workfone#1")).toEqual(["movablevoice/workfone 1", "other/workfone 1"])
  expect(names("nope#1")).toEqual([])

  const q = buildNumbersQuery([{ numbers: [1] }, { numbers: [1, 2] }])
  expect(q).toContain("query($owner0: String!, $name0: String!, $owner1: String!, $name1: String!)")
  expect(q).toContain("r1: repository(owner: $owner1, name: $name1) { n1: pullRequest(number: 1) { ...pr } n2: pullRequest(number: 2) { ...pr } }")

  // The same number from two repos is two PRs; a REPO#n term keeps only that repo's.
  const at = (name: string, number: number) => node({ number, url: `https://github.com/movablevoice/${name}/pull/${number}`, repository: { name, owner: { login: "movablevoice" } } })
  const res = { data: { r0: { n1: at("workfone", 1) }, r1: { n1: at("workfone-ios", 1), n2: at("workfone-ios", 2) } } }
  const found = (q: string) => toNumbersBucket(res, parseSearch(q), now).prs.map(p => `${p.repo.name}#${p.number}`)
  expect(found("#1 #2")).toEqual(["workfone#1", "workfone-ios#1", "workfone-ios#2"])
  expect(found("workfone-ios#1")).toEqual(["workfone-ios#1"])
})
