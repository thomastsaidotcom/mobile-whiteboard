#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import {
  healthyReviewInstance,
  reviewInstanceUnavailable,
  selectReviewInstance,
} from "@review/desktop-discovery.js";
import { ReviewApiClient } from "@review/review-api/client.js";
import {
  readReviewServerDiscovery,
  reviewServerIsHealthy,
  reviewServerStateDir,
  serverNotReady,
} from "@review/server-discovery.js";
import { Command } from "commander";

import { exportReviewHtml } from "./index.js";

async function main() {
  const program = new Command()
    .name("whiteboard-html")
    .description(
      "Export one saved Whiteboard review to self-contained offline HTML (maximum 480000 characters). Uses an already-running selected Desktop, or DEV_REVIEW_SERVER_DIR for a headless server. Never starts services or changes the review.",
    )
    .argument("<session-id>")
    .option("--version <saved-version>", "export a specific saved version")
    .option(
      "--out <file.html>",
      "atomically write HTML to this file (default: stdout)",
    )
    .parse();

  const options = program.opts<{ version?: string; out?: string }>();

  if (options.version !== undefined && !/^\d+$/.test(options.version))
    throw new Error("--version must be a nonnegative saved version number.");

  const version =
    options.version === undefined ? undefined : Number(options.version);

  let connection: { url: string; token: string };

  if (process.env.DEV_REVIEW_SERVER_DIR?.trim()) {
    const stateDir = reviewServerStateDir();
    const server = await readReviewServerDiscovery(stateDir);

    if (!server || !(await reviewServerIsHealthy(server)))
      throw serverNotReady(stateDir);
    connection = server;
  } else {
    const selection = await selectReviewInstance();
    const desktop = healthyReviewInstance(selection);

    if (!desktop) throw reviewInstanceUnavailable(selection);
    connection = desktop;
  }

  const client = new ReviewApiClient({
    serverUrl: connection.url,
    token: connection.token,
  });

  const html = await exportReviewHtml(client, program.args[0]!, version);

  if (!options.out) {
    process.stdout.write(html);

    return;
  }

  const temporary = `${options.out}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, html, { flag: "wx", mode: 0o600 });
    await rename(temporary, options.out);
  } finally {
    await rm(temporary, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
