import { elements } from "@review/review-api/document";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { ApiDocument, createDocumentLoader } from "../src/api-document";
import { RenderedCodeBlock } from "../src/code-block";
import { ReviewDebugSettingsProvider } from "../src/debug-settings";
import { documentStyles } from "../src/document-styles";
import { DrawQueueProvider } from "../src/draw-queue-provider";
import { ReviewSessionProvider } from "../src/host/review-session";
import { appMarker, documentMarker } from "../src/markers.stylex";
import { ReviewProvider } from "../src/review-context";
import {
  ReviewPanelProvider,
  useReviewPanel,
  useReviewPanelStore,
} from "../src/review-panel";
import {
  ReviewContainerProvider,
  ReviewRootsProvider,
} from "../src/review-root-context";
import { fontSize, radius } from "../src/scale.stylex";
import { withClass } from "../src/stylex-props";
import { themeStyles } from "../src/theme-styles";
import { tokens } from "../src/tokens.stylex";
import { Button } from "../src/ui/button";
import {
  type ReviewSnapshot,
  createMobileReviewApiClient,
  fetchReviewDiff,
  fetchReviewFile,
  fetchReviewSnapshot,
  fetchReviewTree,
  fetchReviewsList,
  saveMarkdownBlock,
} from "./api";
import { type Draft, createDraftStore, draftIsStale, draftKey } from "./model";
import {
  type MobileNavigation,
  type SourceLocation,
  createMobileSession,
} from "./session";

const DraftsContext = createContext<ReturnType<typeof createDraftStore> | null>(
  null,
);

function useDrafts() {
  const drafts = useContext(DraftsContext);

  if (!drafts) throw new Error("Draft store is missing.");

  return drafts;
}

const routeSchema = z.object({
  review: z.string().optional(),
  view: z.enum(["document", "source", "changes"]).default("document"),
  file: z.string().optional(),
  side: z.enum(["base", "head"]).default("head"),
  path: z.string().default(""),
  version: z.coerce.number().int().nonnegative().optional(),
  startLine: z.coerce.number().int().positive().optional(),
  endLine: z.coerce.number().int().positive().optional(),
  repositoryId: z.string().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  q: z.string().default(""),
});

type Route = z.infer<typeof routeSchema>;

const readRoute = () =>
  routeSchema.parse(Object.fromEntries(new URLSearchParams(location.search)));

const poll = () => (document.visibilityState === "visible" ? 3000 : false);

const message = (error: Error | null) => error?.message;

