import type {
  ReviewSourcePins,
  ReviewVerbRequest,
  ReviewVerbResponse,
} from "@dev.fast/review-protocol";

import wasmUrl from "../../../../node_modules/@mr_mint/elkjs-libavoid/dist/libavoid.wasm?url";
import type {
  ReviewRendererBridge,
  ReviewSession,
} from "../src/host/review-session";
import {
  type ReviewSnapshot,
  type Side,
  mobileRequest,
  reviewUrl,
} from "./api";

export type SourceLocation = {
  path: string;
  side: Side;
  pins?: ReviewSourcePins;
  startLine?: number;
  endLine?: number;
};

export type MobileNavigation = {
  view: "document" | "source" | "changes";
  source?: SourceLocation;
};

const disposable = { dispose() {} };

const unavailable = () => {
  throw new Error("This desktop action is unavailable on mobile.");
};

export function navigationForRequest(
  request: ReviewVerbRequest,
): MobileNavigation | undefined {
  switch (request.name) {
    case "reveal":
      return {
        view: "source",
        source: {
          path: request.args.path,
          side: request.args.side ?? "head",
          pins: request.args.pins,
          startLine: request.args.startLine,
          endLine: request.args.endLine,
        },
      };
    case "openDiff":
      return {
        view: "changes",
        source: { path: request.args.path, side: "head" },
      };
    case "openSourceTree":
      return { view: "source" };
    case "showReviewView":
      if (request.args.view === "review") return { view: "document" };

      if (request.args.view === "diff") return { view: "changes" };

      return undefined;
    default:
      return undefined;
  }
}

export function createMobileSession(
  snapshot: ReviewSnapshot,
  theme: "light" | "dark",
  navigate: (route: MobileNavigation) => void,
): ReviewSession {
  const post = async (
    request: ReviewVerbRequest,
  ): Promise<ReviewVerbResponse> => {
    const route = navigationForRequest(request);

    if (!route)
      return { ok: false, error: "This action is unavailable on mobile." };
    navigate(route);

    return { ok: true };
  };

  const config = {
    serverUrl: location.origin,
    reviewId: snapshot.reviewId,
    token: "",
    wasmUrl,
    appVersion: "mobile",
    theme,
  };

  const bridge: ReviewRendererBridge = {
    config,
    request: mobileRequest,
    post,
    subscribe(listener) {
      listener({ event: "themeChanged", theme });

      return disposable;
    },
    currentTheme: () => theme,
    onDidChangeTheme(listener) {
      listener(theme);

      return disposable;
    },
    currentDiffLayout: () => "unified",
    setDiffLayout: async () => unavailable(),
    onDidChangeDiffLayout: () => disposable,
    ready() {},
    inlineEditors: {
      create(spec) {
        const button = document.createElement("button");
        const heights = new Set<(height: number) => void>();
        button.type = "button";
        button.textContent = `Open ${spec.title || spec.path} · ${spec.side}`;
        button.style.minHeight = "44px";
        button.onclick = () => {
          navigate({
            view: "source",
            source: {
              path: spec.path,
              side: spec.side,
              pins: spec.pins,
              startLine: spec.ranges[0]?.startLine,
              endLine: spec.ranges[0]?.endLine,
            },
          });
        };

        button.onfocus = () => spec.onDidFocus?.();
        spec.container.append(button);

        return {
          get height() {
            return button.hidden ? 0 : 44;
          },
          dispose() {
            heights.clear();
            button.onclick = null;
            button.onfocus = null;
            button.remove();
          },
          setActive(active) {
            button.setAttribute("aria-pressed", String(active));
          },
          setCollapsed(collapsed) {
            button.hidden = collapsed;

            for (const listener of heights) listener(collapsed ? 0 : 44);
          },
          onDidChangeHeight(listener) {
            heights.add(listener);
            listener(button.hidden ? 0 : 44);

            return {
              dispose() {
                heights.delete(listener);
              },
            };
          },
          onDidError: () => disposable,
          setFindQuery: async () => unavailable(),
          revealFindMatch: unavailable,
          clearActiveFindMatch() {},
          clearFind() {},
        };
      },
      find: async () => unavailable(),
    },
    diffView: {
      create(spec) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Open Changes · embedded desktop diff unavailable";
        button.style.minHeight = "44px";
        button.onclick = () => navigate({ view: "changes" });
        spec.container.append(button);

        return {
          dispose() {
            button.remove();
          },
          focus() {
            button.focus();
          },
          onDidError(listener) {
            listener(
              "Embedded diff unavailable on mobile. Open Changes for base/head files.",
            );

            return disposable;
          },
        };
      },
      files: async () => unavailable(),
    },
  };

  const apiUrl = (endpoint: `/${string}`) =>
    reviewUrl(snapshot.reviewId, endpoint, { version: snapshot.version });

  return {
    config,
    bridge,
    review: {
      pins: snapshot.pins,
      targetKind: snapshot.target?.kind,
      historicalRevision: null,
      updatedAtMs: Date.parse(snapshot.createdAt),
      traces: new Map(),
      stack: async () => unavailable(),
      createBranchReview: async () => unavailable(),
      dismiss: async () => unavailable(),
    },
    appSessionId: `mobile:${snapshot.reviewId}`,
    surface: {
      openFileDiff(file) {
        void post({
          name: "openDiff",
          args: { path: file.path, previousPath: file.previousPath },
        });
      },
      revealAnchor(path, range, side, pins) {
        void post({
          name: "reveal",
          args: {
            path,
            startLine: range.fromLine,
            endLine: range.toLine,
            side,
            pins,
          },
        });
      },
      async post(request) {
        const result = await post(request);

        if (!result.ok) throw new Error(result.error);
      },
      subscribe(listener) {
        listener({ event: "themeChanged", theme });

        return () => {};
      },
    },
    apiUrl,
    fetch: (endpoint, init) => mobileRequest(apiUrl(endpoint), init),
    fetchUrl: mobileRequest,
    beaconUrl: unavailable,
    wasmUrl: () => wasmUrl,
    storageKey: (namespace, ...parts) =>
      ["mobile", snapshot.reviewId, namespace, ...parts].join(":"),
    theme: () => theme,
    signalReady() {},
    reportDiagnostic() {},
  };
}
