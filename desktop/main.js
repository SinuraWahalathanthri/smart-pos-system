"use strict";

/**
 * The desktop till.
 *
 * This loads the same Next.js build the website runs, but from files inside the app instead of a
 * Vercel deployment. The shop keeps selling when the internet is down, which is the whole point of
 * a counter-side till; the sync engine in lib/sync uploads sales when a connection returns.
 *
 * Two things matter more than they look:
 *  - A custom app:// scheme, not file://. IndexedDB (Dexie: the product catalogue, the sale queue,
 *    the stored invoices) is partitioned per origin and is unreliable on file://. app:// gives the
 *    bundle one stable, secure origin, so the local database survives upgrades.
 *  - Nothing from the renderer may reach Node. The renderer runs the same code as the public site,
 *    so it is treated as untrusted: no nodeIntegration, no remote module, no window.open.
 */

const { app, BrowserWindow, Menu, shell, session, dialog, protocol } = require("electron");
const path = require("node:path");
const { createHandler, APP_ORIGIN } = require("./protocol");

const isDev = !app.isPackaged && process.env.DESKTOP_DEV === "1";
const DEV_URL = process.env.DESKTOP_DEV_URL || "http://localhost:3000";

/** The static export built by `BUILD_TARGET=desktop next build`. */
const WEB_ROOT = path.join(__dirname, "..", "out");

const SCHEME = "app";

// Must run before `ready`, and before any window exists. Privileging the scheme is what makes it a
// real origin (not "null"), which is in turn what makes fetch(), web fonts and IndexedDB work.
// The unpackaged smoke test registers this itself, so a missing registration here only shows up in
// the packaged build - which is exactly where it did.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow = null;
/**
 * `--smoke`: boot the app, check the UI actually rendered, exit 0/1.
 *
 * Used to verify a *packaged* build (asar paths, protocol registration and the shipped export are
 * all different from a dev run). A process that merely stays alive proves nothing - a blank window
 * does that too - so this asserts on the rendered document.
 */
async function runSmokeCheck() {
  const win = createWindow(false);
  const failures = [];
  const timer = setTimeout(() => fail("timed out waiting for the till"), 45_000);
  win.webContents.session.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400 && !d.url.includes("favicon")) failures.push(`HTTP ${d.statusCode} for ${d.url}`);
  });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") failures.push(`renderer console: ${event.message}`);
  });
  win.webContents.once("did-finish-load", async () => {
    try {
      const report = await win.webContents.executeJavaScript(`(async () => {
        const loading = (t) => t.startsWith("Starting") || t.startsWith("Loading till");
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const t = document.body.innerText.trim();
          if (t && !loading(t)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const out = { href: location.href, text: document.body.innerText.trim().slice(0, 90) };
        out.indexedDb = await new Promise((resolve) => {
          try { const q = indexedDB.open("smoke", 1); q.onsuccess = () => { q.result.close(); resolve(true); }; q.onerror = () => resolve(false); }
          catch (e) { resolve(false); }
        });
        return out;
      })()`);
      if (!/\/(login|setup|pos)\//.test(report.href)) failures.push(`unexpected route ${report.href}`);
      if (report.text.length < 20) failures.push(`almost nothing rendered: ${JSON.stringify(report.text)}`);
      if (!report.indexedDb) failures.push("IndexedDB unavailable");
      console.log(JSON.stringify(report, null, 2));
      finish();
    } catch (e) {
      fail(`could not inspect the page: ${e && e.message ? e.message : e}`);
    }
  });
  function fail(reason) {
    failures.push(reason);
    finish();
  }
  function finish() {
    clearTimeout(timer);
    if (failures.length) {
      console.error("SMOKE FAILED:");
      for (const f of [...new Set(failures)]) console.error("  - " + f);
      app.exit(1);
    } else {
      console.log(`SMOKE OK: ${app.isPackaged ? "packaged" : "unpackaged"} app served the till and rendered it.`);
      app.exit(0);
    }
  }
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0f1115",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // The renderer is the same untrusted code as the website.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Barcode scanners and the keyboard-first till both want the window focused and awake.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  if (show) mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // A renderer that tries to escape must not be able to open a chrome-less window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Receipts and docs may legitimately be external links; send those to the real browser.
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Invoice and receipt downloads go through Chromium's download machinery inside Electron, not a
  // browser's. Without a handler the file lands somewhere unpredictable, so ask where to save and
  // keep the chosen name. The save dialog shows the real path, which is what a shopkeeper needs.
  mainWindow.webContents.session.on("will-download", (event, item) => {
    const suggested = item.getFilename();
    const { canceled, filePath } = dialog.showSaveDialogSync(mainWindow, {
      title: "Save invoice",
      defaultPath: path.join(app.getPath("documents"), suggested),
      filters: [{ name: "Invoice", extensions: [path.extname(suggested).replace(".", "") || "html"] }],
    });
    if (canceled || !filePath) {
      event.preventDefault();
      return;
    }
    item.setSavePath(filePath);
  });

  // Block in-page navigation away from the app (drag-and-drop of an HTML file, for instance).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? DEV_URL : `${APP_ORIGIN}/`;
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/pos/`);
  }
  return mainWindow;
}

// One till, one window. A second launch focuses the open one instead of opening a second copy
// that would fight over the same IndexedDB and local sale queue.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    protocol.handle(SCHEME, createHandler(WEB_ROOT));

    // Camera-less hardware: deny device permissions the shop has no use for.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write");
    });

    // Menu bar would let the till reload into a blank page mid-sale; keep only what is useful.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Till",
          submenu: [
            { role: "reload", accelerator: "CmdOrCtrl+R" },
            { role: "forceReload" },
            { type: "separator" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
        },
      ]),
    );

    // `--smoke` lets a packaged build verify itself; see runSmokeCheck above.
    if (process.argv.includes("--smoke")) {
      void runSmokeCheck();
      return;
    }

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // On macOS the app stays in the dock, as users expect.
  if (process.platform !== "darwin") app.quit();
});

// A hard failure here is worth showing; a silent white window at a counter is not debuggable.
process.on("uncaughtException", (err) => {
  console.error(err);
  if (app.isReady()) {
    dialog.showErrorBox("The till hit an unexpected error", String(err && err.stack ? err.stack : err));
  }
});