export function App() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [route, setRoute] = useState(readRoute);
  const [drafts] = useState(() => createDraftStore(() => sessionStorage));
  useEffect(() => {
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if (drafts.hasUnpersisted()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", beforeLeave);

    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, [drafts]);

  const [theme, setTheme] = useState<"light" | "dark">(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  const queryClient = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);

  const navigate = useCallback((next: Route) => {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(next))
      if (value !== undefined && value !== "") params.set(key, String(value));
    history.pushState(null, "", `?${params}`);
    setRoute(next);
    requestAnimationFrame(() => heading.current?.focus());
  }, []);

  useEffect(() => {
    const pop = () => setRoute(readRoute());

    const resume = () => {
      if (document.visibilityState === "visible")
        void queryClient.invalidateQueries();
    };

    window.addEventListener("popstate", pop);

    for (const event of ["focus", "pageshow", "online"])
      window.addEventListener(event, resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      window.removeEventListener("popstate", pop);

      for (const event of ["focus", "pageshow", "online"])
        window.removeEventListener(event, resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [queryClient]);

  const list = useQuery({
    queryKey: ["reviews"],
    queryFn: fetchReviewsList,
    refetchInterval: poll,
  });

  return (
    <DraftsContext.Provider value={drafts}>
      <div {...withClass("review-canvas-root", styles.root)}>
        <div
          ref={setContainer}
          {...withClass(
            "review-app",
            themeStyles.vars,
            theme === "light" && themeStyles.light,
            appMarker,
            styles.app,
            theme === "dark" && styles.dark,
          )}
        >
          {container && (
            // Portals need both the canvas scope and the active app theme.
            <ReviewContainerProvider container={container}>
              <header {...stylex.props(styles.header)}>
                <Button
                  xstyle={styles.touch}
                  onClick={() =>
                    navigate({
                      view: "document",
                      side: "head",
                      path: "",
                      q: route.q,
                    })
                  }
                >
                  Reviews
                </Button>
                <h1
                  ref={heading}
                  tabIndex={-1}
                  {...stylex.props(styles.heading)}
                >
                  Mobile Whiteboard
                </h1>
                <Button
                  xstyle={styles.touch}
                  aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                >
                  {theme === "dark" ? "Light" : "Dark"}
                </Button>
              </header>
              {!route.review ? (
                <main {...stylex.props(styles.main)}>
                  <label {...stylex.props(styles.stack)}>
                    Find a review
                    <input
                      type="search"
                      value={route.q}
                      {...stylex.props(styles.input)}
                      onChange={(event) => {
                        const next = { ...route, q: event.target.value };
                        const url = new URL(location.href);
                        url.searchParams.set("q", next.q);
                        history.replaceState(null, "", url);
                        setRoute(next);
                      }}
                    />
                  </label>
                  <QueryStatus
                    pending={list.isPending}
                    error={message(list.error)}
                    stale={!!list.data}
                    retry={() => void list.refetch()}
                  />
                  {list.data
                    ?.filter((review) =>
                      review.title
                        .toLowerCase()
                        .includes(route.q.toLowerCase()),
                    )
                    .map((review) => (
                      <Button
                        key={review.reviewId}
                        xstyle={styles.row}
                        onClick={() =>
                          navigate({
                            ...route,
                            review: review.reviewId,
                            view: "document",
                          })
                        }
                      >
                        {review.title || "Untitled review"} · v{review.version}
                      </Button>
                    ))}
                  {list.data &&
                    !list.data.some((review) =>
                      review.title
                        .toLowerCase()
                        .includes(route.q.toLowerCase()),
                    ) && <p>No reviews match.</p>}
                </main>
              ) : (
                <Review
                  key={route.review}
                  id={route.review}
                  route={route}
                  navigate={navigate}
                  theme={theme}
                />
              )}
            </ReviewContainerProvider>
          )}
        </div>
      </div>
    </DraftsContext.Provider>
  );
}

function QueryStatus({
  pending,
  error,
  stale,
  retry,
}: {
  pending: boolean;
  error?: string;
  stale: boolean;
  retry(): void;
}) {
  if (pending) return <p role="status">Loading…</p>;

  if (!error) return null;

  return (
    <div role="alert">
      <p>
        {stale ? "Showing last loaded data. " : ""}
        {error}
      </p>
      <Button xstyle={styles.touch} onClick={retry}>
        Reload
      </Button>
    </div>
  );
}

function Review({
  id,
  route,
  navigate,
  theme,
}: {
  id: string;
  route: Route;
  navigate(route: Route): void;
  theme: "light" | "dark";
}) {
  const snapshot = useQuery({
    queryKey: ["snapshot", id],
    queryFn: () => fetchReviewSnapshot(id),
    refetchInterval: poll,
  });

  const go = useCallback(
    (next: MobileNavigation) => {
      navigate({
        review: id,
        q: route.q,
        view: next.view,
        path: "",
        side: next.source?.side ?? "head",
        file: next.source?.path,
        version: snapshot.data?.version,
        startLine: next.source?.startLine,
        endLine: next.source?.endLine,
        repositoryId: next.source?.pins?.repositoryId,
        head: next.source?.pins?.head,
        base: next.source?.pins?.base,
      });
    },
    [id, navigate, route.q, snapshot.data?.version],
  );

  const session = useMemo(
    () => snapshot.data && createMobileSession(snapshot.data, theme, go),
    [snapshot.data, theme, go],
  );

  const appRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const scrollRegionRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  const roots = useMemo(
    () => ({ appRef, shellRef, scrollRegionRef, articleRef }),
    [],
  );

  return (
    <main ref={scrollRegionRef} {...stylex.props(styles.main)}>
      <QueryStatus
        pending={snapshot.isPending}
        error={message(snapshot.error)}
        stale={!!snapshot.data}
        retry={() => void snapshot.refetch()}
      />
      {snapshot.data && session && (
        <ReviewSessionProvider session={session}>
          <ReviewRootsProvider roots={roots}>
            <ReviewPanelProvider>
              <ReviewDebugSettingsProvider>
                <ReviewProvider softwareMapEnabled>
                  <DrawQueueProvider cursor={undefined}>
                    <div ref={appRef}>
                      <section ref={shellRef} aria-label={snapshot.data.title}>
                        <h2 {...stylex.props(styles.title)}>
                          {snapshot.data.title}
                        </h2>
                        <p {...stylex.props(styles.meta)}>
                          Version {snapshot.data.version} · Updates every 3
                          seconds while visible
                        </p>
                        <nav
                          aria-label="Review views"
                          {...stylex.props(styles.tabs)}
                        >
                          {(["document", "source", "changes"] as const).map(
                            (view) => (
                              <Button
                                key={view}
                                xstyle={styles.touch}
                                aria-current={
                                  route.view === view ? "page" : undefined
                                }
                                variant={
                                  route.view === view ? "primary" : "secondary"
                                }
                                onClick={() => go({ view })}
                              >
                                {view === "document"
                                  ? "Document"
                                  : view === "source"
                                    ? "Source"
                                    : "Changes"}
                              </Button>
                            ),
                          )}
                        </nav>
                        <PeekNavigation go={go} />
                        {route.view === "document" ? (
                          <article
                            ref={articleRef}
                            {...stylex.props(
                              documentMarker,
                              documentStyles.article,
                              styles.article,
                            )}
                          >
                            <Document snapshot={snapshot.data} />
                          </article>
                        ) : route.view === "source" ? (
                          <Source
                            snapshot={snapshot.data}
                            route={route}
                            navigate={navigate}
                          />
                        ) : (
                          <Changes
                            snapshot={snapshot.data}
                            route={route}
                            navigate={navigate}
                          />
                        )}
                      </section>
                    </div>
                  </DrawQueueProvider>
                </ReviewProvider>
              </ReviewDebugSettingsProvider>
            </ReviewPanelProvider>
          </ReviewRootsProvider>
        </ReviewSessionProvider>
      )}
    </main>
  );
}

function PeekNavigation({ go }: { go(route: MobileNavigation): void }) {
  const active = useReviewPanel((state) => state.active);
  const panel = useReviewPanelStore();
  useEffect(() => {
    if (active?.content.kind !== "source") return;
    const source = active.content.source;
    panel.getState().close();
    go({
      view: "source",
      source: {
        path: source.file,
        side: source.start.side,
        pins: source.pins,
        startLine: source.start.line,
        endLine:
          source.end.side === source.start.side
            ? source.end.line
            : source.start.line,
      },
    });
  }, [active, go, panel]);

  return null;
}

function Document({ snapshot }: { snapshot: ReviewSnapshot }) {
  const [loader] = useState(() =>
    createDocumentLoader(createMobileReviewApiClient()),
  );

  useEffect(() => () => loader.dispose(), [loader]);

  const data = useQuery({
    queryKey: ["document", snapshot.reviewId, snapshot],
    queryFn: () =>
      loader.load({
        ...snapshot,
        // The older renderer only uses commit targets; project content needs none.
        target:
          snapshot.target?.kind === "project" ? undefined : snapshot.target,
      }),
    // The loader revokes its blob URLs when this reader unmounts.
    gcTime: 0,
  });

  const [editing, setEditing] = useState(false);
  const drafts = useDrafts();

  const markdownBlocks = elements(snapshot.document).filter(
    (node) => node.type === "markdown",
  );

  const removed =
    drafts
      ?.blockIds(snapshot.reviewId)
      .filter((id) => !markdownBlocks.some((block) => block.id === id)) ?? [];

  return (
    <>
      <Button
        xstyle={styles.touch}
        aria-expanded={editing}
        onClick={() => setEditing(!editing)}
      >
        {editing ? "Close Markdown editor" : "Edit existing Markdown"}
      </Button>
      {editing && (
        <section aria-label="Markdown editor" {...stylex.props(styles.stack)}>
          <p>
            Edit existing Markdown blocks. Other block types stay read-only.
            Drafts stay in this browser tab.
          </p>
          {markdownBlocks.length === 0 && (
            <p>This document has no Markdown blocks.</p>
          )}
          {removed.map((id) => (
            <MarkdownEditor
              key={id}
              snapshot={snapshot}
              blockId={id}
              markdown={undefined}
            />
          ))}
          {markdownBlocks.map(
            (block) =>
              block.id && (
                <MarkdownEditor
                  key={block.id}
                  snapshot={snapshot}
                  blockId={block.id}
                  markdown={block.markdown}
                />
              ),
          )}
        </section>
      )}
      <QueryStatus
        pending={data.isPending}
        error={message(data.error)}
        stale={!!data.data}
        retry={() => void data.refetch()}
      />
      {data.data && <ApiDocument data={data.data} />}
    </>
  );
}

function MarkdownEditor({
  snapshot,
  blockId,
  markdown,
}: {
  snapshot: ReviewSnapshot;
  blockId: string;
  markdown: string | undefined;
}) {
  const key = draftKey(snapshot.reviewId, blockId);
  const drafts = useDrafts();
  const entry = useSyncExternalStore(drafts.subscribe, () => drafts.read(key));
  const draft = entry.draft;
  const storageError = entry.error;

  const [readyVersion, setReadyVersion] = useState<number>();
  const [checking, setChecking] = useState(false);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (payload: { version: number; markdown: string }) =>
      saveMarkdownBlock(snapshot.reviewId, blockId, payload),
    retry: false,
  });

  const stale = draft && draftIsStale(draft, snapshot.version, markdown);

  const needsRead =
    draft &&
    (stale ||
      draft.state === "conflict" ||
      draft.state === "unknown" ||
      draft.state === "saving");

  const saving = draft?.state === "saving";

  function keep(next: Draft) {
    drafts.write(key, next);
  }

  async function reread() {
    setChecking(true);
    setReadyVersion(undefined);

    try {
      const latest = await queryClient.fetchQuery({
        queryKey: ["snapshot", snapshot.reviewId],
        queryFn: () => fetchReviewSnapshot(snapshot.reviewId),
        staleTime: 0,
      });

      const current = drafts.read(key).draft;

      if (!current) return;

      const block = elements(latest.document).find(
        (node) => node.id === blockId && node.type === "markdown",
      );

      if (!block) {
        keep({
          ...current,
          state: "conflict",
          message:
            "This block was removed. Copy the draft; it cannot be saved here.",
        });

        return;
      }

      setReadyVersion(latest.version);

      keep({
        ...current,
        state: "conflict",
        message: `Reread version ${latest.version}. Compare the current text below. Saving explicitly replaces that block with your draft.`,
      });
    } catch (error) {
      const current = drafts.read(key).draft;

      if (current)
        keep({
          ...current,
          state: "unknown",
          message: error instanceof Error ? error.message : "Reread failed.",
        });
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    if (!draft || saving) return;
    const version = needsRead ? readyVersion : draft.version;

    if (version === undefined || version !== snapshot.version) return;
    const sent = { ...draft, state: "saving" as const, message: "Saving…" };
    keep(sent);
    setReadyVersion(undefined);

    const result = await saveMutation.mutateAsync({
      version,
      markdown: sent.markdown,
    });

    if (result.state === "saved") {
      drafts.acknowledge(key, result.version);
      void queryClient.invalidateQueries({
        queryKey: ["snapshot", snapshot.reviewId],
      });
    } else
      keep({
        ...sent,
        state: result.state,
        message: `${result.message} Your draft is kept.`,
      });
  }

  if (markdown === undefined && !draft && !storageError) return null;

  return (
    <section
      {...stylex.props(styles.card)}
      aria-label={`Markdown block ${blockId}`}
    >
      {markdown === undefined && (
        <p role="status">
          This block was removed. Your draft is kept here for copying.
        </p>
      )}
      <label {...stylex.props(styles.stack)}>
        Markdown · {blockId}
        <textarea
          aria-label={`Markdown · ${blockId}`}
          {...stylex.props(styles.editor)}
          rows={8}
          value={draft?.markdown ?? markdown ?? ""}
          disabled={saving || entry.unreadable}
          readOnly={markdown === undefined}
          onChange={(event) => {
            setReadyVersion(undefined);
            keep({
              version: draft?.version ?? snapshot.version,
              original: draft?.original ?? markdown ?? "",
              markdown: event.target.value,
              state: draft?.state === "unknown" ? "unknown" : "editing",
              message: "Unsaved draft",
            });
          }}
        />
      </label>
      {storageError && <p role="alert">{storageError}</p>}
      <p role="status">
        {draft?.message ?? entry.message ?? "No local changes."}{" "}
        {stale ? "The review changed after this draft began." : ""}
      </p>
      {needsRead && (
        <>
          <Button
            xstyle={styles.touch}
            disabled={checking || saving}
            onClick={() => void reread()}
          >
            {checking ? "Rereading…" : "Reread before retry"}
          </Button>
          <details>
            <summary>
              Current server Markdown · version {snapshot.version}
            </summary>
            <pre {...stylex.props(styles.wrap)}>{markdown}</pre>
          </details>
        </>
      )}
      <Button
        xstyle={styles.touch}
        variant="primary"
        disabled={
          !draft ||
          saving ||
          checking ||
          entry.unreadable ||
          markdown === undefined ||
          (needsRead
            ? readyVersion !== snapshot.version
            : draft.markdown === draft.original)
        }
        onClick={() => void save()}
      >
        {saving
          ? "Saving…"
          : needsRead
            ? `Save draft against version ${readyVersion ?? "…"}`
            : "Save Markdown"}
      </Button>
      {(draft || storageError) && (
        <Button
          xstyle={styles.touch}
          disabled={saving}
          onClick={() => {
            if (
              !confirm(
                "Discard this local draft and use the current server text?",
              )
            )
              return;

            if (drafts.discard(key)) setReadyVersion(undefined);
          }}
        >
          {entry.unreadable
            ? "Discard unreadable stored draft"
            : "Discard draft"}
        </Button>
      )}
    </section>
  );
}

function sourceLocation(route: Route): SourceLocation | undefined {
  if (!route.file) return undefined;

  if (
    (route.repositoryId || route.head || route.base) &&
    (!route.repositoryId || !route.head)
  )
    throw new Error("Source pins require repositoryId and head.");

  return {
    path: route.file,
    side: route.side,
    startLine: route.startLine,
    endLine: route.endLine,
    pins:
      route.repositoryId && route.head
        ? {
            repositoryId: route.repositoryId,
            head: route.head,
            base: route.base,
          }
        : undefined,
  };
}

function Source({
  snapshot,
  route,
  navigate,
}: {
  snapshot: ReviewSnapshot;
  route: Route;
  navigate(route: Route): void;
}) {
  const version = route.version ?? snapshot.version;

  const pinnedSnapshot = useQuery({
    queryKey: ["snapshotVersion", snapshot.reviewId, version],
    queryFn: () => fetchReviewSnapshot(snapshot.reviewId, version),
    enabled: version !== snapshot.version,
  });

  const pinned = version === snapshot.version ? snapshot : pinnedSnapshot.data;

  const tree = useQuery({
    queryKey: ["tree", snapshot.reviewId, version, route.path, route.side],
    queryFn: () =>
      fetchReviewTree(snapshot.reviewId, route.path, route.side, version),
    enabled: !snapshot.sourceUnavailable && !!snapshot.pins,
  });

  const selected = sourceLocation(route);

  return (
    <section aria-label="Source" {...stylex.props(styles.stack)}>
      <p {...stylex.props(styles.wrap)}>
        Pinned version {version} · base{" "}
        {selected?.pins?.base ?? pinned?.pins?.base ?? "not supplied"} · head{" "}
        {selected?.pins?.head ?? pinned?.pins?.head ?? "not supplied"}
      </p>
      {version !== snapshot.version && (
        <>
          <p role="status">
            A newer review version is available. This source stays pinned.
          </p>
          <Button
            xstyle={styles.touch}
            onClick={() => navigate({ ...route, version: snapshot.version })}
          >
            Use latest version {snapshot.version}
          </Button>
          <QueryStatus
            pending={pinnedSnapshot.isPending}
            error={message(pinnedSnapshot.error)}
            stale={!!pinnedSnapshot.data}
            retry={() => void pinnedSnapshot.refetch()}
          />
        </>
      )}
      {snapshot.sourceUnavailable && (
        <p role="status">Repository source is unavailable.</p>
      )}
      {!snapshot.pins && (
        <p>Use a document source link with explicit repository pins.</p>
      )}
      <div {...stylex.props(styles.tabs)}>
        {(["base", "head"] as const).map((side) => (
          <Button
            key={side}
            xstyle={styles.touch}
            aria-pressed={route.side === side}
            onClick={() => navigate({ ...route, version, side })}
          >
            {side}
          </Button>
        ))}
      </div>
      {route.path && (
        <Button
          xstyle={styles.touch}
          onClick={() =>
            navigate({
              ...route,
              version,
              file: undefined,
              path: route.path.split("/").slice(0, -1).join("/"),
            })
          }
        >
          Parent folder
        </Button>
      )}
      <p {...stylex.props(styles.wrap)}>{route.path || "/"}</p>
      {snapshot.pins && (
        <QueryStatus
          pending={tree.isPending}
          error={message(tree.error)}
          stale={!!tree.data}
          retry={() => void tree.refetch()}
        />
      )}
      <div {...stylex.props(styles.stack)}>
        {tree.data?.map((entry) => (
          <Button
            key={entry.path}
            xstyle={styles.row}
            onClick={() =>
              navigate({
                review: snapshot.reviewId,
                q: route.q,
                view: "source",
                version,
                side: route.side,
                path: entry.kind === "directory" ? entry.path : route.path,
                file: entry.kind === "file" ? entry.path : undefined,
              })
            }
          >
            {entry.kind === "directory" ? "Folder: " : ""}
            {entry.path}
          </Button>
        ))}
      </div>
      {selected && (
        <SourceFile
          id={snapshot.reviewId}
          version={version}
          source={selected}
        />
      )}
    </section>
  );
}

function SourceFile({
  id,
  version,
  source,
}: {
  id: string;
  version: number;
  source: SourceLocation;
}) {
  const file = useQuery({
    queryKey: ["file", id, version, source.path, source.side, source.pins],
    queryFn: () =>
      fetchReviewFile(id, {
        file: source.path,
        side: source.side,
        version,
        ...source.pins,
      }),
  });

  const focus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (file.data) {
      focus.current?.focus();
      focus.current?.scrollIntoView({ block: "start" });
    }
  }, [file.data, source.startLine]);
  const lines = file.data?.text.split("\n");

  return (
    <div ref={focus} tabIndex={-1} {...stylex.props(styles.file)}>
      <h3 {...stylex.props(styles.wrap)}>
        {source.path} · {source.side}
      </h3>
      <QueryStatus
        pending={file.isPending}
        error={message(file.error)}
        stale={!!file.data}
        retry={() => void file.refetch()}
      />
      {file.data && (
        <>
          <p {...stylex.props(styles.wrap)}>Commit {file.data.commit}</p>
          {source.startLine && lines && (
            <section aria-label="Referenced lines">
              <p>
                Referenced lines {source.startLine}–
                {source.endLine ?? source.startLine}
              </p>
              <RenderedCodeBlock
                caption={`Reference · line ${source.startLine}`}
                code={lines
                  .slice(
                    source.startLine - 1,
                    source.endLine ?? source.startLine,
                  )
                  .join("\n")}
              />
            </section>
          )}
          <RenderedCodeBlock
            code={file.data.text}
            caption={source.path}
            language={source.path.split(".").pop()}
            lineNumbers
          />
        </>
      )}
    </div>
  );
}

