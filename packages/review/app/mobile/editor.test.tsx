// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { App } from "./App";
import { draftKey } from "./model";

it.each([
  ["success", "typing"],
  ["failure", "typing"],
  ["success", "discard"],
  ["failure", "discard"],
])(
  "keeps intervening %s/%s changes during a reread",
  async (result, action) => {
    const snapshot = {
      reviewId: "99999999-9999-4999-8999-999999999999",
      version: 2,
      title: "Draft review",
      createdAt: "2026-10-19T00:00:00.000Z",
      pins: { repositoryId: "repo", base: "base", head: "head" },
      target: {
        kind: "commits",
        repositoryId: "repo",
        base: "base",
        head: "head",
      },
      document: [{ id: "md-1", type: "markdown", markdown: "Server text" }],
    };

    const key = draftKey(snapshot.reviewId, "md-1");
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        original: "Old server text",
        markdown: "Older draft",
        state: "conflict",
        message: "Reread first",
      }),
    );
    const originalUrl = location.href;
    history.replaceState(null, "", `?review=${snapshot.reviewId}`);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let delay = false;
    let respond: ((response: Response) => void) | undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.pathname === "/api/reviews") return Response.json([snapshot]);

      if (url.pathname === `/api/reviews/${snapshot.reviewId}`) {
        if (delay)
          return new Promise<Response>((resolve) => {
            respond = resolve;
          });

        return Response.json(snapshot);
      }

      if (url.pathname.endsWith("/commits")) return Response.json([]);

      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const button = (label: string) =>
      [...container.querySelectorAll("button")].find(
        (element) => element.textContent === label,
      )!;

    const editor = () => container.querySelector("textarea")!;

    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <App />
          </QueryClientProvider>,
        ),
      );
      await act(async () => {
        await vi.waitFor(() =>
          expect(button("Edit existing Markdown")).toBeDefined(),
        );
      });
      await act(async () => button("Edit existing Markdown").click());
      expect(editor().value).toBe("Older draft");
      delay = true;
      await act(async () => button("Reread before retry").click());
      expect(respond).toBeDefined();
      await act(async () => {
        if (action === "discard") button("Discard draft").click();
        else {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(editor(), "Newer typing");
          editor().dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      expect(editor().value).toBe(
        action === "discard" ? "Server text" : "Newer typing",
      );
      await act(async () => {
        respond!(
          result === "success"
            ? Response.json(snapshot)
            : Response.json({ error: "Host unavailable" }, { status: 503 }),
        );
      });
      expect(editor().value).toBe(
        action === "discard" ? "Server text" : "Newer typing",
      );
      const saved = sessionStorage.getItem(key);

      expect(saved === null ? null : JSON.parse(saved).markdown).toBe(
        action === "discard" ? null : "Newer typing",
      );
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      sessionStorage.clear();
      history.replaceState(null, "", originalUrl);
      vi.unstubAllGlobals();
    }
  },
);
