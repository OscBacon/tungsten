# tungsten

A terminal inbox for a GitHub repo's pull requests.

Lists a repo's PRs by bucket, and allow you to open the PR in your browser

<img width="1222" height="720" alt="tungsten-demo" src="https://github.com/user-attachments/assets/81b35e8e-8eca-4ef0-bd14-66a9ba8c1505" />

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com), logged in (`gh auth login`)

## Install

    git clone git@github.com:OscBacon/tungsten.git
    cd tungsten
    bun install
    bun link    # links `tungsten` into ~/.bun/bin; make sure that's on your PATH

## Usage

    tungsten                 # repo from the current clone's git remotes, like gh
    tungsten -R cli/cli      # or pick one: [HOST/]OWNER/REPO
    tungsten --demo          # sample data, no clone or network

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
| r        | refresh            |
| q        | quit               |