function Changes({
  snapshot,
  route,
  navigate,
}: {
  snapshot: ReviewSnapshot;
  route: Route;
  navigate(route: Route): void;
}) {
  const version = route.version ?? snapshot.version;

  const diff = useQuery({
    queryKey: ["diff", snapshot.reviewId, version],
    queryFn: () => fetchReviewDiff(snapshot.reviewId, version),
    enabled: !snapshot.sourceUnavailable && !!snapshot.pins,
  });

  const selected = diff.data?.find((file) => file.path === route.file);

  if (snapshot.sourceUnavailable || !snapshot.pins)
    return <p role="status">Changes are unavailable for this review.</p>;

  return (
    <section aria-label="Changes" {...stylex.props(styles.stack)}>
      <p>Comparison at version {version}</p>
      {version !== snapshot.version && (
        <>
          <p role="status">
            A newer review version is available. This comparison stays pinned.
          </p>
          <Button
            xstyle={styles.touch}
            onClick={() => navigate({ ...route, version: snapshot.version })}
          >
            Use latest version {snapshot.version}
          </Button>
        </>
      )}
      <QueryStatus
        pending={diff.isPending}
        error={message(diff.error)}
        stale={!!diff.data}
        retry={() => void diff.refetch()}
      />
      {diff.data?.length === 0 && <p>No changed files.</p>}
      {diff.data?.map((file) => (
        <Button
          key={file.path}
          xstyle={styles.row}
          onClick={() =>
            navigate({
              ...route,
              version,
              file: file.path,
              side: file.status === "deleted" ? "base" : "head",
            })
          }
        >
          {file.path} · {file.status} · +{file.additions} −{file.deletions}
          {file.binary ? " · binary" : ""}
          {file.previousPath ? ` · from ${file.previousPath}` : ""}
        </Button>
      ))}
      {selected && (
        <>
          <div {...stylex.props(styles.tabs)}>
            <Button
              xstyle={styles.touch}
              disabled={selected.status === "added"}
              aria-pressed={route.side === "base"}
              onClick={() => navigate({ ...route, version, side: "base" })}
            >
              Base
            </Button>
            <Button
              xstyle={styles.touch}
              disabled={selected.status === "deleted"}
              aria-pressed={route.side === "head"}
              onClick={() => navigate({ ...route, version, side: "head" })}
            >
              Head
            </Button>
          </div>
          {selected.binary ? (
            <p>Binary file. Text preview is unavailable.</p>
          ) : (route.side === "base" && selected.status === "added") ||
            (route.side === "head" && selected.status === "deleted") ? (
            <p>This file does not exist on this side.</p>
          ) : (
            <SourceFile
              id={snapshot.reviewId}
              version={version}
              source={{
                path:
                  route.side === "base"
                    ? (selected.previousPath ?? selected.path)
                    : selected.path,
                side: route.side,
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

const styles = stylex.create({
  dark: { colorScheme: "dark" },
  root: { height: "100dvh", width: "100%", overflow: "hidden" },
  app: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    color: tokens.ink,
    backgroundColor: tokens.bg,
    fontFamily: tokens.fontSans,
    fontSize: fontSize.reading,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px",
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: tokens.rule,
    flexShrink: 0,
  },
  heading: { fontSize: fontSize.reading, flexGrow: 1, margin: 0, minWidth: 0 },
  title: { fontSize: fontSize.heading, overflowWrap: "anywhere" },
  main: {
    overflow: "auto",
    minHeight: 0,
    padding: "12px",
    flexGrow: 1,
    containerType: "inline-size",
    containerName: "review-content",
  },
  stack: { display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 },
  tabs: { display: "flex", flexWrap: "wrap", gap: "8px", marginBlock: "12px" },
  touch: {
    minHeight: "44px",
    height: "auto",
    whiteSpace: "normal",
    padding: "8px 12px",
    fontSize: fontSize.reading,
  },
  row: {
    display: "flex",
    justifyContent: "flex-start",
    textAlign: "start",
    width: "100%",
    minHeight: "44px",
    height: "auto",
    padding: "12px",
    marginBlock: "4px",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    fontSize: fontSize.reading,
  },
  input: {
    minHeight: "44px",
    width: "100%",
    boxSizing: "border-box",
    color: tokens.ink,
    backgroundColor: tokens.controlBg,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.control,
    padding: "8px",
    fontFamily: "inherit",
    fontSize: fontSize.reading,
    outlineColor: tokens.accent,
  },
  editor: {
    width: "100%",
    minHeight: "160px",
    boxSizing: "border-box",
    color: tokens.ink,
    backgroundColor: tokens.controlBg,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.control,
    padding: "8px",
    fontFamily: tokens.fontMono,
    fontSize: fontSize.reading,
    outlineColor: tokens.accent,
  },
  meta: { color: tokens.inkMuted, fontSize: fontSize.body },
  card: {
    minWidth: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.rule,
    borderRadius: radius.surface,
    padding: "12px",
  },
  article: {
    minWidth: 0,
    width: "100%",
    overflowX: "auto",
    boxSizing: "border-box",
  },
  wrap: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  file: {
    minWidth: 0,
    maxWidth: "100%",
    overflowX: "auto",
    outlineColor: tokens.accent,
  },
});
