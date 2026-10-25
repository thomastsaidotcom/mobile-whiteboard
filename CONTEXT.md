# Mobile Whiteboard — current work

Updated October 19, 2026. Continue in `/Users/thomastsai/Code/mobile-whiteboard/mobile-flow`, branch `codex/mobile-flow`, original baseline `38a6dad3049993f987d9b82ca3c5fee424b28f6b`. Shared Git data is `<project>/.bare`; all checkouts are linked worktrees. The skills-defaults PR is separate. Publication and deployment receipts are recorded in `/private/tmp/mobile-whiteboard-private-20261019/`; inspect current Git, GitHub, launchd and Serve state before repeating a mutation.

## Confirmed decisions

The user confirmed six design questions, then explicitly approved **Go gateway + existing TypeScript/React UI**, superseding the earlier Go + HTMX preference for this scope. The Mac stays awake and runs Whiteboard. iPhone Safari gets content reads and existing Markdown edits over private Tailnet HTTPS. No public Funnel, agent/shell/session controls, generic proxy or repository source writes. Whiteboard's token stays server-side. See [the plan](docs/mobile-whiteboard-plan.md), [ADR-0001](docs/adr/0001-mobile-companion-boundary.md) and [run instructions](docs/mobile-whiteboard-run.md).

## Implemented and verified

- Standard-library Go gateway in `apps/mobile-whiteboard`; exact Host/Origin checks, bounded explicit routes, safe assets via `os.OpenRoot`, fresh-version Markdown save check, strict acknowledgement validation and no write retries.
- Mobile entry in `packages/review/app/mobile`, reusing the real `ApiDocument` and diagrams. Only the renderer-facing session type omits the desktop host discriminator; desktop schema/validation remains unchanged.
- Review search, reader, source and Changes base/head views; 3-second visible polling and resume refresh. Drafts survive refresh and view changes; in-memory recovery handles denied storage. Conflict/unknown saves retain text and require reread. Confirmed saves clear drafts so later server changes remain visible. Unreadable stored drafts require confirmed discard.
- Parent checks passed: Go race tests/vet; mobile and canvas TypeScript checks; 22 behavior tests; root lint (0 warnings/errors), root formatting; production Vite build.
- WebKit26.5 and Chromium phone emulation passed all 13 repository block fixtures, diagram/WASM/image rendering, 390px width, light/dark, nested editing, reload/resume, conflict/unknown acknowledgement, later server updates, storage failure/recovery, image lifetime across navigation, host-unavailable recovery, source/Changes and blocked inline-script probe. One transient WebKit ResizeObserver notification was recorded separately; the test checks settling and rejects sustained loops or script errors.
- GET-only live health/list/snapshot and WebKit reader passed against the running Whiteboard0.3.1, with no live writes. Earlier source/tree/diff/history/commits/NDJSON live reads also passed. Checkout desktop source is0.3.2. Discovery is protocol3; upstream list path is `/reviews-api` without trailing slash.

## Known limits and review concerns

Whiteboard offers no atomic expected-version writes: the fresh-version check cannot prevent a race after comparison. Lost or malformed save acknowledgements remain unknown and never automatically retry. Equal acknowledgement versions are valid no-ops; older versions are rejected.

The existing `libavoid-js` Emscripten bindings use two Function constructors. WebKit proved a no-eval CSP blocks them. CSP therefore permits dynamic functions while loading scripts only from self and blocking inline scripts, objects and framing. This is an explicit review concern; do not claim strict no-eval. Shared rich renderers use inline styles/blob workers/local fonts. Changes provides summaries and base/head source; the embedded desktop diff widget is unavailable. Vite warns about large renderer chunks. Real iPhone hardware and Tailnet end-to-end access remain untested.

## Current runtime and next action

The user explicitly authorized a native independent reviewer and requested persistent private access on October19. This is a one-task exception to AO's Web reviewer route. The human preview looks acceptable so far; this does not waive independent review or authorize merging. Native review uses a distinct Sol6.1 Max pass, with original Web failure receipts and limits preserved. The full code review and current acceptance must be obtained before publication or persistent deployment.

The private deployment uses `https://mac-mini-apps.taila90aa9.ts.net:9443/` through Serve to a loopback-only Go service on127.0.0.1:19443. Its exact HTTPS Origin replaces the temporary localhost preview origin, so the old preview URL is no longer valid once deployed. A per-user LaunchAgent runs an installed binary and web assets, independent of this chat and temporary directories. See the run instructions for paths and stop/start commands. Inspect actual runtime state before claiming the endpoint is live.

ChatGPT Web docs, renderer-advice, gateway security and flow advisory scopes each exhausted their two allowed startup failures (`ChatGPT personalization preflight exceeded its readiness deadline`). No verdict exists from those routes; do not reset their budgets or treat them as review approval. The user's native-review authorization resolves the route blocker for this task.
Tailscale user daemon socket: `/Users/thomastsai/.local/state/mac-mini-app-services/tailscaled.sock`; online DNS `mac-mini-apps.taila90aa9.ts.net`. Existing8443 and named git-issue-relay/qbittorrent services must be preserved. Preserve the existing routes when using HTTPS9443. Tailscale1.104.1 source confirms HTTP proxy mode preserves Host and sets X-Forwarded-Host; Unix socket mode changes Host. Keep the gateway loopback-only and use Serve, never Funnel.

