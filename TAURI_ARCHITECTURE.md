## Tauri App Architecture

This document describes the native app packaging model added for Farfield, with emphasis on the Windows host flow that is currently verified and runnable.

## Goals

- Wrap Farfield into a native app for desktop.
- Keep the host machine on a strict two-port model:
  - `4311`: API server
  - `4312`: local UI service
- Make the desktop app window always load `http://127.0.0.1:4312`.
- Allow remote desktop and future mobile clients to connect to the host machine through `4311` with a shared secret.
- Keep all connection state schema-driven and strict.

## Current Status

Implemented and verified on Windows:

- Tauri desktop shell builds and runs.
- Host mode starts local `4311` and `4312`.
- The packaged release executable can launch both services.
- The packaged installers build successfully.
- The web app can store and use remote connection settings with `serverBaseUrl` and `sharedSecret`.
- The server requires bearer auth for non-loopback requests.

Not yet completed:

- Dedicated Android and iOS packaging flows.
- First-run onboarding for host vs remote client.
- A polished remote-client-only desktop mode in the native shell.
- Discovery/pairing UX beyond manual address and secret entry.

## Component Layout

### `apps/server`

The API server remains the source of truth for Farfield operations.

- Port: `4311`
- Host-mode bind: `0.0.0.0`
- Local-only UI access still uses loopback.
- Non-loopback requests must include `Authorization: Bearer <sharedSecret>`.

Relevant files:

- [apps/server/src/index.ts](/D:/github/farfield/apps/server/src/index.ts)
- [apps/server/src/auth.ts](/D:/github/farfield/apps/server/src/auth.ts)

### `apps/web`

The React app now supports two connection sources:

- Browser/native-saved connection config
- Native bootstrap from the Tauri shell

The effective connection model is:

- `baseUrl`
- `sharedSecret`

REST requests and event streaming both use the same connection settings.

Relevant files:

- [apps/web/src/lib/api.ts](/D:/github/farfield/apps/web/src/lib/api.ts)
- [apps/web/src/lib/server-target.ts](/D:/github/farfield/apps/web/src/lib/server-target.ts)
- [apps/web/src/lib/native-shell.ts](/D:/github/farfield/apps/web/src/lib/native-shell.ts)
- [apps/web/src/App.tsx](/D:/github/farfield/apps/web/src/App.tsx)

### `apps/web-host`

This is the production UI service for `4312`.

Responsibilities:

- Serve the built `apps/web/dist`
- Proxy `/api/*` and `/events` to `4311`

This replaces using `vite preview` in the native app packaging model.

Relevant file:

- [apps/web-host/src/index.ts](/D:/github/farfield/apps/web-host/src/index.ts)

### `apps/tauri`

This is the native shell.

Desktop host responsibilities:

- Persist native connection config
- Start and stop the local sidecars
- Report runtime status to the web app
- Redirect the main window to `http://127.0.0.1:4312` in host mode

Relevant files:

- [apps/tauri/src-tauri/src/lib.rs](/D:/github/farfield/apps/tauri/src-tauri/src/lib.rs)
- [apps/tauri/src-tauri/tauri.conf.json](/D:/github/farfield/apps/tauri/src-tauri/tauri.conf.json)
- [apps/tauri/package.json](/D:/github/farfield/apps/tauri/package.json)

## Port Model

### Host machine

- `4311` listens on `0.0.0.0`
- `4312` listens on `127.0.0.1`

Why this split exists:

- `4311` is the remotely reachable control plane.
- `4312` is only the local presentation layer for the native window.
- Remote clients should talk to `4311` directly, not to `4312`.

### Remote client

Remote clients are expected to connect directly to `4311` and provide:

- `serverBaseUrl`
- `sharedSecret`

This applies to:

- browser-based remote access
- future desktop remote-client mode
- future Android/iOS clients

## Native Configuration Model

The native shell stores a strict tagged configuration:

- `Host`
  - `version`
  - `serverBaseUrl`
  - `sharedSecret`
