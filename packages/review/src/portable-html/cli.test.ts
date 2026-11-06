import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const exec = promisify(execFile);

const sourceEnv = {
  ...process.env,
  TSX_TSCONFIG_PATH: fileURLToPath(
    new URL("../../tsconfig.json", import.meta.url),
  ),
};

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

it("explains usage and leaves output untouched when no selected service is running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-cli-"));
  const output = join(dir, "saved.html");

  try {
    const { stdout } = await exec(
      process.execPath,
      ["--import", "tsx", cli, "--help"],
      { env: sourceEnv, timeout: 30000 },
    );

    expect(stdout).toContain("whiteboard-html");
    expect(stdout).toContain("--version");
    await writeFile(output, "keep this");

    const result = await exec(
      process.execPath,
      ["--import", "tsx", cli, "example", "--out", output],
      {
        env: { ...sourceEnv, DEV_REVIEW_SERVER_DIR: dir },
        timeout: 30000,
      },
    ).catch((error) => error);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("whiteboard server start");
    expect(await readFile(output, "utf8")).toBe("keep this");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
