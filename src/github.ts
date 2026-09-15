import { spawn } from "node:child_process"
import type { Bucket, PR, State, Status } from "./data"
import type { Repo } from "./repo"

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

export const searchQuery = (repo: Repo, i: number) =>
  `repo:${repo.owner}/${repo.name} is:pr sort:updated-desc ${BUCKETS[i]!.query}`

const FIELDS = `number title url isDraft state additions deletions updatedAt reviewDecision
  author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

// Searches are passed as variables, so repo names never need escaping in the query text.
export function buildQuery(): string {
  const vars = BUCKETS.map((_, i) => `$q${i}: String!`).join(", ")
  const searches = BUCKETS.map((_, i) => `b${i}: search(query: $q${i}, type: ISSUE, first: ${PAGE_SIZE}) { issueCount nodes { ...pr } }`)
  return `fragment pr on PullRequest { ${FIELDS} }\nquery(${vars}) {\n  ${searches.join("\n  ")}\n}`
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
}

export interface SearchResponse {
  data?: Record<string, { issueCount: number; nodes: unknown[] } | null>
  errors?: { message: string }[]
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
  }
}

export function toBuckets(res: SearchResponse, now = new Date()): Bucket[] {
  if (res.errors?.length) throw new Error(res.errors.map(e => e.message).join("; "))
  return BUCKETS.map((b, i) => {
    const search = res.data?.[`b${i}`]
    return { name: b.name, total: search?.issueCount ?? 0, prs: (search?.nodes ?? []).filter(isPrNode).map(n => toPR(n, now)) }
  })
}

function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", d => (stdout += d))
    child.stderr.on("data", d => (stderr += d))
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error("gh is not installed (https://cli.github.com); run with --demo to try the UI") : e))
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

// gh handles auth and the API host, so no token ever passes through here.
export async function fetchBuckets(repo: Repo): Promise<Bucket[]> {
  const { code, stdout, stderr } = await gh([
    "api", "graphql", "--hostname", repo.host,
    "-f", `query=${buildQuery()}`,
    ...BUCKETS.flatMap((_, i) => ["-f", `q${i}=${searchQuery(repo, i)}`]),
  ])

  let res: SearchResponse | undefined
  try {
    res = JSON.parse(stdout)
  } catch {
    // Not JSON: gh failed before querying (not logged in, network, ...).
  }
  // GraphQL errors exit non-zero but still print the response, which carries the useful message.
  if (res && (code === 0 || res.errors?.length)) return toBuckets(res)
  throw new Error(stderr.trim().split("\n")[0] || `gh exited with code ${code}`)
}
