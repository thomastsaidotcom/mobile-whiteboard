import { afterEach, expect, it, vi } from "vitest";

import { fetchReviewsList, snapshotSchema } from "./api";
import { createMobileSession } from "./session";

afterEach(() => vi.unstubAllGlobals());

const project = {
  reviewId: "project-review",
  title: "Project notes",
  version: 1,
  createdAt: "2026-10-25T12:00:00Z",
  target: { kind: "project", repositoryId: "repository" },
};

it("lists mixed review targets and opens project content without commit pins", async () => {
  const reviews = [
    {
      ...project,
      target: { kind: "commits", repositoryId: "repo", head: "abc" },
    },
    project,
    { ...project, target: { kind: "worktree", repositoryId: "repo" } },
  ];

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(reviews)),
  );
  vi.stubGlobal("location", new URL("https://phone.example"));
  expect(await fetchReviewsList()).toEqual(reviews);

  const snapshot = snapshotSchema.parse({
    ...project,
    document: [{ type: "markdown", id: "notes", markdown: "Project notes" }],
  });

  expect(createMobileSession(snapshot, "light", vi.fn()).review).toMatchObject({
    pins: undefined,
    targetKind: undefined,
  });
});

it.each([
  { kind: "future", repositoryId: "repo" },
  { kind: "project" },
  { kind: "project", repositoryId: "" },
  { kind: "project", repositoryId: "   " },
  { kind: "project", repositoryId: "repo", head: "abc" },
])("rejects invalid project or unknown targets: %j", (target) => {
  expect(
    snapshotSchema.safeParse({ ...project, target, document: [] }).success,
  ).toBe(false);
});