- `RemoteClient`
  - `version`
  - `serverBaseUrl`
  - `sharedSecret`

The desktop runtime also reports:

- `activeMode`
- `hostSupported`
- `resolvedBindAddress`
- `server4311Status`
- `web4312Status`

The web app consumes this through Tauri commands and merges it into its own strict connection flow.

## Startup Flow

### Desktop host mode

1. Tauri loads native connection config.
2. If the mode is `Host`, Tauri starts:
   - `farfield-server.exe`
   - `web-host.exe`
3. `farfield-server.exe` binds `0.0.0.0:4311`.
4. `web-host.exe` binds `127.0.0.1:4312`.
5. The Tauri window redirects to `http://127.0.0.1:4312`.
6. The web app reads native bootstrap data and uses the local connection.

### Desktop remote-client mode

Target behavior:

1. Tauri loads a `RemoteClient` config.
2. No local `4311` or `4312` services are started.
3. The web app loads from packaged assets and connects directly to the configured remote `4311`.

This path is not fully finished yet in the native shell. The React app side is prepared for remote connection settings, but the native runtime and packaging still primarily target Windows host mode.

## Authentication Model

The current auth rule is simple and strict:

- Loopback requests are allowed without a bearer token.
- Non-loopback requests must present the configured shared secret.
- The same rule applies to JSON endpoints and SSE.

This gives:

- frictionless local host UI
- explicit authorization for LAN access

## Build And Run Commands

Top-level commands:

```bash
bun run desktop:dev
bun run desktop:typecheck
bun run desktop:build
```

Produced Windows artifacts:

- [apps/tauri/src-tauri/target/release/farfield_tauri.exe](/D:/github/farfield/apps/tauri/src-tauri/target/release/farfield_tauri.exe)
- [apps/tauri/src-tauri/target/release/bundle/nsis/Farfield_0.1.0_x64-setup.exe](/D:/github/farfield/apps/tauri/src-tauri/target/release/bundle/nsis/Farfield_0.1.0_x64-setup.exe)
- [apps/tauri/src-tauri/target/release/bundle/msi/Farfield_0.1.0_x64_en-US.msi](/D:/github/farfield/apps/tauri/src-tauri/target/release/bundle/msi/Farfield_0.1.0_x64_en-US.msi)

## Important Implementation Details

### Sidecar location in release builds

The release executable must resolve:

- `binaries/farfield-server.exe`
- `binaries/web-host.exe`

relative to the installed executable layout.

This path handling is implemented in:

- [apps/tauri/src-tauri/src/lib.rs](/D:/github/farfield/apps/tauri/src-tauri/src/lib.rs)

### Web assets in release builds

The packaged `apps/web/dist` assets are consumed by `web-host`, not directly by the Tauri window in host mode.

That distinction matters because:

- host mode expects the window to talk to local `4312`
- remote-client mode will eventually need direct packaged-asset loading

### `4312` is not a remote API surface

Do not build future remote clients around `4312`.

`4312` exists only so the host machine can preserve the current browser-style UI runtime behind a local native shell.

## Recommended Next Steps

### Remote desktop client mode

- Add a native code path that loads packaged web assets directly when the mode is `RemoteClient`.
- Do not start `4311` or `4312` in that mode.
- Reuse the existing web connection settings UI and native bootstrap plumbing.

### Android and iOS

- Initialize Tauri mobile scaffolding.
- Use packaged web assets inside the mobile webview.
- Reuse the `RemoteClient` config model.
- Keep mobile client-only; do not try to host local sidecars on mobile.

### UX

- Add a first-run mode picker.
- Show host LAN address and shared secret in a clearer pairing screen.
- Add explicit connection-state errors for bad URL, bad token, and host offline conditions.

## Validation History

The Windows host path has already been validated with:

- `bun run desktop:typecheck`
- `bun run --filter @farfield/server test`
- `bun run desktop:build`
- direct launch of the release `farfield_tauri.exe`
- local checks that `4311` and `4312` both respond with HTTP `200`

Use this document as the handoff point for continuing remote-client and mobile work in later sessions.
