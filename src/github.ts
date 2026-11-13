import type { Bucket, PR, State, Status } from "./data"
import { normalizeHost, type Repo } from "./repo"
import { run } from "./run"

export const PAGE_SIZE = 25

const mine = (pr: PR, me: string) => pr.author.toLowerCase() === me

// One GitHub search per bucket; searchQuery() prepends the repo and sort.
// `has` is the same test done locally (`me` is your lowercased login), so a PR that changes
// can move between buckets right away; keep the two in step.
export const BUCKETS: { name: string; query: string; has: (pr: PR, me: string) => boolean }[] = [
  { name: "Needs your review", query: "is:open user-review-requested:@me", has: (pr, me) => pr.open && pr.reviewers.includes(me) },
  { name: "Returned to you", query: "is:open author:@me review:changes_requested", has: (pr, me) => pr.open && mine(pr, me) && pr.review === "fail" },
  { name: "Approved", query: "is:open author:@me review:approved", has: (pr, me) => pr.open && mine(pr, me) && pr.review === "pass" },
  // Not `review:required`: that never matches in repos without required reviews.
  { name: "Waiting for reviewers", query: "is:open author:@me -is:draft -review:approved -review:changes_requested", has: (pr, me) => pr.open && mine(pr, me) && !pr.draft && pr.review === "pending" },
  { name: "Drafts", query: "is:open author:@me draft:true", has: (pr, me) => pr.open && mine(pr, me) && pr.draft },
  { name: "Open", query: "is:open", has: pr => pr.open }, // everyone's, not just yours
  { name: "Recently merged", query: "is:merged author:@me", has: (pr, me) => pr.state === "merged" && mine(pr, me) },
]

// What the user typed after "/": words match titles, @login an author, #123 a PR number.
// Like GitHub's author: qualifiers, several authors mean any of them.
export interface Search {
  words: string[]
  authors: string[]
  numbers: PrRef[]
}

// #123 is that number in any repo shown; REPO#123 or OWNER/REPO#123 only in that one.
export interface PrRef {
  number: number
  repo?: string
}

export function parseSearch(input: string): Search {
  const search: Search = { words: [], authors: [], numbers: [] }
  for (const term of input.trim().split(/\s+/).filter(Boolean)) {
    const ref = term.match(/^([\w.-]+(?:\/[\w.-]+)?)?#(\d+)$/)
    if (/^@[^@\s]+$/.test(term)) search.authors.push(term.slice(1))
    else if (ref) search.numbers.push(ref[1] ? { number: Number(ref[2]), repo: ref[1] } : { number: Number(ref[2]) })
    else search.words.push(term)
  }
  return search
}

// Whether a REPO or OWNER/REPO typed in a search names this repo.
export function repoMatches(repo: Repo, typed: string): boolean {
  const t = typed.toLowerCase()
  return t === (t.includes("/") ? `${repo.owner}/${repo.name}` : repo.name).toLowerCase()
}

const refMatches = (ref: PrRef, repo: Repo, number: number) => ref.number === number && (!ref.repo || repoMatches(repo, ref.repo))

// The same test done locally, for --demo and for PRs looked up by number.
export function matches(pr: PR, s: Search): boolean {
  const title = pr.title.toLowerCase(), author = pr.author.toLowerCase()
  return (s.numbers.length === 0 || s.numbers.some(ref => refMatches(ref, pr.repo, pr.number)))
    && s.words.every(w => title.includes(w.toLowerCase()))
    && (s.authors.length === 0 || s.authors.some(a => author === a.toLowerCase()))
}

// Buckets of your own PRs. GitHub ORs author: qualifiers, so these can't take the search's authors;
// toBuckets() keeps them only when one of those authors is you.
const isMine = (i: number) => BUCKETS[i]!.query.includes("author:@me")

// GitHub search terms for the words and authors; numbers can't be searched, see buildNumbersQuery().
function searchTerms(s: Search, mine: boolean): string {
  const authors = mine ? [] : s.authors.map(a => `author:${a}`)
  return [...s.words, ...(s.words.length ? ["in:title"] : []), ...authors].join(" ")
}

// GitHub ORs repo: qualifiers, so one search covers every repo, sorted and counted together.
export const searchQuery = (repos: Repo[], i: number, search?: Search) =>
  [`${repos.map(r => `repo:${r.owner}/${r.name}`).join(" ")} is:pr sort:updated-desc ${BUCKETS[i]!.query}`, search && searchTerms(search, isMine(i))].filter(Boolean).join(" ")

const FIELDS = `number title url repository { name owner { login } } isDraft state additions deletions updatedAt reviewDecision
  author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 25) { nodes { requestedReviewer { ... on User { login } } } }
  headRefName isCrossRepository headRepositoryOwner { login } baseRepository { defaultBranchRef { name } }`

// Searches are passed as variables, so repo names never need escaping in the query text.
export function buildQuery(): string {
  const vars = BUCKETS.map((_, i) => `$q${i}: String!`).join(", ")
  const searches = BUCKETS.map((_, i) => `b${i}: search(query: $q${i}, type: ISSUE, first: ${PAGE_SIZE}) { issueCount nodes { ...pr } }`)
  return `fragment pr on PullRequest { ${FIELDS} }\nquery(${vars}) {\n  viewer { login }\n  ${searches.join("\n  ")}\n}`
}

// The numbers to look up in each repo; repos with none are left out.
export function numberLookups(repos: Repo[], refs: PrRef[]): { repo: Repo; numbers: number[] }[] {
  return repos
    .map(repo => ({ repo, numbers: [...new Set(refs.filter(r => !r.repo || repoMatches(repo, r.repo)).map(r => r.number))] }))
    .filter(l => l.numbers.length > 0)
}

// Search doesn't match PR numbers, so #123 looks each one up directly, in every repo it may be in.
export function buildNumbersQuery(lookups: { numbers: number[] }[]): string {
  const vars = lookups.map((_, i) => `$owner${i}: String!, $name${i}: String!`).join(", ")
  const repos = lookups.map(({ numbers }, i) =>
    `r${i}: repository(owner: $owner${i}, name: $name${i}) { ${numbers.map(n => `n${n}: pullRequest(number: ${n}) { ...pr }`).join(" ")} }`)
  return `fragment pr on PullRequest { ${FIELDS} }\nquery(${vars}) {\n  ${repos.join("\n  ")}\n}`
}

interface PrNode {
  number: number
  title: string
  url: string
  repository: { name: string; owner: { login: string } }
  isDraft: boolean
  state: string // OPEN | CLOSED | MERGED
  additions: number
  deletions: number
  updatedAt: string
  reviewDecision: string | null // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  author: { login: string } | null // null for deleted accounts
  commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] }
  reviewRequests: { nodes: ({ requestedReviewer: { login?: string } | null } | null)[] } // teams have no login
  headRefName: string
  isCrossRepository: boolean
  headRepositoryOwner: { login: string } | null // null once the fork is deleted
  baseRepository: { defaultBranchRef: { name: string } | null } | null
}

