import { afterEach, describe, expect, it, vi } from "vitest";

import { mapSafeReviewRequest, saveMarkdownBlock, snapshotSchema } from "./api";
import {
  type Draft,
  createDraftStore,
  draftIsStale,
  restoreDraft,
} from "./model";
import { navigationForRequest } from "./session";

afterEach(() => vi.unstubAllGlobals());

const draft: Draft = {
  version: 7,
  original: "server",
  markdown: "my draft",
  state: "saving",
  message: "Saving",
};

describe("phone drafts and gateway boundary", () => {
  it("keeps memory drafts after storage failure and allows an acknowledged save", () => {
    const stored = new Map<string, string>();

    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      key: () => null,
      length: 0,
      clear: () => stored.clear(),
    };

    const drafts = createDraftStore(() => storage);
    drafts.write("draft", { ...draft, state: "editing" });
    expect(drafts.read("draft").draft?.markdown).toBe("my draft");
    expect(drafts.read("draft").unreadable).toBe(false);
    expect(drafts.hasUnpersisted()).toBe(true);
    drafts.acknowledge("draft", 8);
    expect(drafts.read("draft").draft).toBeUndefined();
    expect(drafts.read("draft").message).toBe("Saved version 8.");
    expect(drafts.hasUnpersisted()).toBe(false);
    stored.set("broken", "invalid JSON");
    expect(drafts.read("broken").unreadable).toBe(true);
    drafts.write("broken", draft);
    expect(stored.get("broken")).toBe("invalid JSON");
    expect(drafts.discard("broken")).toBe(true);
    drafts.write("broken", draft);
    expect(drafts.read("broken").draft?.markdown).toBe("my draft");
  });
  it("allows memory editing when access to browser storage itself is denied", () => {
    const drafts = createDraftStore(() => {
      throw new Error("denied");
    });

    expect(drafts.read("draft").unreadable).toBe(false);
    drafts.write("draft", { ...draft, state: "editing" });
    expect(drafts.read("draft").draft?.markdown).toBe("my draft");
    expect(drafts.hasUnpersisted()).toBe(true);
    drafts.acknowledge("draft", 8);
    expect(drafts.read("draft").draft).toBeUndefined();
    expect(drafts.read("draft").error).toContain("Saved on the Mac");
    expect(drafts.hasUnpersisted()).toBe(false);
  });
  it("ignores an old acknowledged draft so later server edits stay visible", () => {
    expect(
      restoreDraft(
        {
          getItem: () =>
            JSON.stringify({
              ...draft,
              state: "editing",
              original: draft.markdown,
            }),
        },
        "draft",
      ),
    ).toBeUndefined();
  });
  it("restores interrupted saves as unknown without losing text or original version", () => {
    const restored = restoreDraft(
      { getItem: () => JSON.stringify(draft) },
      "draft",
    );

    expect(restored).toMatchObject({
      state: "unknown",
      markdown: "my draft",
      version: 7,
    });
    expect(draftIsStale(draft, 8, "new server text")).toBe(true);
    expect(draftIsStale(draft, 7, undefined)).toBe(true);
    expect(draftIsStale(draft, 7, "server")).toBe(false);
  });
  it("maps renderer reads, strips credentials, and rejects writes and control routes", () => {
    const mapped = mapSafeReviewRequest(
      "https://phone.test/reviews-api/r/maps/m?version=7&full=true",
      { headers: { "x-review-token": "", Authorization: "secret" } },
      "https://phone.test",
    );

    expect(mapped.url).toBe(
      "https://phone.test/api/reviews/r/maps/m?version=7",
    );
    expect(new Headers(mapped.init.headers).has("x-review-token")).toBe(false);
    expect(new Headers(mapped.init.headers).has("authorization")).toBe(false);

    for (const url of [
      "https://other.test/api/reviews",
      "/api/reviews/r/command",
      "/api/reviews/r/progress",
      "/api/reviews/r/file?token=secret",
    ]) {
      expect(() => mapSafeReviewRequest(url, {}, "https://phone.test")).toThrow(
        /same-origin|unavailable|Tokens/,
      );
    }

    expect(() =>
      mapSafeReviewRequest(
        "/api/reviews/r",
        { method: "POST" },
        "https://phone.test",
      ),
    ).toThrow(/same-origin|unavailable|Tokens/);
  });
  it("uses real name/args verbs and retains reference pins and line range", () => {
    const pins = { repositoryId: "repo", head: "sha", base: "older" };
    expect(
      navigationForRequest({
        name: "reveal",
        args: {
          path: "src/a.ts",
          side: "base",
          pins,
          startLine: 4,
          endLine: 9,
        },
      }),
    ).toEqual({
      view: "source",
      source: {
        path: "src/a.ts",
        side: "base",
        pins,
        startLine: 4,
        endLine: 9,
      },
    });
    expect(
      navigationForRequest({ name: "captureScreenshot", args: {} }),
    ).toBeUndefined();
  });
  it("keeps worktree generations and rejects incomplete snapshots", () => {
    const snapshot = {
      reviewId: "r",
      title: "Review",
      version: 2,
      createdAt: "2026-10-19T12:00:00.000Z",
      document: [],
      pins: {
        repositoryId: "repo",
        head: "b",
        base: "a",
        worktreeRevision: "generation",
      },
    };

    expect(snapshotSchema.parse(snapshot).pins?.worktreeRevision).toBe(
      "generation",
    );
    expect(
      snapshotSchema.safeParse({ ...snapshot, createdAt: undefined }).success,
    ).toBe(false);
    expect(
      snapshotSchema.safeParse({ ...snapshot, target: { kind: "invented" } })
        .success,
    ).toBe(false);
  });
  it.each([
    [200, { reviewId: "r", version: 7 }, "saved"],
    [200, { reviewId: "r", version: 8, targetId: "b" }, "saved"],
    [200, { reviewId: "r", version: 6 }, "unknown"],
    [200, { reviewId: "wrong", version: 8 }, "unknown"],
    [200, { reviewId: "r", version: 8, targetId: "wrong" }, "unknown"],
    [200, {}, "unknown"],
    [409, { error: "stale" }, "conflict"],
    [502, { error: "uncertain" }, "unknown"],
    [504, { error: "timeout" }, "unknown"],
  ])(
    "validates save acknowledgement %s %j as %s, sends once",
    async (status, body, state) => {
      vi.stubGlobal("location", { origin: "https://phone.test" });

      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

      vi.stubGlobal("fetch", fetch);

      const result = await saveMarkdownBlock("r", "b", {
        version: 7,
        markdown: draft.markdown,
      });

      expect(result.state).toBe(state);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        version: 7,
        markdown: "my draft",
      });
    },
  );
  it("surfaces plain-text failures and marks transport failure unknown", async () => {
    vi.stubGlobal("location", { origin: "https://phone.test" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Invalid block", { status: 400 })),
    );
    expect(
      await saveMarkdownBlock("r", "b", { version: 7, markdown: "draft" }),
    ).toEqual({ state: "failed", message: "Invalid block" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(
      await saveMarkdownBlock("r", "b", { version: 7, markdown: "draft" }),
    ).toMatchObject({ state: "unknown" });
  });
});
