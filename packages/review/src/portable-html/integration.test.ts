import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ReviewApiClient } from "@review/review-api/client.js";
import { expect, it } from "vitest";

import { exportReviewHtml } from "./index.js";
import { savedReviewFixture } from "./test-utils.js";

it("exports an isolated saved Git review through the actual CLI and freezes reads across an edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portable-integration-"));
  const fixture = await savedReviewFixture(dir);

  try {
    const connection = {
      serverUrl: fixture.server.discovery.url,
      token: fixture.server.discovery.token,
    };

    const client = new ReviewApiClient(connection);
    const before = await client.read(`/${fixture.reviewId}?full=true`);
    const output = join(dir, "review.html");

    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./cli.ts", import.meta.url)),
        fixture.reviewId,
        "--version",
        String(fixture.version),
        "--out",
        output,
      ],
      {
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("../../tsconfig.json", import.meta.url),
          ),
          DEV_REVIEW_SERVER_DIR: fixture.state,
        },
        timeout: 30000,
      },
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const html = await readFile(output, "utf8");
    expect(html).toContain("@@ -1,2 +1,2 @@");
    expect(html).toContain("+export const status = &quot;queued&quot;;");
    expect(html).toContain(fixture.head);
    expect(html).toContain("binary (no textual content)");
    expect(html).toContain("Renamed from rename-before.txt");
    expect(html).toContain("deleted file mode");
    expect(html).toContain("empty.txt");

    const literal = await client.read<string>(
      `/${fixture.reviewId}/diff?version=${fixture.version}&file=literal%5B1%5D.txt`,
    );

    expect(literal).toContain("+brackets after");
    expect(literal).not.toContain("other after");

    const summary = await client.read(
      `/${fixture.reviewId}/diff?version=${fixture.version}`,
    );

    expect(Array.isArray(summary)).toBe(true);
    expect(html).not.toContain(connection.token);
    expect(html).not.toContain(fixture.state);
    expect(await client.read(`/${fixture.reviewId}?full=true`)).toEqual(before);
    let edited = false;

    const changing = new ReviewApiClient(connection, async (url, init) => {
      const response = await fetch(url, init);

      if (!edited && url.includes("full=true")) {
        edited = true;
        await fixture.store.execute({
          operation: {
            type: "rename",
            reviewId: fixture.reviewId,
            title: "Later title",
          },
        });
      }

      return response;
    });

    const frozen = await exportReviewHtml(changing, fixture.reviewId);
    expect(frozen).toContain(`version ${fixture.version}`);
    expect(frozen).not.toContain("Later title");
    // Invalid output must never replace a valid artifact.
    await fixture.store.execute({
      operation: {
        type: "edit",
        reviewId: fixture.reviewId,
        edit: {
          type: "insert",
          content: { type: "code", text: "x".repeat(480000) },
        },
      },
    });

    const failure = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./cli.ts", import.meta.url)),
        fixture.reviewId,
        "--out",
        output,
      ],
      {
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("../../tsconfig.json", import.meta.url),
          ),
          DEV_REVIEW_SERVER_DIR: fixture.state,
        },
        timeout: 30000,
      },
    ).catch((error) => error);

    expect(failure.code).toBe(1);
    expect(failure.stderr).toMatch(/maximum 480000/);
    expect(await readFile(output, "utf8")).toBe(html);
    await writeFile(
      join(dir, "verified.txt"),
      "CLI and frozen-version checks passed",
    );
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 90000);
