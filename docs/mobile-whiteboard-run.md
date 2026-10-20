# Run Mobile Whiteboard

The companion uses a Go server and compiled React files. Node is needed for building, not for serving. The UI reuses Whiteboard's rich renderers; the Mac still runs Whiteboard itself.

## Build and preview

Use Go 1.27+, the repository's Node 24 requirement and pinned pnpm 11.1.2. From a linked checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter @dev.fast/review-canvas...
pnpm --filter @dev.fast/diffr build
pnpm exec vite build --config packages/review/app/mobile.vite.config.ts
go -C apps/mobile-whiteboard build -o dist/mobile-whiteboard .
apps/mobile-whiteboard/dist/mobile-whiteboard -listen 127.0.0.1:19443 -origin http://127.0.0.1:19443 -assets-dir "$PWD/packages/review/app/dist/mobile"
```

Open `http://127.0.0.1:19443` on the Mac. The gateway discovers Whiteboard at `~/.dev/review-desktop/instances/stable.json`; override `-discovery` when needed. It rereads discovery on requests so a desktop restart can change ports. The tested running desktop/CLI is 0.3.1; this checkout's desktop source is 0.3.2.

## Private phone access

The user authorized native independent review and private deployment. Install only the independently accepted build. Inspect the running service and Serve status to confirm deployment; this document is not a runtime health check.

Run the gateway on loopback with its exact HTTPS Tailnet origin, including the chosen port. Add a Tailscale Serve HTTPS proxy to that loopback HTTP listener. Use HTTP proxy mode: Tailscale's Unix socket mode changes the Host header. Preserve existing Serve routes and inspect access rules first. Do not use Funnel.

This Mac uses daemon socket `/Users/thomastsai/.local/state/mac-mini-app-services/tailscaled.sock` and DNS `mac-mini-apps.taila90aa9.ts.net`. The private URL is `https://mac-mini-apps.taila90aa9.ts.net:9443/`. The Go listener remains `127.0.0.1:19443`, with that exact HTTPS origin. Serve uses `--bg --https=9443 --yes http://127.0.0.1:19443`; preserve other ports and services. Whiteboard and Tailscale must remain running, and the Mac must be awake. On iPhone, connect Tailscale to the same Tailnet, then open the private URL in Safari.

The per-user LaunchAgent is `~/Library/LaunchAgents/com.thomastsai.mobile-whiteboard.plist`. It runs `~/.local/share/mobile-whiteboard/bin/mobile-whiteboard` and serves `~/.local/share/mobile-whiteboard/web`; logs live in `~/.local/state/mobile-whiteboard/`. It starts at login and restarts after an exit. It does not start Whiteboard itself or run before login.

To restart, use `launchctl kickstart -k gui/$(id -u)/com.thomastsai.mobile-whiteboard`. To stop the service, use `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.thomastsai.mobile-whiteboard.plist`. To remove only its Tailnet route, use `tailscale --socket="$HOME/.local/state/mac-mini-app-services/tailscaled.sock" serve --https=9443 off`; never reset the whole Serve configuration.

The deployed gateway rejects the former localhost preview Host. Use the HTTPS Tailnet URL on both Mac and phone. Tailnet members who can reach this node and port can access the companion; Whiteboard's desktop token stays on the Mac.

## Behavior and limits

- The gateway holds the Whiteboard token. Safari receives explicit content operations; source files are read-only. Agent, shell, session and generic command routes are blocked.
- Only existing Markdown blocks can be saved. A fresh-version check detects most conflicts, but Whiteboard has no atomic expected-version operation. Unknown results retain the draft and require reread and explicit retry. Confirmed saves remove the local draft; failed browser storage keeps unsaved text in memory and warns before leaving.
- Updates poll every three seconds while visible and refresh on resume/focus/network recovery. The gateway also supports Whiteboard's NDJSON watch read; the mobile UI uses polling.
- CSP keeps script loading local and blocks inline scripts. The shared Emscripten map bindings require dynamic Function construction, so script CSP includes unsafe-eval. This compatibility choice is part of independent review. No runtime CDN is used.
- Changes shows changed-file summaries and base/head source. Embedded desktop diff widgets are unavailable. The renderer build has large chunks. Browser emulation passed; actual iPhone performance, touch behavior and private-network access still need a device check.

## Verification

Go race tests/vet, mobile and canvas TypeScript checks, 22 behavior tests, root lint/format and production build pass. Parent browser checks used all 13 stored block fixtures in WebKit26.5 and Chromium at 390px, with light/dark modes, diagrams/images, nested edits, refresh/conflict/uncertain save handling, storage failure/recovery, source/Changes and blocked inline scripts. Transient ResizeObserver notifications are recorded separately and must settle; no script exceptions or unexpected API requests passed the checks.

Live health/list/snapshot and a real review rendered in WebKit using GET only. No real review writes or Tailscale configuration changes were performed during verification. Current evidence and pending review/deployment status are in [CONTEXT.md](../CONTEXT.md).
