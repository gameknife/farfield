# Release Builds

This repository now supports four release build entrypoints from the repo root:

```bash
bun run macos:build:release
bun run linux:build:release
bun run windows:build:release
bun run android:build:release
```

`bun run desktop:build:release` is the generic current-host desktop build.

`bun run release:build:host` is a shorthand for the current desktop host only.

## What each command does

- `macos:build:release`, `linux:build:release`, `windows:build:release`
  - Validate the current OS matches the requested target.
  - Build platform-native sidecars for `farfield-server` and `web-host`.
  - Run `tauri build`.
  - Write desktop bundles to `apps/tauri/src-tauri/target/release/bundle/`.

- macOS specifics
  - The root macOS release script builds the `.app` bundle and then archives it as `.app.tar.gz`.
  - This avoids relying on Finder-driven DMG prettification in headless release environments.

- `android:build:release`
  - Build sidecars and web assets.
  - Run `tauri android build --apk --ci`.
  - Sign the universal APK.
  - Write the signed APK to:
    - `apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-debugsigned.apk`

## Local build matrix

These commands must run on native builders:

- macOS runner or machine:
  - `bun run macos:build:release`
  - `bun run android:build:release`

- Linux runner or machine:
  - `bun run linux:build:release`

- Windows runner or machine:
  - `bun run windows:build:release`

## Android signing

If no signing environment variables are provided, the Android script creates or reuses the default debug keystore and produces a debug-signed APK for device testing.

For store-ready signing, set:

```bash
ANDROID_KEYSTORE_PATH=/absolute/path/to/release.keystore
ANDROID_KEYSTORE_PASSWORD=...
ANDROID_KEY_ALIAS=...
ANDROID_KEY_PASSWORD=...
```

Optional output override:

```bash
ANDROID_SIGNED_APK_PATH=/absolute/path/to/output.apk
```

## Desktop sidecars

Desktop sidecars are now named per platform:

- Windows:
  - `farfield-server.exe`
  - `web-host.exe`

- macOS and Linux:
  - `farfield-server`
  - `web-host`

Tauri resource config is split accordingly:

- `apps/tauri/src-tauri/tauri.windows.conf.json`
- `apps/tauri/src-tauri/tauri.macos.conf.json`
- `apps/tauri/src-tauri/tauri.linux.conf.json`

## GitHub Actions release pipeline

The repository includes `.github/workflows/release-bundles.yml`.

Triggers:

- Manual run from the Actions tab with `workflow_dispatch`
- Automatic release publish on tags matching `v*`

What it does:

1. Builds macOS, Linux, and Windows desktop bundles on native runners.
2. Builds the Android universal APK on macOS.
3. Uploads all artifacts to the workflow run.
4. When triggered by a `v*` tag, publishes all collected artifacts to the GitHub release for that tag.

## GitHub secrets

Android release signing in CI is optional.

If these secrets are present, the workflow uses them:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

If they are absent, the workflow still builds Android using a generated debug keystore for QA artifacts.

Desktop signing is not forced by the scripts. If you want signed macOS or Windows releases, provide the platform signing credentials in the runner environment that `tauri build` expects.

## Recommended release process

1. Run local verification:

```bash
bun run --filter @farfield/web typecheck
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml
```

2. Push the release branch or tag.

3. For a published GitHub release, create and push a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

4. Download the artifacts from:
  - the GitHub release for tagged publishes, or
  - the workflow run artifacts for manual QA builds

## Notes

- Linux desktop bundles should be built on Linux. Do not try to reuse macOS or Windows output there.
- Android is client-only in this app. Desktop host mode does not apply to Android packaging.
- The Android script relies on the Android SDK being installed and available through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the default macOS SDK location at `~/Library/Android/sdk`.
