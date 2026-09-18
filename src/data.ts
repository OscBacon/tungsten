import type { Repo } from "./repo"

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
  updated: string
  stale?: boolean
  url: string
  branch: string // local branch name for checkouts; see localBranch() in github.ts
}

export interface Bucket {
  name: string
  total?: number // server-side count when only a page of PRs is loaded
  prs: PR[]
}

// Sample data for --demo and tests; the UI only depends on these shapes.
export function demoBuckets(repo: Repo): Bucket[] {
  // Swap for your Graphite PR link format if you'd rather open PRs there.
  const url = (n: number) => `https://${repo.host}/${repo.owner}/${repo.name}/pull/${n}`
  const pr = (p: Omit<PR, "url" | "branch">): PR => ({ ...p, url: url(p.number), branch: `${p.author}/pr-${p.number}` })

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
      pr({ number: 19965, title: "experiment(pr_perf): explore using cached PRs on pr page", author: "gregoryfoster", state: "draft", ci: "running", review: "fail", additions: 54, deletions: 23, updated: "21d", stale: true }),
    ] },
    { name: "Open", total: 42, prs: [
      pr({ number: 21330, title: "chore(deps): bump @opentelemetry/api from 1.9.0 to 1.9.1", author: "dependabot", state: "review", ci: "pass", review: "pending", additions: 3, deletions: 3, updated: "2m" }),
      pr({ number: 21318, title: "feat(mq): show estimated merge time in queue sidebar", author: "ZiyaoWei", state: "approved", ci: "running", review: "pass", additions: 212, deletions: 41, updated: "1h" }),
      pr({ number: 21102, title: "docs: document stack submit flags", author: "aryamannaik", state: "author", ci: "pass", review: "fail", additions: 58, deletions: 12, updated: "16d", stale: true }),
    ] },
    { name: "Recently merged", total: 318, prs: [
      pr({ number: 21305, title: "fix: throw when we hit a merge conflict when rebasing stack for draft PRs", author: "aryamannaik", state: "merged", ci: "pass", review: "merged", additions: 10, deletions: 0, updated: "3m" }),
    ] },
  ]
}