interface SearchResult {
  issueCount: number
  nodes: unknown[]
}

export interface SearchResponse {
  data?: Record<string, SearchResult | { login: string } | null> // b0..b6, plus viewer
  errors?: { message: string }[]
}

export interface NumbersResponse {
  data?: Record<string, Record<string, unknown> | null> | null // r0, r1, ... holding n<number>
  errors?: { message: string; type?: string }[]
}

// Non-PR search hits come back as empty objects.
const isPrNode = (n: unknown): n is PrNode => typeof n === "object" && n !== null && "number" in n

const CI: Record<string, Status> = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "running" }

// Like gh pr checkout: a fork's branch named after the default branch would clash with it,
// so it gets the fork owner as a prefix.
export function localBranch(n: Pick<PrNode, "headRefName" | "isCrossRepository" | "headRepositoryOwner" | "baseRepository">): string {
  const clashes = n.isCrossRepository && n.headRefName === n.baseRepository?.defaultBranchRef?.name
  return clashes ? `${n.headRepositoryOwner?.login ?? "ghost"}/${n.headRefName}` : n.headRefName
}

function toPR(n: PrNode): PR {
  const merged = n.state === "MERGED"
  const state: State =
    merged ? "merged" :
    n.isDraft ? "draft" :
    n.reviewDecision === "APPROVED" ? "approved" :
    n.reviewDecision === "CHANGES_REQUESTED" ? "author" :
    "review"
  const review: Status =
    merged ? "merged" :
    n.reviewDecision === "APPROVED" ? "pass" :
    n.reviewDecision === "CHANGES_REQUESTED" ? "fail" :
    "pending"
  const rollup = n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ""

  return {
    number: n.number,
    title: n.title,
    author: n.author?.login ?? "ghost",
    state,
    ci: CI[rollup] ?? "pending",
    review,
    additions: n.additions,
    deletions: n.deletions,
    updatedAt: n.updatedAt,
    open: n.state === "OPEN",
    draft: n.isDraft,
    reviewers: n.reviewRequests.nodes.flatMap(r => r?.requestedReviewer?.login?.toLowerCase() ?? []),
    url: n.url,
    // The API host isn't in the response, but it's the one in the PR's url.
    repo: { host: normalizeHost(new URL(n.url).hostname), owner: n.repository.owner.login, name: n.repository.name },
    branch: localBranch(n),
  }
}