## Recovery and evidence

Original integration gate77809 was lost (`Unknown process id`); no acceptance or publication handoff survived. Recovery read the existing ledger, preserved the original staged result in mobile-ready, created clean linked worktree mobile-flow at the original baseline, started new gate42160, then applied the entire surviving21-file patch. The new gate retains the full original scope and unresolved review concerns. It requires renewed checks and independent review; it does not restore approval.

Evidence directory: `/private/tmp/mobile-whiteboard-implementation-20261019/`. `sol-result.json`, `react-integration-scope.json`, `browser-report.json`, `live-browser-report.json`, build/typecheck/unit/lint logs retain actual results. Temporary verified Node24.22.0 is `/private/tmp/node-v24.22.0-darwin-arm64`; pnpm11.1.2 entry is `/private/tmp/mobile-whiteboard-pnpm/package/bin/pnpm.cjs`. Build the existing diffr workspace types before canvas typechecking. Browser binaries are `/private/tmp/mobile-whiteboard-browsers`.

No workers are active. Native Sol Medium `01a15506-5670-7410-a036-b2f15a86197f` completed, was inspected and closed; its scoped contribution was integrated. Parent fixed the root class merge, acknowledgement lower bound, CSP compatibility, confirmed-draft cleanup and blob-resource query lifetime on view changes. The editor has an explicit accessible name independent of its current text. Gemini's initial UI capability attempt and single guided retry were stopped and reconciled; all local closure fields are true, their interrupted sessions must not resume, and no Gemini guided retry budget remains for that scope. Native AO ledger job `mobile-whiteboard-react-ui-sol-medium-1` revision2 records completion; its original contribution remains unreviewed. Use mobile-flow rather than overwriting parent fixes from mobile-ui-sol or the preserved mobile-ready snapshot. Other preserved worktrees retain earlier contributions; do not remove them without authorization.

An earlier approval review rejected sending the saved private review artifact outside the repository to Gemini. Repository fixtures were the safe replacement. Never retry that artifact read indirectly. Token/discovery files are not worker context. The separate Headless authoring definition remains in `GLOSSARY.md`.

## Flow click correction

The user reported flow-node clicks did not work. A real browser click opened the tour outside `.review-canvas-root`; its background was transparent, theme variables empty and text default Times. Moving only the scope marker exposed light-theme inherited-text problems, so the final mobile boundary provides the actual `.review-app` DOM element as the portal target, inside the canvas scope and active theme. App owns this ref; entry no longer passes the outer React root. Shared desktop renderers remain unchanged.

`mobile/flow.test.tsx` mounts the real App with a two-stop review and checks opening, portal ancestry, step advance and closing. It failed on the first-attempt portal boundary and passed after the correction. JSdom cannot lay out the graph; real browser node clicks supplement that test. CUA phone-width checks verified readable dark/light tours, selected nodes, paging and closing against the actual review without writes. Final phone screenshot evidence is in `/private/tmp/mobile-whiteboard-flow-20261019/`. The new bounded Web flow advisory also failed to start twice (Poincare01a15797-8def-71e1-b2a3-c9c6d015c380 and Ptolemy01a15798-b7c5-7230-8e24-754348fbd0d3); both closed, no verdict, no attempts remain. This does not replace the required separate whole-app review.

Native review found that a delayed reread replaced newer draft text or recreated a discarded draft. Reread now applies status to the current store entry after the response, including failure, and leaves discarded entries alone. Four App-level delayed success/failure tests cover continued typing and discard; they failed before the fix. The corrected whole-app version passed independent native review before commit `42eaf16` and private deployment.

## Project target compatibility

The October 25 iPhone failure is caused by a valid `project` target in the live review list. The installed Whiteboard runtime's `stored-document-migration` module defines its strict shape as `{ kind: "project", repositoryId: nonempty string }`. The older checkout only supports worktree/commits. The mobile boundary now accepts the exact additional shape for both lists and snapshots, while rejecting unknown kinds and malformed targets. Project targets are omitted only when supplying the older renderer's commit-target metadata; the phone retains the validated project snapshot. Mixed-list regression and real App flow tests cover this compatibility boundary without changing the desktop schema or adding dependencies.

Private service: LaunchAgent `com.thomastsai.mobile-whiteboard` serves installed assets from `~/.local/share/mobile-whiteboard/web` on loopback19443. Tailnet URL is `https://mac-mini-apps.taila90aa9.ts.net:9443/`. Use the exact Tailnet Host for local probes. Temporary October 19 tool/evidence paths above were cleared after reboot; they are historical references, not current executable paths. The pinned pnpm version remains11.1.2.

External-source publication guard applies to this fork of `devdotfast/whiteboard`: keep new commits local until the user explicitly approves the named repository and publication action. The private service update is already authorized.
