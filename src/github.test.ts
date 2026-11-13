import { expect, test } from "bun:test"
import { isStale, relativeTime, type PR } from "./data"
import { BUCKETS, buildNumbersQuery, buildQuery, localBranch, numberLookups, parseHttp, parseSearch, searchQuery, searchResults, toBuckets, toPrs, type NumbersResponse } from "./github"
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
  reviewRequests: { nodes: [{ requestedReviewer: { login: "OscBacon" } }, { requestedReviewer: {} }] }, // {} is a team
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
  })

  expect(buckets.map(b => b.name)).toEqual(BUCKETS.map(b => b.name))
  expect(buckets[0]).toMatchObject({
    name: "Needs your review",
    total: 318,
    prs: [{
      number: 14456, title: "Refreshable tokens (7/7): guided end-to-end verification scripts", author: "babakks",
      state: "review", ci: "pass", review: "pending", additions: 1118, deletions: 0, updatedAt: "2026-09-15T01:49:02Z",
      open: true, draft: false, reviewers: ["oscbacon"],
      url: "https://github.com/cli/cli/pull/14456", repo: { host: "github.com", owner: "cli", name: "cli" }, branch: "babakks/refreshable-tokens-7",
    }],
  })
  const row = (i: number) => buckets[i]!.prs[0]!
  expect(row(1)).toMatchObject({ state: "author", ci: "fail", review: "fail", author: "ghost" })
  expect(row(2)).toMatchObject({ state: "approved", ci: "pending", review: "pass" })
  expect(row(3)).toMatchObject({ state: "review", ci: "running", review: "pending" })
  expect(isStale(row(3), now)).toBe(true)
  expect(row(4)).toMatchObject({ state: "draft", draft: true, ci: "pending" })
  expect(buckets[5]!.name).toBe("Open")
  expect(row(5)).toMatchObject({ state: "review", author: "someone-else" })
  expect(row(6)).toMatchObject({ state: "merged", open: false, ci: "pass", review: "merged" })
  expect(isStale(row(6), now)).toBe(false)
  expect(relativeTime(row(6).updatedAt, now)).toBe("1y")
})

test("each bucket's local test matches its search, so a changed PR can move", () => {
  const res = { data: { viewer: { login: "OscBacon" } } }
  const pr = toBuckets({ data: { b5: search(node()) } })[5]!.prs[0]!
  const into = (over: Partial<PR>, q?: string) =>
    toBuckets(res, q === undefined ? undefined : parseSearch(q)).filter(b => b.accepts!({ ...pr, ...over })).map(b => b.name)

  expect(into({})).toEqual(["Needs your review", "Open"])
  expect(into({ author: "oscbacon", reviewers: [], review: "fail", state: "author" })).toEqual(["Returned to you", "Open"])
  expect(into({ author: "OscBacon", reviewers: [], review: "pass", state: "approved" })).toEqual(["Approved", "Open"])
  expect(into({ author: "OscBacon", reviewers: [] })).toEqual(["Waiting for reviewers", "Open"])
  expect(into({ author: "OscBacon", reviewers: [], draft: true, state: "draft" })).toEqual(["Drafts", "Open"])
  expect(into({ author: "OscBacon", open: false, state: "merged", review: "merged" })).toEqual(["Recently merged"])
  expect(into({ open: false })).toEqual([]) // closed

  // A search narrows them like it narrows the searches.
  expect(into({}, "refreshable")).toEqual(["Needs your review", "Open"])
  expect(into({}, "nope")).toEqual([])
  expect(into({ author: "OscBacon", reviewers: [] }, "@babakks")).toEqual([]) // your buckets are emptied
})