export function toBuckets(res: SearchResponse, search?: Search): Bucket[] {
  if (res.errors?.length) throw new Error(res.errors.map(e => e.message).join("; "))
  const viewer = (res.data?.viewer as { login: string } | undefined)?.login.toLowerCase() ?? ""
  const notMe = !!search?.authors.length && !search.authors.some(a => a.toLowerCase() === viewer)
  return BUCKETS.map((b, i) => {
    if (notMe && isMine(i)) return { name: b.name, total: 0, prs: [], accepts: () => false }
    const result = res.data?.[`b${i}`] as SearchResult | null | undefined
    const accepts = (pr: PR) => b.has(pr, viewer) && (!search || matches(pr, search))
    return { name: b.name, total: result?.issueCount ?? 0, prs: (result?.nodes ?? []).filter(isPrNode).map(toPR), accepts }
  })
}

// The PRs a lookup by number found; a missing number is a NOT_FOUND error next to them.
export function toPrs(res: NumbersResponse): PR[] {
  const errors = res.errors?.filter(e => e.type !== "NOT_FOUND") ?? []
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "))
  return Object.values(res.data ?? {})
    .flatMap(repo => Object.values(repo ?? {}))
    .filter(isPrNode)
    .map(toPR)
}

// One "Search results" bucket with the PRs that exist, narrowed by the other terms.
export function searchResults(prs: PR[], search: Search): Bucket {
  const accepts = (pr: PR) => matches(pr, search)
  return { name: "Search results", prs: prs.filter(accepts), accepts }
}

async function gh(args: string[]) {
  try {
    return await run("gh", args)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("gh is not installed (https://cli.github.com); run with --demo to try the UI")
    throw e
  }
}

// gh handles auth and the API host, so no token ever passes through here.
async function graphql<T extends { errors?: unknown[] }>(host: string, fields: Record<string, string>): Promise<T> {
  const { code, stdout, stderr } = await gh([
    "api", "graphql", "--hostname", host,
    ...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
  ])

  let res: T | undefined
  try {
    res = JSON.parse(stdout)
  } catch {
    // Not JSON: gh failed before querying (not logged in, network, ...).
  }
  // GraphQL errors exit non-zero but still print the response, which carries the useful message.
  if (res && (code === 0 || res.errors?.length)) return res
  throw new Error(stderr.trim().split("\n")[0] || `gh exited with code ${code}`)
}

// Looks PRs up by number: for #123 searches, and to refresh the PRs that changed (see poll.ts).
export async function fetchPrs(host: string, lookups: { repo: Repo; numbers: number[] }[]): Promise<PR[]> {
  if (lookups.length === 0) return []
  const res = await graphql<NumbersResponse>(host, {
    query: buildNumbersQuery(lookups),
    ...Object.fromEntries(lookups.flatMap(({ repo }, i) => [[`owner${i}`, repo.owner], [`name${i}`, repo.name]])),
  })
  return toPrs(res)
}

// The repos all share a host (see index.tsx), so one request covers them.
export async function fetchBuckets(repos: Repo[], search?: Search): Promise<Bucket[]> {
  const host = repos[0]!.host
  if (search?.numbers.length) return [searchResults(await fetchPrs(host, numberLookups(repos, search.numbers)), search)]
  const res = await graphql<SearchResponse>(host, {
    query: buildQuery(),
    ...Object.fromEntries(BUCKETS.map((_, i) => [`q${i}`, searchQuery(repos, i, search)])),
  })
  return toBuckets(res, search)
}

export const PULLS_PAGE = 10

export interface PullsPage {
  etag?: string
  pulls: { number: number; updatedAt: string }[] // most recently updated first
}

// `gh api --include` output: a status line, headers, a blank line, then the body.
export function parseHttp(out: string): { status: number; headers: Record<string, string>; body: string } | undefined {
  const end = out.search(/\r?\n\r?\n/)
  const [first, ...lines] = (end < 0 ? out : out.slice(0, end)).split(/\r?\n/)
  const status = first?.match(/^HTTP\/\S+ (\d{3})/)?.[1]
  if (!status) return undefined
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return { status: Number(status), headers, body: end < 0 ? "" : out.slice(end).trimStart() }
}

// The repo's most recently updated PRs, over REST because it takes an ETag: an unchanged
// list is a 304 that doesn't count against the rate limit, and resolves to undefined.
export async function fetchPullsPage(repo: Repo, etag?: string): Promise<PullsPage | undefined> {
  const { code, stdout, stderr } = await gh([
    "api", "--include", "--hostname", repo.host,
    ...(etag ? ["-H", `If-None-Match: ${etag}`] : []),
    `repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&per_page=${PULLS_PAGE}`,
  ])
  // gh exits non-zero on a 304 too, so the status line decides.
  const res = parseHttp(stdout)
  if (res?.status === 304) return undefined
  if (res?.status !== 200) throw new Error(stderr.trim().split("\n")[0] || `gh exited with code ${code}`)
  const pulls = JSON.parse(res.body) as { number: number; updated_at: string }[]
  return { etag: res.headers.etag, pulls: pulls.map(p => ({ number: p.number, updatedAt: p.updated_at })) }
}
