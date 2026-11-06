import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { ReviewTelemetry } from "@review/review-telemetry.js";
import { createGlobalReviewServer } from "@review/server/desktop-server.js";

/** A real committed repo and saved review; never opens a personal store. */
export async function savedReviewFixture(directory: string) {
  const repo = join(directory, "repo");
  const state = join(directory, "state");
  await mkdir(repo, { recursive: true });
  await mkdir(state, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();

  git("init", "-q");
  await writeFile(
    join(repo, "order.ts"),
    'export const status = "draft";\nexport function queue() { return status; }\n',
  );
  await writeFile(join(repo, "delete.txt"), "removed\n");
  await writeFile(join(repo, "rename-before.txt"), "same contents\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(repo, "literal[1].txt"), "brackets before\n");
  await writeFile(join(repo, "literal1.txt"), "other before\n");
  git("add", ".");
  git("commit", "-qm", "Base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    join(repo, "order.ts"),
    'export const status = "queued";\nexport function queue() { return status; }\n',
  );
  await rm(join(repo, "delete.txt"));
  await rename(join(repo, "rename-before.txt"), join(repo, "rename-after.txt"));
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 3, 4]));
  await writeFile(join(repo, "empty.txt"), "");
  await writeFile(join(repo, "literal[1].txt"), "brackets after\n");
  await writeFile(join(repo, "literal1.txt"), "other after\n");
  git("add", ".");
  git("commit", "-qm", "Queue");
  const head = git("rev-parse", "HEAD");

  const local = openLocalReviewStore(join(state, "review-api.db"), {
    manageWorkspaces: false,
  });

  const { id: repositoryId } = local.store.registerRepository(repo);

  const { reviewId } = await local.store.execute({
    operation: {
      type: "create",
      title: "Inline queue review",
      target: { kind: "commits", repositoryId, base, head },
    },
  });

  const document = [
    {
      type: "markdown",
      markdown:
        "# Queue an order\n\nRead the [pinned status](review-source:head/order.ts#L1). This saved review works offline.\n\n<script>window.pwned = true</script>\n\n[Details](#details)",
    },
    {
      type: "flow_diagram",
      title: "Request flow",
      description: "Branches and retry cycles remain explicit.",
      nodes: [
        {
          key: "request",
          label: "Request",
          description: "Validate input",
          attachments: [
            { label: "Pinned handler", sources: ["head/order.ts#L1-L2"] },
          ],
        },
        { key: "saved", label: "Saved", kind: "terminal", attachments: [] },
        { key: "retry", label: "Retry", kind: "decision", attachments: [] },
      ],
      edges: [
        { from: "request", to: "saved", label: "valid" },
        { from: "request", to: "retry", label: "busy" },
        { from: "retry", to: "request", label: "try again", style: "dashed" },
      ],
    },
    {
      type: "section",
      title: "Expandable details",
      defaultCollapsed: true,
      children: [
        {
          type: "markdown",
          markdown: "## Details\n\nUse the disclosure to explore this section.",
        },
        {
          type: "code",
          language: "typescript",
          caption: "Authored example (scroll horizontally)",
          text: `const explanation = "${"long code ".repeat(35)}";`,
        },
        {
          type: "callout",
          tone: "info",
          title: "Snapshot",
          children: [
            {
              type: "code_peek",
              source: "head/order.ts#L2",
              caption: "Pinned queue",
            },
          ],
        },
      ],
    },
    {
      type: "call_stack_diff",
      title: "Call paths",
      base: [{ key: "entry", source: "base/order.ts#L1", label: "Draft" }],
      head: [
        { key: "entry", source: "head/order.ts#L1", label: "Queued" },
        {
          key: "queue",
          parentKey: "entry",
          source: "head/order.ts#L2",
          callSite: "head/order.ts#L1",
          contextSources: ["head/order.ts#L1"],
          label: "Queue",
          via: { kind: "call", reason: "Direct call" },
        },
      ],
    },
    {
      type: "sequence",
      title: "Sequence (follow-up)",
      actors: { a: "App" },
      steps: [],
    },
  ];

  for (const content of document)
    await local.store.execute({
      operation: { type: "edit", reviewId, edit: { type: "insert", content } },
    });
  const version = local.store.read(reviewId).version;

  const server = createGlobalReviewServer({
    reviewStore: local.store,
    reviewData: local.data,
    appPid: process.pid,
    packageRoot: directory,
    toolingRoot: directory,
    port: 0,
    discoveryPath: join(state, "review-desktop", "server.json"),
    telemetry: ReviewTelemetry.fromEnv({
      DEV_FAST_REVIEW_TELEMETRY_DISABLED: "1",
    }),
  });

  await server.listen();
  await mkdir(join(state, "review-server"), { recursive: true });
  await writeFile(
    join(state, "review-server", "server.json"),
    JSON.stringify({
      version: 1,
      instanceId: server.discovery.instanceId,
      url: server.discovery.url,
      serverPid: process.pid,
      token: server.discovery.token,
    }),
    { mode: 0o600 },
  );

  return {
    ...local,
    server,
    state,
    reviewId,
    version,
    base,
    head,
    async close() {
      await server.close();
      await local.data.close();
      await local.store.close();
    },
  };
}
