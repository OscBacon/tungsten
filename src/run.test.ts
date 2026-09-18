import { expect, test } from "bun:test"
import { run } from "./run"

// Prints the prompt switches and whether the shell leads its own session (sid == pid).
const probe = ["-c", 'echo "$GIT_TERMINAL_PROMPT/$GH_PROMPT_DISABLED"; [ "$(ps -o sid= -p $$ | tr -d " ")" = "$$" ] && echo own-session || echo shared-session']

test.skipIf(process.platform === "win32")("noPrompts runs without a controlling terminal and with prompts disabled", async () => {
  const { code, stdout } = await run("sh", probe, { noPrompts: true })
  expect(code).toBe(0)
  expect(stdout).toBe("0/1\nown-session\n")
})

test.skipIf(process.platform === "win32")("by default the command keeps the app's session and environment", async () => {
  const saved = [process.env.GIT_TERMINAL_PROMPT, process.env.GH_PROMPT_DISABLED]
  delete process.env.GIT_TERMINAL_PROMPT
  delete process.env.GH_PROMPT_DISABLED
  try {
    expect((await run("sh", probe)).stdout).toBe("/\nshared-session\n")
  } finally {
    if (saved[0] !== undefined) process.env.GIT_TERMINAL_PROMPT = saved[0]
    if (saved[1] !== undefined) process.env.GH_PROMPT_DISABLED = saved[1]
  }
})

test("run reports exit codes and output, and rejects when the command is missing", async () => {
  expect(await run("sh", ["-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" })
  await expect(run("tungsten-no-such-command", [])).rejects.toMatchObject({ code: "ENOENT" })
})