test("toBuckets: missing searches are empty, GraphQL errors throw", () => {
  expect(toBuckets({ data: {} }).every(b => b.total === 0 && b.prs.length === 0)).toBe(true)
  expect(() => toBuckets({ errors: [{ message: "Field 'bogus' doesn't exist on type 'Query'" }] })).toThrow("Field 'bogus'")
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
  const totals = (q: string) => toBuckets(res, parseSearch(q)).map(b => b.total)
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
  const found = (q: string) => searchResults(toPrs(res), parseSearch(q))
  expect(found("#1 #2 #3").prs.map(p => p.number)).toEqual([1, 2])
  expect(found("#1 #2 fix").prs.map(p => p.number)).toEqual([1])
  expect(found("#1 @someone")).toMatchObject({ name: "Search results", prs: [] })
  expect(found("#1 @someone @BABAKKS").prs.map(p => p.number)).toEqual([1])
  expect(() => toPrs({ errors: [{ type: "FORBIDDEN", message: "nope" }] })).toThrow("nope")
})

test("several repos: one search ORs their repo: terms, rows carry their repo", () => {
  const repos = ["acme/app", "acme/app-ios"].map(r => parseRepo(r))
  expect(searchQuery(repos, 5, parseSearch("fix"))).toBe("repo:acme/app repo:acme/app-ios is:pr sort:updated-desc is:open fix in:title")

  const ios = node({ number: 7, url: "https://github.com/acme/app-ios/pull/7", repository: { name: "app-ios", owner: { login: "acme" } } })
  expect(toBuckets({ data: { b5: search(ios) } })[5]!.prs[0]!.repo).toEqual(repos[1]!)
})

test("#numbers across several repos: every repo, or only the one named", () => {
  const repos = ["acme/app", "acme/app-ios", "other/app"].map(r => parseRepo(r))
  const names = (q: string) => numberLookups(repos, parseSearch(q).numbers).map(l => `${l.repo.owner}/${l.repo.name} ${l.numbers}`)
  expect(names("#1 #2")).toEqual(["acme/app 1,2", "acme/app-ios 1,2", "other/app 1,2"])
  expect(names("app-ios#1 #2")).toEqual(["acme/app 2", "acme/app-ios 1,2", "other/app 2"])
  expect(names("Acme/App#1")).toEqual(["acme/app 1"])
  expect(names("app#1")).toEqual(["acme/app 1", "other/app 1"])
  expect(names("nope#1")).toEqual([])

  const q = buildNumbersQuery([{ numbers: [1] }, { numbers: [1, 2] }])
  expect(q).toContain("query($owner0: String!, $name0: String!, $owner1: String!, $name1: String!)")
  expect(q).toContain("r1: repository(owner: $owner1, name: $name1) { n1: pullRequest(number: 1) { ...pr } n2: pullRequest(number: 2) { ...pr } }")

  // The same number from two repos is two PRs; a REPO#n term keeps only that repo's.
  const at = (name: string, number: number) => node({ number, url: `https://github.com/acme/${name}/pull/${number}`, repository: { name, owner: { login: "acme" } } })
  const res: NumbersResponse = { data: { r0: { n1: at("app", 1) }, r1: { n1: at("app-ios", 1), n2: at("app-ios", 2) } } }
  const found = (q: string) => searchResults(toPrs(res), parseSearch(q)).prs.map(p => `${p.repo.name}#${p.number}`)
  expect(found("#1 #2")).toEqual(["app#1", "app-ios#1", "app-ios#2"])
  expect(found("app-ios#1")).toEqual(["app-ios#1"])
})

test("parseHttp reads gh api --include output, with or without a body", () => {
  const ok = parseHttp('HTTP/2.0 200 OK\nAccess-Control-Allow-Origin: *\r\nEtag: W/"abc"\r\n\r\n[{"number":1}]')
  expect(ok).toEqual({ status: 200, headers: { "access-control-allow-origin": "*", etag: 'W/"abc"' }, body: '[{"number":1}]' })
  expect(parseHttp('HTTP/2.0 304 Not Modified\nEtag: W/"abc"\r\n\r\n')).toMatchObject({ status: 304, body: "" })
  expect(parseHttp("")).toBeUndefined()
})
