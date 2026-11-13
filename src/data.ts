import { repoKey, type Repo } from "./repo"

export type Status = "pass" | "fail" | "pending" | "running" | "merged"
export type State = "review" | "approved" | "draft" | "merged" | "author"

export interface PR {
  number: number
  title: string
  author: string
  state: State
  ci: Status
  review: Status
  additions: number
  deletions: number
  updatedAt: string // ISO time; shown relative to now when drawn, so it keeps aging
  open: boolean // neither merged nor closed
  draft: boolean
  reviewers: string[] // lowercased logins asked to review directly, not through a team
  url: string
  repo: Repo // the repo it was opened against
  branch: string // local branch name for checkouts; see localBranch() in github.ts
}

export interface Bucket {
  name: string
  total?: number // server-side count when only a page of PRs is loaded
  prs: PR[]
  // Whether a PR belongs here, so one that changes can move in or out without a refetch;
  // see place() in inbox.ts. Without it, changed PRs are only updated where they are.
  accepts?: (pr: PR) => boolean
}

// The repo too: with several repos, two PRs can share a number.
export const prKey = (pr: PR) => `${repoKey(pr.repo)}#${pr.number}`

const STALE_DAYS = 14

export const isStale = (pr: PR, now: Date) => pr.state !== "merged" && now.getTime() - Date.parse(pr.updatedAt) > STALE_DAYS * 86400_000

export function relativeTime(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 365 * 86400) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (365 * 86400))}y`
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 }

// Sample data for --demo and tests; the UI only depends on these shapes.
// With several repos, the PRs are dealt out across them in turn.
export function demoBuckets(...repos: Repo[]): Bucket[] {
  let next = 0
  const now = Date.now()
  // Swap for your Graphite PR link format if you'd rather open PRs there.
  const url = (r: Repo, n: number) => `https://${r.host}/${r.owner}/${r.name}/pull/${n}`
  const pr = ({ updated, ...p }: Omit<PR, "url" | "repo" | "branch" | "updatedAt" | "open" | "draft" | "reviewers"> & { updated: string }): PR => {
    const repo = repos[next++ % repos.length]!
    const updatedAt = new Date(now - parseInt(updated) * UNIT_MS[updated.slice(-1)]!).toISOString()
    return { ...p, updatedAt, open: p.state !== "merged", draft: p.state === "draft", reviewers: [], url: url(repo, p.number), repo, branch: `${p.author}/pr-${p.number}` }
  }

  return [
    { name: "Needs your review", prs: [
      pr({ number: 21325, title: "fix: only find upstack PRs for MQ after self", author: "aryamannaik", state: "review", ci: "fail", review: "pass", additions: 84, deletions: 3, updated: "7m" }),
      pr({ number: 21324, title: "refactor: add logic to fetch MQ entries after self into helper", author: "aryamannaik", state: "review", ci: "pending", review: "pass", additions: 104, deletions: 20, updated: "7m" }),
      pr({ number: 21100, title: "feat: set the location of the upstack blame modal when clicking on the upstack", author: "ZiyaoWei", state: "review", ci: "fail", review: "fail", additions: 186, deletions: 2, updated: "7m" }),
    ] },
    { name: "Returned to you", prs: [] },
    { name: "Approved", prs: [
      pr({ number: 20967, title: "[Snyk] Security upgrade @withgraphite/retype from 0.0.0-use.local to 0.3.15", author: "gregoryfoster", state: "approved", ci: "fail", review: "pass", additions: 1, deletions: 1, updated: "18h" }),
      pr({ number: 20673, title: "fix(auth): fix edge case in repo membership", author: "gregoryfoster", state: "approved", ci: "fail", review: "pass", additions: 31, deletions: 4, updated: "18h" }),
    ] },
    { name: "Waiting for reviewers", prs: [] },
    { name: "Drafts", prs: [
      pr({ number: 19965, title: "experiment(pr_perf): explore using cached PRs on pr page", author: "gregoryfoster", state: "draft", ci: "running", review: "fail", additions: 54, deletions: 23, updated: "21d" }),
    ] },
    { name: "Open", total: 42, prs: [
      pr({ number: 21330, title: "chore(deps): bump @opentelemetry/api from 1.9.0 to 1.9.1", author: "dependabot", state: "review", ci: "pass", review: "pending", additions: 3, deletions: 3, updated: "2m" }),
      pr({ number: 21318, title: "feat(mq): show estimated merge time in queue sidebar", author: "ZiyaoWei", state: "approved", ci: "running", review: "pass", additions: 212, deletions: 41, updated: "1h" }),
      pr({ number: 21102, title: "docs: document stack submit flags", author: "aryamannaik", state: "author", ci: "pass", review: "fail", additions: 58, deletions: 12, updated: "16d" }),
    ] },
    { name: "Recently merged", total: 318, prs: [
      pr({ number: 21305, title: "fix: throw when we hit a merge conflict when rebasing stack for draft PRs", author: "aryamannaik", state: "merged", ci: "pass", review: "merged", additions: 10, deletions: 0, updated: "3m" }),
    ] },
  ]
}
