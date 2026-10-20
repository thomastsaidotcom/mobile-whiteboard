// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { App } from "./App";

// jsdom does not implement the tour's scroll-to-step animation.
HTMLElement.prototype.scrollTo = () => {};

it("opens a flow tour inside the styled canvas and changes steps", async () => {
  const snapshot = {
    reviewId: "99999999-9999-4999-8999-999999999999",
    version: 1,
    title: "Flow review",
    createdAt: "2026-10-19T00:00:00.000Z",
    pins: { repositoryId: "repo", base: "base", head: "head" },
    target: {
      kind: "commits",
      repositoryId: "repo",
      base: "base",
      head: "head",
    },
    document: [
      {
        id: "flow-1",
        type: "flow_diagram",
        title: "Save a change",
        nodes: [
          { key: "edit", label: "Edit", description: "Change the live file." },
          { key: "save", label: "Save", description: "Save its history." },
        ],
        edges: [{ from: "edit", to: "save" }],
      },
    ],
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const originalUrl = location.href;
  history.replaceState(null, "", `?review=${snapshot.reviewId}`);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/api/reviews") return Response.json([snapshot]);

    if (url.pathname === `/api/reviews/${snapshot.reviewId}`)
      return Response.json(snapshot);

    if (url.pathname.endsWith("/commits")) return Response.json([]);

    throw new Error(`Unexpected request: ${url.pathname}`);
  });

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector(".flow-diagram")).not.toBeNull(),
      );
    });
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Expand diagram"]')!
        .click(),
    );
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest(".review-app")).toBe(
      container.querySelector(".review-app"),
    );
    expect(dialog.closest(".review-canvas-root")).not.toBeNull();
    expect(dialog.textContent).toContain("Change the live file.");

    const next = dialog.querySelector<HTMLButtonElement>(
      '[data-tour-target="tour-next"]',
    )!;

    await act(async () => next.click());
    expect(
      dialog.querySelector('[aria-label="Tour steps"]')?.textContent,
    ).toContain("2/2");
    await act(async () =>
      dialog
        .querySelector<HTMLButtonElement>('[aria-label="Close guided tour"]')!
        .click(),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    history.replaceState(null, "", originalUrl);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
