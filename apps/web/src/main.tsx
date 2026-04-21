import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./index.css";

const LOCAL_SERVICE_WORKER_DISABLED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "tauri.localhost",
]);
const SERVICE_WORKER_RESET_KEY = "farfield.service-worker-reset.v1";

const stored = localStorage.getItem("theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (stored === "dark" || (!stored && prefersDark)) {
  document.documentElement.classList.add("dark");
}

async function configureServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (
    !LOCAL_SERVICE_WORKER_DISABLED_HOSTS.has(window.location.hostname)
  ) {
    registerSW({ immediate: true });
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ("caches" in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)));
  }

  const shouldReload =
    navigator.serviceWorker.controller !== null &&
    window.sessionStorage.getItem(SERVICE_WORKER_RESET_KEY) !== "1";

  if (shouldReload) {
    window.sessionStorage.setItem(SERVICE_WORKER_RESET_KEY, "1");
    window.location.reload();
    return;
  }

  window.sessionStorage.removeItem(SERVICE_WORKER_RESET_KEY);
}

void configureServiceWorker();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
