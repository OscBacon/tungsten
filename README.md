# tungsten

A terminal inbox for a GitHub repo's pull requests.

<img width="2502" height="1350" alt="image" src="https://github.com/user-attachments/assets/00dfb440-843e-4c74-ab2b-80184984e309" />

Lists a repo's PRs by bucket, and allow you to open the PR in your browser

<img width="1222" height="720" alt="tungsten-demo" src="https://github.com/user-attachments/assets/81b35e8e-8eca-4ef0-bd14-66a9ba8c1505" />

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`); 2.98 or newer for `w`

## Install

    git clone git@github.com:OscBacon/tungsten.git
    cd tungsten
    bun install
    bun link    # links `tungsten` into ~/.bun/bin; make sure that's on your PATH

## Usage

    tungsten                 # repo from the current clone's git remotes, like gh
    tungsten -R cli/cli      # or pick one: [HOST/]OWNER/REPO
    tungsten --demo          # sample data, no clone or network
    tungsten --show-git-prompt  # let c and w ask for ssh passphrases or credentials

## Buckets

- Needs your review
- Returned to you
- Approved
- Waiting for reviewers
- Drafts
- Open
- Recently merged

Each shows up to 25 PRs and the total count.

## Keys

| Key      | Action             |
|----------|--------------------|
| ↑↓ / j k | move               |
| t        | collapse bucket    |
| enter    | open PR in browser |
| /        | search             |
| c        | check out PR       |
| w        | open PR worktree   |
| r        | refresh            |
| q        | quit               |

## Search

`/` opens a prompt; `enter` searches GitHub, `esc` clears the search.

    fix token      words in the title
    @login         PRs by that author (several @logins: any of them)
    #123           that PR, looked up directly

## Checking out

Both keys work from a clone of the repo on screen, and hand the PR to `gh pr checkout`,
so forks and remotes behave as they do there.

- `c` checks the PR out in the current clone.
- `w` opens the worktree that already has the PR's branch, or creates one at
  `~/worktrees/<repo>/<branch>` (slashes in the branch become dashes). Inside tmux it opens a
  new window there; otherwise it shows the path.

The app stays on screen while gh works, so git can't prompt: a checkout that needs an ssh
passphrase, a new host key or a password fails with that error instead. Load the key into
ssh-agent or set up a credential helper, or run `tungsten --show-git-prompt` to answer the
prompts (the app is hidden while they run).
