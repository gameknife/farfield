# AGENTS.md

This repo is Farfield — a local UI for Codex desktop threads.

## Product Contract: Codex Desktop Sync First

Farfield is first and foremost a bidirectional UI for the Codex desktop app. A user action in Farfield must preserve the same thread state that the Codex app sees, and a user action in the Codex app must be reflected back into Farfield.

The Codex desktop IPC owner is the primary route for thread mutations:

- Sending user messages or steering messages.
- Changing Plan/Default mode.
- Changing model or reasoning effort.
- Responding to desktop-owned approvals and user-input requests.

The app-server action route is secondary. Use it only when the Codex desktop IPC route is not connected/initialized or when the request was explicitly created by the app-server responder. Do not silently send a desktop-owned or desktop-ready thread action through the app-server route just because the desktop owner is missing or stale.

Thread action routing must stay centralized. New mutation paths should resolve through the shared thread action route instead of independently checking owner maps or calling app-server mutation methods. If a thread is known to be desktop-owned and its owner cannot be reached, fail clearly and ask the user to reopen/reconnect the thread in Codex rather than creating split state.

Tests must encode these product invariants:

- Desktop-owned sends go through desktop IPC only.
- Stale desktop owners do not become app-server sends.
- If desktop IPC is ready but a thread has no registered owner, thread mutations fail clearly.
- Plan mode, model, and effort changes use the same owner route as sends.
- App-server submissions stay on app-server only when the app-server created the request.

## Absolutely Immutable Extremely Important Rules

ABSOLUTELY NO FALLBACKS. Do not even SAY the word "fallback" to me.
The types must be absolutely precise. You must NEVER write type instrospection code.
Schema must be iron clad in Zod, and everything should fail hard with clear errors if anything mismatches the schema.
No code outside of Zod can EVER do type introspection. Everything MUST operate on strict types ONLY.
You CANNOT use `as any` or `unknown` in this codebase, they are FORBIDDEN.
You must check these rules at the end of every turn. If not satisfied, you are not done: find a better solution that does not
violate the rules. If you think that is impossible, STOP and ask the user.

## Basic Workflow

1. Read the request and inspect the current code before changing anything.
2. Make the smallest clean change that solves the issue.
3. Run focused checks for the files you changed.
4. Keep commits small and scoped to one logical change.
5. Before committing, review the staged diff carefully.

## Commands You Will Use Often

- `bun run dev`
- `bun run typecheck`
- `bun run test`
- `bun run lint`

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

## Commit Rule for Trace-Based Tests

If a unit test uses trace-derived fixtures, the commit must include:

- Sanitized fixture files only.
- A quick note in the commit message that traces were sanitized and manually checked.
