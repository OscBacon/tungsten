import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectRepo, ghHosts, parseRemoteUrl, parseRepo, resolveRepo, type GhHosts, type Remote } from "./repo"

const repo = (owner: string, name: string, host = "github.com") => ({ host, owner, name })
const hosts = (over: Partial<GhHosts> = {}): GhHosts => ({ known: ["github.com"], defaultHost: "github.com", source: "default", ...over })
const ghe: Partial<GhHosts> = { known: ["github.com", "ghe.example.com"], defaultHost: "ghe.example.com" }

const withTmp = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-tui-"))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("parseRepo accepts [HOST/]OWNER/REPO", () => {
  expect(parseRepo("cli/cli")).toEqual(repo("cli", "cli"))
  expect(parseRepo("cli/cli", "ghe.example.com")).toEqual(repo("cli", "cli", "ghe.example.com"))
  expect(parseRepo("GHE.example.com/acme/app")).toEqual(repo("acme", "app", "ghe.example.com"))
  for (const bad of ["cli", "a/b/c/d", "/cli", "cli/", ""]) expect(() => parseRepo(bad)).toThrow()
})

test("parseRemoteUrl follows gh's URL handling", () => {
  expect(parseRemoteUrl("https://github.com/cli/cli.git")).toEqual(repo("cli", "cli"))
  expect(parseRemoteUrl("https://github.com/cli/cli/")).toEqual(repo("cli", "cli"))
  expect(parseRemoteUrl("git+https://www.GitHub.com/cli/cli")).toEqual(repo("cli", "cli"))
  expect(parseRemoteUrl("git@github.com:OscBacon/personal-website.git")).toEqual(repo("OscBacon", "personal-website"))
  expect(parseRemoteUrl("git+ssh://git@github.com/cli/cli.git")).toEqual(repo("cli", "cli"))
  expect(parseRemoteUrl("ssh://git@ssh.github.com:443/cli/cli.git")).toEqual(repo("cli", "cli"))
  expect(parseRemoteUrl("https://user@GHE.example.com/acme/app.git")).toEqual(repo("acme", "app", "ghe.example.com"))

  const alias = (h: string) => (h === "work" ? "github.com" : h)
  expect(parseRemoteUrl("git@work:acme/app.git", alias)).toEqual(repo("acme", "app"))
  expect(parseRemoteUrl("https://work/acme/app", alias)).toEqual(repo("acme", "app", "work")) // aliases are ssh-only

  for (const bad of ["/srv/git/app.git", "../local", "file:///srv/a/b", "C:\\repos\\app", "https://github.com/cli", "https://github.com/cli/cli/pulls"]) {
    expect(parseRemoteUrl(bad)).toBeNull()
  }
})

test("resolveRepo: gh-resolved first, then upstream > github > origin > others", () => {
  const fork = "git@github.com:me/app.git", parent = "https://github.com/acme/app.git"
  const r = (name: string, fetchUrl: string, extra: Partial<Remote> = {}): Remote => ({ name, fetchUrl, ...extra })

  expect(resolveRepo([r("mine", fork), r("origin", fork), r("Upstream", parent)], hosts())).toEqual(repo("acme", "app"))
  expect(resolveRepo([r("zzz", parent), r("origin", fork)], hosts())).toEqual(repo("me", "app"))
  expect(resolveRepo([r("origin", fork, { resolved: "base" }), r("upstream", parent)], hosts())).toEqual(repo("me", "app"))
  expect(resolveRepo([r("origin", fork, { resolved: "other/thing" })], hosts({ ...ghe, source: "hosts" }))).toEqual(repo("other", "thing", "ghe.example.com"))
  expect(resolveRepo([r("origin", "/srv/git/app.git", { pushUrl: parent })], hosts())).toEqual(repo("acme", "app"))
  expect(() => resolveRepo([], hosts())).toThrow(/no git remotes/)
})

test("resolveRepo only considers known hosts, preferring the default host", () => {
  const gitlab = { name: "origin", fetchUrl: "https://gitlab.com/me/app" }
  const dotcom = { name: "mirror", fetchUrl: "https://github.com/acme/app" }
  const enterprise = { name: "zzz", fetchUrl: "https://ghe.example.com/acme/app" }

  expect(resolveRepo([gitlab, dotcom], hosts())).toEqual(repo("acme", "app"))
  expect(() => resolveRepo([gitlab], hosts())).toThrow(/known GitHub host/)
  // A single hosts.yml entry wins when a remote matches it, and falls back otherwise.
  expect(resolveRepo([dotcom, enterprise], hosts({ ...ghe, source: "hosts" }))).toEqual(repo("acme", "app", "ghe.example.com"))
  expect(resolveRepo([dotcom], hosts({ ...ghe, source: "hosts" }))).toEqual(repo("acme", "app"))
  // GH_HOST never falls back.
  expect(() => resolveRepo([dotcom], hosts({ ...ghe, source: "GH_HOST" }))).toThrow(/GH_HOST/)
})

test("ghHosts reads host keys from gh's config dir and GH_HOST", () => {
  withTmp(dir => {
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n    user: me\n    oauth_token: secret\nghe.example.com:\n    user: me\n")
    expect(ghHosts({ GH_CONFIG_DIR: dir })).toEqual({ known: ["github.com", "ghe.example.com"], defaultHost: "github.com", source: "default" })
    expect(ghHosts({ GH_CONFIG_DIR: dir, GH_HOST: "GHE.example.com" })).toMatchObject({ defaultHost: "ghe.example.com", source: "GH_HOST" })

    writeFileSync(join(dir, "hosts.yml"), "ghe.example.com:\n    user: me\n")
    expect(ghHosts({ GH_CONFIG_DIR: dir })).toEqual({ known: ["ghe.example.com", "github.com"], defaultHost: "ghe.example.com", source: "hosts" })
  })
})

test("detectRepo reads a real clone's remotes, insteadOf rewrites and gh-resolved", () => {
  withTmp(dir => {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args])
    git("init", "-q")
    git("config", "url.https://github.com/.insteadOf", "gh:")
    git("remote", "add", "origin", "gh:me/app")
    git("remote", "add", "upstream", "gh:acme/app")
    expect(detectRepo(dir, hosts())).toEqual(repo("acme", "app"))
    git("config", "remote.origin.gh-resolved", "base")
    expect(detectRepo(dir, hosts())).toEqual(repo("me", "app"))
  })
  withTmp(dir => expect(() => detectRepo(dir, hosts())).toThrow(/no git remotes/))
})
