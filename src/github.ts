import type { Bucket, PR, State, Status } from "./data"
import type { Repo } from "./repo"
import { run } from "./run"

export const PAGE_SIZE = 25
const STALE_DAYS = 14

// One GitHub search per bucket; searchQuery() prepends the repo and sort.
export const BUCKETS = [
  { name: "Needs your review", query: "is:open user-review-requested:@me" },
  { name: "Returned to you", query: "is:open author:@me review:changes_requested" },
  { name: "Approved", query: "is:open author:@me review:approved" },
  // Not `review:required`: that never matches in repos without required reviews.
  { name: "Waiting for reviewers", query: "is:open author:@me -is:draft -review:approved -review:changes_requested" },
  { name: "Drafts", query: "is:open author:@me draft:true" },
  { name: "Open", query: "is:open" }, // everyone's, not just yours
  { name: "Recently merged", query: "is:merged author:@me" },
]

// What the user typed after "/": words match titles, @login an author, #123 a PR number.
// Like GitHub's author: qualifiers, several authors mean any of them.
export interface Search {
  words: string[]
  authors: string[]
  numbers: number[]
}

export function parseSearch(input: string): Search {
  const search: Search = { words: [], authors: [], numbers: [] }
  for (const term of input.trim().split(/\s+/).filter(Boolean)) {
    if (/^@[^@\s]+$/.test(term)) search.authors.push(term.slice(1))
    else if (/^#\d+$/.test(term)) search.numbers.push(Number(term.slice(1)))
    else search.words.push(term)
  }
  return search
}

// The same test done locally, for --demo and for PRs looked up by number.
export function matches(pr: PR, s: Search): boolean {
  const title = pr.title.toLowerCase(), author = pr.author.toLowerCase()
  return (s.numbers.length === 0 || s.numbers.includes(pr.number))
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

export const searchQuery = (repo: Repo, i: number, search?: Search) =>
  [`repo:${repo.owner}/${repo.name} is:pr sort:updated-desc ${BUCKETS[i]!.query}`, search && searchTerms(search, isMine(i))].filter(Boolean).join(" ")

const FIELDS = `number title url isDraft state additions deletions updatedAt reviewDecision
  author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  headRefName isCrossRepository headRepositoryOwner { login } baseRepository { defaultBranchRef { name } }`

// Searches are passed as variables, so repo names never need escaping in the query text.
export function buildQuery(): string {
  const vars = BUCKETS.map((_, i) => `$q${i}: String!`).join(", ")
  const searches = BUCKETS.map((_, i) => `b${i}: search(query: $q${i}, type: ISSUE, first: ${PAGE_SIZE}) { issueCount nodes { ...pr } }`)
  return `fragment pr on PullRequest { ${FIELDS} }\nquery(${vars}) {\n  viewer { login }\n  ${searches.join("\n  ")}\n}`
}

// Search doesn't match PR numbers, so #123 looks each one up directly.
export function buildNumbersQuery(numbers: number[]): string {
  const prs = numbers.map(n => `n${n}: pullRequest(number: ${n}) { ...pr }`)
  return `fragment pr on PullRequest { ${FIELDS} }\nquery($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) { ${prs.join(" ")} }\n}`
}

interface PrNode {
  number: number
  title: string
  url: string
  isDraft: boolean
  state: string // OPEN | CLOSED | MERGED
  additions: number
  deletions: number
  updatedAt: string
  reviewDecision: string | null // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED
  author: { login: string } | null // null for deleted accounts
  commits: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] }
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
  data?: { repository: Record<string, unknown> | null } | null
  errors?: { message: string; type?: string }[]
}

// Non-PR search hits come back as empty objects.
const isPrNode = (n: unknown): n is PrNode => typeof n === "object" && n !== null && "number" in n

const CI: Record<string, Status> = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "running" }

export function relativeTime(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 365 * 86400) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (365 * 86400))}y`
}

// Like gh pr checkout: a fork's branch named after the default branch would clash with it,
// so it gets the fork owner as a prefix.
export function localBranch(n: Pick<PrNode, "headRefName" | "isCrossRepository" | "headRepositoryOwner" | "baseRepository">): string {
  const clashes = n.isCrossRepository && n.headRefName === n.baseRepository?.defaultBranchRef?.name
  return clashes ? `${n.headRepositoryOwner?.login ?? "ghost"}/${n.headRefName}` : n.headRefName
}

function toPR(n: PrNode, now: Date): PR {
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
    updated: relativeTime(n.updatedAt, now),
    stale: !merged && now.getTime() - Date.parse(n.updatedAt) > STALE_DAYS * 86400_000,
    url: n.url,
    branch: localBranch(n),
  }
}

export function toBuckets(res: SearchResponse, now = new Date(), search?: Search): Bucket[] {
  if (res.errors?.length) throw new Error(res.errors.map(e => e.message).join("; "))
  const viewer = (res.data?.viewer as { login: string } | undefined)?.login.toLowerCase()
  const notMe = !!search?.authors.length && !search.authors.some(a => a.toLowerCase() === viewer)
  return BUCKETS.map((b, i) => {
    if (notMe && isMine(i)) return { name: b.name, total: 0, prs: [] }
    const result = res.data?.[`b${i}`] as SearchResult | null | undefined
    return { name: b.name, total: result?.issueCount ?? 0, prs: (result?.nodes ?? []).filter(isPrNode).map(n => toPR(n, now)) }
  })
}

// One "Search results" bucket with the PRs that exist, narrowed by the other terms.
export function toNumbersBucket(res: NumbersResponse, search: Search, now = new Date()): Bucket {
  // A missing number is a NOT_FOUND error next to the PRs that were found.
  const errors = res.errors?.filter(e => e.type !== "NOT_FOUND") ?? []
  if (errors.length) throw new Error(errors.map(e => e.message).join("; "))
  const prs = search.numbers
    .map(n => res.data?.repository?.[`n${n}`])
    .filter(isPrNode)
    .map(n => toPR(n, now))
    .filter(pr => matches(pr, search))
  return { name: "Search results", prs }
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
async function graphql<T extends { errors?: unknown[] }>(repo: Repo, fields: Record<string, string>): Promise<T> {
  const { code, stdout, stderr } = await gh([
    "api", "graphql", "--hostname", repo.host,
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

export async function fetchBuckets(repo: Repo, search?: Search): Promise<Bucket[]> {
  if (search?.numbers.length) {
    const res = await graphql<NumbersResponse>(repo, { query: buildNumbersQuery(search.numbers), owner: repo.owner, name: repo.name })
    return [toNumbersBucket(res, search)]
  }
  const res = await graphql<SearchResponse>(repo, {
    query: buildQuery(),
    ...Object.fromEntries(BUCKETS.map((_, i) => [`q${i}`, searchQuery(repo, i, search)])),
  })
  return toBuckets(res, new Date(), search)
}
