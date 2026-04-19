# AGENTS.md

This repo is Farfield: a local UI for Codex desktop threads, now with native desktop host/client modes and an Android client build.

## Absolutely Immutable Extremely Important Rules

ABSOLUTELY NO FALLBACKS. Do not even SAY the word "fallback" to me.
The types must be absolutely precise. You must NEVER write type introspection code.
Schema must be iron clad in Zod, and everything should fail hard with clear errors if anything mismatches the schema.
No code outside of Zod can EVER do type introspection. Everything MUST operate on strict types ONLY.
You CANNOT use `as any` or `unknown` in this codebase, they are FORBIDDEN.
You must check these rules at the end of every turn. If not satisfied, you are not done: find a better solution that does not violate the rules. If you think that is impossible, STOP and ask the user.

## Working Style

1. Read the request and inspect the current code before changing anything.
2. Make the smallest clean change that solves the issue.
3. Run focused checks for the files you changed.
4. Keep commits small and scoped to one logical change.
5. Before committing, review the staged diff carefully.
6. Never stage unrelated junk such as `.DS_Store`.

## Project Snapshot

- `apps/web`: main React UI.
- `apps/server`: HTTP API on `4311`, SSE stream, Codex/OpenCode bridge.
- `apps/web-host`: serves the built web app on `4312` for native desktop host mode.
- `apps/tauri/src-tauri`: native shell for desktop and Android packaging.

## Current Product Behavior

### Native Desktop

- App starts in an unconfigured native state.
- Initial screen is the native mode landing page in `apps/web/src/App.tsx`.
- `Use As Host` starts:
  - API server on `0.0.0.0:4311`
  - local web host on `127.0.0.1:4312`
- `Use As Client` does not start local `4311` or `4312`.
- In host mode, the desktop shows a `Host Secret` that clients must use.

### Android

- Android is client-only. Do not expose host mode there.
- Android connects directly to another machine's `4311`.
- Android release builds must allow cleartext HTTP for LAN URLs such as `http://192.168.x.x:4311`.

## Files That Matter For Native Mode Work

- `apps/tauri/src-tauri/src/lib.rs`
  - native connection config
  - host/client activation
  - child-process startup for `4311` and `4312`
  - runtime status exposed to web UI
- `apps/web/src/App.tsx`
  - mode landing page
  - settings UI for host/client
  - gating so the app does not start polling before native mode is activated
- `apps/web/src/lib/native-shell.ts`
  - strict Zod schemas for native bridge payloads
- `apps/web/src/lib/api.ts`
  - request/auth plumbing
  - native bootstrap persistence handling
- `apps/server/src/index.ts`
  - actual HTTP server on `4311`
- `apps/server/src/auth.ts`
  - LAN auth behavior

## LAN And Auth Rules

- `4311` is the API port.
- `4312` is only the local desktop web shell port.
- Host desktop mode must bind `4311` to `0.0.0.0`, not `127.0.0.1`.
- Remote clients must connect to `http://<host-lan-ip>:4311`.
- Non-loopback requests to `4311` require `Authorization: Bearer <sharedSecret>`.
- If `/api/health` returns `401`, the network path is already working and the problem is the secret.
- If there is `connection refused` or timeout, investigate binding, firewall, or LAN isolation.

## Important Recent Lessons

### 1. Do not touch live WebView state during native startup unless necessary

The Android crash we hit came from reading the live window URL too early in Tauri startup. Native bootstrap should derive the app URL from platform rules instead of querying the live window during `setup()`.

### 2. Native mode activation must gate the whole frontend

Before native mode is chosen, the web app must not:
- poll threads
- connect SSE
- load live thread state

If this regresses, startup behavior gets confusing and native landing mode feels broken.

### 3. Android release builds need cleartext HTTP enabled for LAN testing

The Android client was showing `failed to fetch` even though Windows client worked. Root cause: Android release manifest/build config blocked `http://192.168.x.x:4311`.

Current fix is in:
- `apps/tauri/src-tauri/gen/android/app/build.gradle.kts`

If `gen/android` is regenerated, re-check:
- `AndroidManifest.xml`
- `build.gradle.kts`
- `usesCleartextTraffic`

### 4. Stale local `4311` processes can cause secret mismatches

If LAN client gets `401` even with the displayed host secret, verify the actual listener process. A leftover `bun apps/server/src/index.ts` can keep old `FARFIELD_SHARED_SECRET` and confuse testing.

Useful checks:
- `lsof -nP -iTCP:4311 -sTCP:LISTEN`
- `ps eww -p <pid>`

### 5. Client connect buttons must not depend on "draft changed"

Reconnecting with the same URL and secret must work. Button enablement should depend on validity, not whether the input differs from stored state.

## Validation Rules

Run the smallest relevant checks.

### Web UI

- `bun run --filter @farfield/web typecheck`
- `bun run --filter @farfield/web test -- test/app.test.tsx test/api.test.ts test/server-target.test.ts`

### Native Rust

- `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml`

### Android Packaging

- Rebuild when changing native Android packaging, cleartext rules, or Tauri mobile behavior.

## Commands You Will Use Often

- `bun run dev`
- `bun run typecheck`
- `bun run test`
- `bun run lint`
- `bun run --filter @farfield/web test -- test/app.test.tsx test/api.test.ts test/server-target.test.ts`
- `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml`

## Android Build Notes

- Signed test APK path usually ends up at:
  - `apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-debugsigned.apk`
- If you need a new signed local test build:
  1. build the release APK
  2. sign it with the debug keystore for device installation

Do not assume `gen/android` edits are durable across regeneration. If Android is re-initialized, re-check all mobile-specific behavior.

## Trace Privacy Rules (Strict)

Never commit raw traces from `traces/`.

If you need traces for tests:

1. Put raw trace files in `traces/` only.
2. Run `bun run sanitize:traces`.
3. Use only sanitized files from:
   - `packages/codex-protocol/test/fixtures/sanitized/`
4. Manually inspect sanitized files before any commit.
5. Run a sensitive-data scan before staging or committing:
   - `rg -n "/Users/|\\\\Users\\\\|github\\.com|git@|https?://|token|api[_-]?key|PRIVATE KEY|rollout-" packages/codex-protocol/test/fixtures/sanitized`
6. Review what is staged:
   - `git diff --staged -- packages/codex-protocol/test/fixtures/sanitized`

If there is any personal data, secrets, URLs, paths, or conversation text that should not be public, do not commit. Fix sanitization first.

## Commit Rule For Trace-Based Tests

If a unit test uses trace-derived fixtures, the commit must include:

- Sanitized fixture files only.
- A quick note in the commit message that traces were sanitized and manually checked.
