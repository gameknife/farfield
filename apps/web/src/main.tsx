import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import "./index.css";

const stored = localStorage.getItem("theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
if (stored === "dark" || (!stored && prefersDark)) {
  document.documentElement.classList.add("dark");
}

const isLocalHost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "::1";

if (import.meta.env.DEV || isLocalHost) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      Promise.allSettled(
        registrations.map((registration) => registration.unregister()),
      ),
    )
    .catch((error) => {
      console.error("Failed to unregister service workers", error);
    });
} else {
  registerSW({ immediate: true });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
