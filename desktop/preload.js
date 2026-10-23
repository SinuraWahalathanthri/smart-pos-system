"use strict";

/**
 * The only bridge between the Electron main process and the page.
 *
 * The renderer runs the same code as the public website, so it is treated as untrusted: this exposes
 * one plain data object and nothing else. No fs, no ipcRenderer, no Node.
 *
 * The data is a preconfigured Supabase project (see main.js). It lets an installer arrive already
 * connected, which NEXT_PUBLIC_* cannot do because the bundler inlines those at build time.
 */

const { contextBridge, ipcRenderer } = require("electron");

let config = null;
try {
  config = ipcRenderer.sendSync("pos:config");
} catch {
  // Main process not listening (e.g. a smoke run); the app falls back to in-app setup.
  config = null;
}

contextBridge.exposeInMainWorld("posDesktop", {
  config: config && config.url && config.anonKey ? { url: config.url, anonKey: config.anonKey } : null,
});
