import { spawn } from "node:child_process"

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// `interactive` marks commands that may prompt (ssh passphrases, git credentials); the caller
// decides whether they get the terminal or must fail instead, see index.tsx.
export type Run = (cmd: string, args: string[], opts?: { interactive?: boolean }) => Promise<RunResult>

export interface RunOptions {
  terminal?: boolean // it has the terminal: stdin, and stderr shown as it runs
  noPrompts?: boolean // the app has the terminal: fail rather than prompt on top of it
}

// Runs a command to completion with its output captured. Spawn failures (say ENOENT) reject.
export const run = (cmd: string, args: string[], { terminal = false, noPrompts = false }: RunOptions = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [terminal ? "inherit" : "ignore", "pipe", "pipe"],
      // A new session has no controlling terminal, so ssh can't open /dev/tty to ask for a
      // passphrase or host key and fails instead. Unlike GIT_SSH_COMMAND, this keeps core.sshCommand.
      detached: noPrompts && process.platform !== "win32",
      env: noPrompts ? { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } : process.env,
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", d => (stdout += d))
    child.stderr.on("data", d => {
      stderr += d
      if (terminal) process.stderr.write(d) // progress and errors stay visible while it has the terminal
    })
    child.on("error", reject)
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }))
  })
