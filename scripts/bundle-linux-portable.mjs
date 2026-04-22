#!/usr/bin/env node
/**
 * Bundle a Tauri Linux binary into a self-contained tree so it runs on
 * distros that don't ship webkit2gtk-4.1 (e.g. SteamOS, minimal Arch).
 *
 * Walks the target binary with `ldd` recursively, filters system libs
 * (glibc, X/GL/driver stack, dbus, etc.) via a denylist, and copies the
 * remaining shared objects plus WebKit helper processes + GIO modules
 * into `<root>/usr/lib/<app>/`. Finally, rewrites the binary as a tiny
 * launcher shell script that sets LD_LIBRARY_PATH, WEBKIT_EXEC_PATH,
 * GIO_MODULE_DIR, GDK_PIXBUF_MODULE_FILE before exec'ing the real binary.
 *
 * Usage:
 *   node scripts/bundle-linux-portable.mjs <installRoot> <binaryRelPath> <appSlug>
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , installRootArg, binaryRelArg, appSlugArg] = process.argv;
if (!installRootArg || !binaryRelArg || !appSlugArg) {
  console.error(
    "usage: bundle-linux-portable.mjs <installRoot> <binaryRelPath> <appSlug>",
  );
  process.exit(2);
}

const installRoot = path.resolve(installRootArg);
const binaryAbs = path.join(installRoot, binaryRelArg);
const appSlug = appSlugArg;

if (!existsSync(binaryAbs)) {
  throw new Error(`Binary not found: ${binaryAbs}`);
}

// Libraries we refuse to bundle. These must come from the host:
//   - glibc / dynamic loader (per-host ABI)
//   - X11 / Wayland / GL / DRM / driver stack (must match host GPU)
//   - dbus + systemd + udev (system bus sockets / policies match host)
//   - sound stack (pulse/alsa configs are per-host)
const denyExact = new Set([
  // glibc & loader
  "libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1",
  "libresolv.so.2", "libnsl.so.1", "libutil.so.1", "libcrypt.so.1",
  "ld-linux-x86-64.so.2", "ld-linux.so.2", "libBrokenLocale.so.1", "libanl.so.1",
  // GPU / graphics / display
  "libGL.so.1", "libEGL.so.1", "libGLX.so.0", "libGLdispatch.so.0",
  "libOpenGL.so.0", "libGLESv2.so.2", "libGLESv1_CM.so.1",
  "libgbm.so.1", "libdrm.so.2",
  "libva.so.2", "libva-drm.so.2", "libva-x11.so.2", "libvdpau.so.1",
  // X11
  "libX11.so.6", "libX11-xcb.so.1",
  "libxcb.so.1", "libxcb-render.so.0", "libxcb-shm.so.0",
  "libxcb-dri2.so.0", "libxcb-dri3.so.0", "libxcb-present.so.0",
  "libxcb-sync.so.1", "libxcb-shape.so.0", "libxcb-xfixes.so.0",
  "libxcb-randr.so.0", "libxcb-glx.so.0", "libxcb-util.so.1",
  "libxcb-keysyms.so.1", "libxcb-icccm.so.4", "libxcb-image.so.0",
  "libxcb-render-util.so.0", "libxcb-xkb.so.1",
  "libXext.so.6", "libXi.so.6", "libXrandr.so.2", "libXcursor.so.1",
  "libXcomposite.so.1", "libXdamage.so.1", "libXfixes.so.3",
  "libXrender.so.1", "libXtst.so.6", "libXau.so.6", "libXdmcp.so.6",
  "libXinerama.so.1", "libXss.so.1", "libXxf86vm.so.1",
  "libxkbcommon.so.0", "libxkbcommon-x11.so.0", "libxshmfence.so.1",
  // Wayland
  "libwayland-client.so.0", "libwayland-cursor.so.0",
  "libwayland-egl.so.1", "libwayland-server.so.0",
  // DBus / systemd / udev
  "libdbus-1.so.3", "libdbus-glib-1.so.2",
  "libsystemd.so.0", "libudev.so.1",
  // Sound
  "libasound.so.2",
  "libpulse.so.0", "libpulse-simple.so.0", "libpulse-mainloop-glib.so.0",
  "libjack.so.0", "libpipewire-0.3.so.0",
]);

// Prefix-based denies for things NSS/driver stacks load dynamically.
const denyPrefix = ["libnss_", "libnvidia-", "libcuda"];

function isDenied(soname) {
  if (denyExact.has(soname)) return true;
  for (const p of denyPrefix) {
    if (soname.startsWith(p)) return true;
  }
  return false;
}

function readlinkF(p) {
  return execFileSync("readlink", ["-f", p], { encoding: "utf8" }).trim();
}

function lddOf(file) {
  const out = execFileSync("ldd", [file], { encoding: "utf8" });
  const map = new Map();
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // "libfoo.so.1 => not found" — skip it (best we can do on the host)
    if (/=>\s*not found/.test(line)) continue;
    // "libfoo.so.1 => /path/libfoo.so.1 (0x...)"
    const arrow = line.match(/^(\S+)\s+=>\s+(\/\S+)/);
    if (arrow) {
      map.set(path.basename(arrow[1]), arrow[2]);
      continue;
    }
    // "/lib64/ld-linux-x86-64.so.2 (0x...)"
    const bare = line.match(/^(\/\S+)\s+\(0x/);
    if (bare) {
      map.set(path.basename(bare[1]), bare[1]);
    }
    // "linux-vdso.so.1 (0x...)" — no path, skip
  }
  return map;
}

function bundleLib(srcPath, destDir) {
  // Produces: destDir/<real-basename> as a real file, plus a symlink
  // destDir/<requested-soname> -> <real-basename> so whichever name the
  // loader asks for is resolvable from LD_LIBRARY_PATH.
  const realPath = readlinkF(srcPath);
  const realBase = path.basename(realPath);
  const destReal = path.join(destDir, realBase);
  if (!existsSync(destReal)) {
    copyFileSync(realPath, destReal);
    chmodSync(destReal, 0o755);
  }
  const requestedBase = path.basename(srcPath);
  if (requestedBase !== realBase) {
    const linkPath = path.join(destDir, requestedBase);
    if (!existsSync(linkPath)) {
      try {
        symlinkSync(realBase, linkPath);
      } catch {
        copyFileSync(realPath, linkPath);
        chmodSync(linkPath, 0o755);
      }
    }
  }
  return destReal;
}

function isElf(p) {
  try {
    const head = readFileSync(p).subarray(0, 4);
    return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  } catch {
    return false;
  }
}

function bundleBinaryDeps(binaryPath, libDir) {
  const queue = [binaryPath];
  const visitedByReal = new Set();
  while (queue.length > 0) {
    const target = queue.shift();
    let realTarget;
    try {
      realTarget = readlinkF(target);
    } catch {
      continue;
    }
    if (visitedByReal.has(realTarget)) continue;
    visitedByReal.add(realTarget);
    if (!isElf(realTarget)) continue;
    let deps;
    try {
      deps = lddOf(realTarget);
    } catch (err) {
      console.warn(`ldd failed on ${realTarget}: ${err.message}`);
      continue;
    }
    for (const [soname, resolved] of deps) {
      if (isDenied(soname)) continue;
      bundleLib(resolved, libDir);
      queue.push(resolved);
    }
  }
}

// --- Step 1: prepare output dir ---
const libDir = path.join(installRoot, "usr/lib", appSlug);
mkdirSync(libDir, { recursive: true });

console.log(`Bundling shared-library deps for ${binaryAbs}`);
bundleBinaryDeps(binaryAbs, libDir);

// --- Step 2: find + bundle WebKit helper binaries ---
// WebKitGTK 4.1 launches WebKitWebProcess / WebKitNetworkProcess from
// its libexec dir. Bundle the whole dir and point WEBKIT_EXEC_PATH at
// our copy.
const webkitHelperCandidates = [
  "/usr/libexec/webkit2gtk-4.1",
  "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1",
  "/usr/lib/webkit2gtk-4.1",
];
let webkitHelperSrc = null;
for (const c of webkitHelperCandidates) {
  if (existsSync(c)) {
    webkitHelperSrc = c;
    break;
  }
}
const webkitExecDest = path.join(libDir, "webkit2gtk-4.1");
if (webkitHelperSrc) {
  mkdirSync(webkitExecDest, { recursive: true });
  execFileSync("cp", ["-a", `${webkitHelperSrc}/.`, webkitExecDest]);
  // Walk helper binaries for their deps too.
  for (const entry of readdirSync(webkitExecDest, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const p = path.join(webkitExecDest, entry.name);
    if (isElf(p)) bundleBinaryDeps(p, libDir);
  }
  console.log(`Bundled WebKit helpers from ${webkitHelperSrc}`);
} else {
  console.warn(
    "webkit2gtk-4.1 helper dir not found on host; WebKitWebProcess will be missing.",
  );
}

// --- Step 3: bundle GIO modules ---
const gioCandidates = [
  "/usr/lib/x86_64-linux-gnu/gio/modules",
  "/usr/lib/gio/modules",
];
let gioSrc = null;
for (const c of gioCandidates) {
  if (existsSync(c)) {
    gioSrc = c;
    break;
  }
}
if (gioSrc) {
  const gioDest = path.join(libDir, "gio/modules");
  mkdirSync(gioDest, { recursive: true });
  for (const entry of readdirSync(gioSrc)) {
    if (!entry.endsWith(".so")) continue;
    const src = path.join(gioSrc, entry);
    copyFileSync(src, path.join(gioDest, entry));
    bundleBinaryDeps(src, libDir);
  }
  console.log(`Bundled GIO modules from ${gioSrc}`);
}

// --- Step 4: bundle GDK-Pixbuf loaders ---
const pixbufCandidates = [
  "/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0",
  "/usr/lib/gdk-pixbuf-2.0",
];
let pixbufSrc = null;
for (const c of pixbufCandidates) {
  if (existsSync(c)) {
    pixbufSrc = c;
    break;
  }
}
if (pixbufSrc) {
  const pixbufDest = path.join(libDir, "gdk-pixbuf-2.0");
  execFileSync("cp", ["-a", pixbufSrc, pixbufDest]);
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith(".so")) {
        try {
          bundleBinaryDeps(p, libDir);
        } catch {}
      }
    }
  };
  walk(pixbufDest);
  console.log(`Bundled GDK-Pixbuf loaders from ${pixbufSrc}`);
}

// --- Step 5: rewrite the main binary as a launcher shell script ---
const realBinaryName = path.basename(binaryAbs) + ".real";
const realBinaryPath = path.join(path.dirname(binaryAbs), realBinaryName);
renameSync(binaryAbs, realBinaryPath);

const launcher = `#!/usr/bin/env bash
# Auto-generated by bundle-linux-portable.mjs. Makes the app runnable
# on distros (SteamOS, minimal Arch, etc.) that don't ship webkit2gtk-4.1
# by pointing the runtime at bundled library copies.
set -e

here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
bundled_lib="$(cd "$here/../lib/${appSlug}" && pwd)"

export LD_LIBRARY_PATH="$bundled_lib\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ -d "$bundled_lib/webkit2gtk-4.1" ]; then
  export WEBKIT_EXEC_PATH="$bundled_lib/webkit2gtk-4.1"
  if [ -d "$bundled_lib/webkit2gtk-4.1/injected-bundle" ]; then
    export WEBKIT_INJECTED_BUNDLE_PATH="$bundled_lib/webkit2gtk-4.1/injected-bundle"
  fi
fi
if [ -d "$bundled_lib/gio/modules" ]; then
  export GIO_MODULE_DIR="$bundled_lib/gio/modules"
  export GIO_EXTRA_MODULES="$bundled_lib/gio/modules\${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
fi
if [ -d "$bundled_lib/gdk-pixbuf-2.0" ]; then
  # The cache file from the build host has absolute paths baked in;
  # regenerate it if the host has gdk-pixbuf-query-loaders available so
  # the loaders resolve against our bundled copy.
  loader_dir="$(find "$bundled_lib/gdk-pixbuf-2.0" -type d -name loaders -print -quit 2>/dev/null || true)"
  if [ -n "$loader_dir" ]; then
    cache_file="$bundled_lib/gdk-pixbuf-2.0/loaders.cache.runtime"
    if command -v gdk-pixbuf-query-loaders >/dev/null 2>&1; then
      GDK_PIXBUF_MODULEDIR="$loader_dir" gdk-pixbuf-query-loaders > "$cache_file" 2>/dev/null || true
      if [ -s "$cache_file" ]; then
        export GDK_PIXBUF_MODULE_FILE="$cache_file"
      fi
    fi
  fi
fi

exec "$here/${path.basename(realBinaryPath)}" "$@"
`;

writeFileSync(binaryAbs, launcher);
chmodSync(binaryAbs, 0o755);

console.log(`Rewrote ${binaryAbs} as launcher, real binary at ${realBinaryPath}`);
console.log(`Bundled libs: ${libDir}`);
