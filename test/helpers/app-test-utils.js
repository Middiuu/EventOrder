const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

function clearAppModules() {
  const modules = [
    path.join(PROJECT_ROOT, "src/app.js"),
    path.join(PROJECT_ROOT, "src/db.js"),
    path.join(PROJECT_ROOT, "src/config.js"),
    path.join(PROJECT_ROOT, "src/auth.js"),
    path.join(PROJECT_ROOT, "src/printer.js"),
    path.join(PROJECT_ROOT, "src/pending-sales.js"),
    path.join(PROJECT_ROOT, "src/routes/products.js"),
    path.join(PROJECT_ROOT, "src/routes/sales.js"),
    path.join(PROJECT_ROOT, "src/routes/sessions.js"),
    path.join(PROJECT_ROOT, "src/routes/reports.js"),
    path.join(PROJECT_ROOT, "src/server.js"),
  ];

  for (const modulePath of modules) {
    delete require.cache[modulePath];
  }
}

function loadApp({ dbPath, printTicket, env = {} } = {}) {
  process.env.POS_DB_PATH = dbPath;
  // Override d'ambiente per-test (es. APP_PIN): config.js li legge al require.
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  clearAppModules();
  const { createApp } = require("../../src/app");
  return createApp({ printTicket });
}

// Richiesta HTTP reale verso il server di test. I redirect non vengono
// seguiti, cosi' i test possono verificare status 302 e header Location.
async function requestHttp(baseUrl, { method = "GET", url = "/", headers = {}, body } = {}) {
  const res = await fetch(baseUrl + url, { method, headers, body, redirect: "manual" });
  const buffer = Buffer.from(await res.arrayBuffer());

  const responseHeaders = {};
  for (const [key, value] of res.headers.entries()) {
    responseHeaders[key] = value;
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  if (setCookie.length > 0) {
    responseHeaders["set-cookie"] = setCookie.join("; ");
  }

  return {
    status: res.status,
    headers: responseHeaders,
    buffer,
    text: buffer.toString("utf8"),
    json() {
      return JSON.parse(buffer.toString("utf8") || "{}");
    },
  };
}

function createHarness(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventorder-app-"));
  const dbPath = path.join(tempDir, "pos.sqlite");
  const app = loadApp({ ...options, dbPath });

  return {
    tempDir,
    dbPath,
    app,
    async withServer(run) {
      const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        return await run({
          request: (reqOptions) => requestHttp(baseUrl, reqOptions),
        });
      } finally {
        await new Promise((resolve) => {
          server.close(resolve);
          // chiude anche le connessioni keep-alive di fetch, altrimenti
          // close() resterebbe in attesa che scadano da sole
          server.closeAllConnections();
        });
      }
    },
    cleanup() {
      delete process.env.POS_DB_PATH;
      for (const key of Object.keys(options.env || {})) {
        delete process.env[key];
      }
      clearAppModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

module.exports = { createHarness };
