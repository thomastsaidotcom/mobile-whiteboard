import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { exportReviewHtml } from "./index.js";

it("exports a saved prose review as inert, offline HTML", async () => {
  const html = await exportReviewHtml(
    {
      async read() {
        return {
          reviewId: "example",
          version: 1,
          title: "<Example>",
          document: [
            {
              type: "markdown",
              markdown: "# Hello\n\n<script>alert(1)</script>",
            },
          ],
        };
      },
    },
    "example",
  );

  expect(html).toContain("<!doctype html>");
  expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("version 1");
});

const pins = {
  repositoryId: "repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
};

const saved = {
  reviewId: "example",
  version: 3,
  title: "Pinned review",
  pins,
  target: { kind: "commits", ...pins },
  document: [
    {
      id: "peek",
      type: "code_peek",
      source: "head/order.ts#L2",
      caption: "Exact source",
    },
  ],
};

const patch =
  "diff --git a/order.ts b/order.ts\n--- a/order.ts\n+++ b/order.ts\n@@ -1 +1 @@\n-old\n+new\n";

// oxlint-disable-next-line anti-slop/no-object-parameters -- Deliberately malformed API payloads exercise the public export boundary.
function service(snapshot: object = saved) {
  return {
    async read(route: string) {
      const url = new URL(route, "http://test");

      if (!url.pathname.endsWith("/file") && !url.pathname.endsWith("/diff"))
        return snapshot;

      if (
        url.searchParams.get("version") !== "3" ||
        url.searchParams.get("head") !== pins.head ||
        url.searchParams.get("repositoryId") !== "repo"
      )
        throw new Error("Unfrozen read");

      if (url.pathname.endsWith("/file"))
        return {
          repositoryId: "repo",
          file: "order.ts",
          side: "head",
          commit: pins.head,
          text: "unrelated first line\nPINNED second line\n",
        };

      return url.searchParams.has("file")
        ? patch
        : [
            {
              path: "order.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
            },
          ];
    },
  };
}

it("keeps one saved version and exact pinned excerpts with real source patches", async () => {
  const html = await exportReviewHtml(service(), "example");
  expect(html).toContain("PINNED second line");
  expect(html).not.toContain("unrelated first line");
  expect(html).toContain(pins.head);
  expect(html).toContain("@@ -1 +1 @@");
  expect(html).toContain("Unified source patches");
});

it("keeps all thirteen fixture kinds in order, with honest partial notices and disclosures", async () => {
  const kinds = [
    "markdown",
    "code",
    "divider",
    "code_peek",
    "flow_diagram",
    "call_stack_diff",
    "section",
    "callout",
    "trace_quote",
    "sequence",
    "database_lens",
    "image",
    "software_map",
  ];

  const document = kinds.flatMap((kind) =>
    JSON.parse(
      readFileSync(
        new URL(`../fixtures/blocks/${kind}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );

  const api = service({ ...saved, document });

  // Fixture source needs line 1 on both sides.
  const html = await exportReviewHtml(
    {
      async read(route: string) {
        if (new URL(route, "http://test").pathname.endsWith("/file")) {
          const side = new URL(route, "http://test").searchParams.get("side");

          return {
            repositoryId: "repo",
            file: "order.ts",
            side,
            commit: side === "base" ? pins.base : pins.head,
            text: "export const status = 'queued';\n",
          };
        }

        return api.read(route);
      },
    },
    "example",
  );

  let position = -1;

  for (const kind of kinds) {
    const next = html.indexOf(`data-block-type="${kind}"`, position + 1);
    expect(next).toBeGreaterThan(position);
    position = next;
  }

  expect(html).toContain("6 partial/unavailable blocks");
  expect(html).toContain("<details open>");
  expect(html).toContain("Unverified authored quote");
  expect(html).toContain("Cross-side alignment unavailable");
  expect(html).toContain('href="#source-');
});

it("visibly identifies partially rendered blocks, including nested Markdown", async () => {
  const html = await exportReviewHtml(
    service({
      ...saved,
      document: [
        ...saved.document,
        {
          type: "section",
          title: "Details",
          children: [{ id: "math<block>", type: "markdown", markdown: "$x$" }],
        },
      ],
    }),
    "example",
  );

  const visible = html.replace(/<[^>]*>/g, "");
  expect(visible).toContain("Partial/unavailable: code_peek · block peek");
  expect(visible).toContain(
    "Partial/unavailable: markdown · block math&lt;block&gt;",
  );
  expect(html).not.toContain("block math<block>");
});

it("rejects moving target identities before reading pinned content", async () => {
  await expect(
    exportReviewHtml(
      service({ ...saved, target: { ...saved.target, head: "main" } }),
      "example",
    ),
  ).rejects.toThrow(/immutable|target/i);
});

it.each([
  ["unknown kind", { ...saved, document: [{ type: "mystery" }] }],
  [
    "worktree",
    { ...saved, target: { kind: "worktree", repositoryId: "repo" } },
  ],
  [
    "worktree revision",
    { ...saved, pins: { ...pins, worktreeRevision: "live" } },
  ],
  [
    "moving explicit pins",
    {
      ...saved,
      document: [{ ...saved.document[0], pins: { ...pins, head: "HEAD" } }],
    },
  ],
  [
    "unsafe source path",
    {
      ...saved,
      document: [{ ...saved.document[0], source: "head/../secret#L1" }],
    },
  ],
  [
    "unsafe Markdown URL",
    {
      ...saved,
      document: [
        { type: "markdown", markdown: "[attack](javascript:alert%281%29)" },
      ],
    },
  ],
])("rejects %s", async (_, snapshot) => {
  await expect(exportReviewHtml(service(snapshot), "example")).rejects.toThrow(
    /.+/,
  );
});

it.each([
  { file: "wrong.ts" },
  { side: "base" },
  { repositoryId: "wrong" },
  { commit: "c".repeat(40) },
  { text: "one line" },
  { text: "\n \n" },
  { text: null },
])("rejects mismatched source response %j", async (mismatch) => {
  const api = service();
  await expect(
    exportReviewHtml(
      {
        async read(route: string) {
          const value = await api.read(route);

          return route.includes("/file?")
            ? { ...(value as object), ...mismatch }
            : value;
        },
      },
      "example",
    ),
  ).rejects.toThrow(/.+/);
});

it("fails a missing required source and oversized complete HTML", async () => {
  const api = service();
  await expect(
    exportReviewHtml(
      {
        async read(route: string) {
          if (route.includes("/file?"))
            throw new Error("Pinned file unavailable");

          return api.read(route);
        },
      },
      "example",
    ),
  ).rejects.toThrow(/order.ts.*Pinned file unavailable/);
  await expect(
    exportReviewHtml(
      service({
        ...saved,
        document: [{ type: "code", text: "x".repeat(480000) }],
      }),
      "example",
    ),
  ).rejects.toThrow(/maximum 480000.*Split/);
});

it("uses element override pins in another registered repository", async () => {
  const override = { repositoryId: "other", head: "c".repeat(40) };

  const api = service({
    ...saved,
    document: [
      {
        type: "flow_diagram",
        title: "Override",
        pins,
        nodes: [
          {
            key: "one",
            label: "Node",
            attachments: [
              {
                label: "Evidence",
                pins: override,
                sources: ["head/other.ts#L1"],
              },
            ],
          },
        ],
        edges: [],
      },
    ],
  });

  const html = await exportReviewHtml(
    {
      async read(route: string) {
        const url = new URL(route, "http://test");

        if (url.searchParams.get("repositoryId") === "other") {
          expect(url.searchParams.get("head")).toBe(override.head);
          expect(url.searchParams.get("base")).toBe(override.head);
          expect(url.searchParams.get("version")).toBe("3");

          if (url.pathname.endsWith("/file"))
            return {
              repositoryId: "other",
              file: "other.ts",
              side: "head",
              commit: override.head,
              text: "OTHER REPOSITORY",
            };

          return [];
        }

        return api.read(route);
      },
    },
    "example",
  );

  expect(html).toContain("OTHER REPOSITORY");
});
