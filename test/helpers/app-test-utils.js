const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Duplex } = require("stream");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

class MockSocket extends Duplex {
  constructor() {
    super();
    this.chunks = [];
    this.remoteAddress = "127.0.0.1";
  }

  _read() {}

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function clearAppModules() {
  const modules = [
    path.join(PROJECT_ROOT, "src/app.js"),
    path.join(PROJECT_ROOT, "src/db.js"),
    path.join(PROJECT_ROOT, "src/config.js"),
    path.join(PROJECT_ROOT, "src/auth.js"),
    path.join(PROJECT_ROOT, "src/printer.js"),
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

function loadApp({ dbPath, printTicket } = {}) {
  process.env.POS_DB_PATH = dbPath;
  clearAppModules();
  const { createApp } = require("../../src/app");
  return createApp({ printTicket });
}

function parseRawHttpResponse(buffer) {
  const raw = buffer.toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerPart = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  let bodyBuffer = headerEnd >= 0 ? buffer.subarray(headerEnd + 4) : Buffer.alloc(0);
  const headerLines = headerPart.split("\r\n");
  const statusLine = headerLines.shift() || "HTTP/1.1 500";
  const status = Number(statusLine.split(" ")[1] || 500);
  const headers = {};

  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }

  if (headers["transfer-encoding"] === "chunked") {
    const decoded = [];
    let offset = 0;

    while (offset < bodyBuffer.length) {
      const lenEnd = bodyBuffer.indexOf("\r\n", offset, "utf8");
      const lenHex = bodyBuffer.toString("utf8", offset, lenEnd);
      const len = parseInt(lenHex, 16);
      if (!len) break;
      const chunkStart = lenEnd + 2;
      const chunkEnd = chunkStart + len;
      decoded.push(bodyBuffer.subarray(chunkStart, chunkEnd));
      offset = chunkEnd + 2;
    }

    bodyBuffer = Buffer.concat(decoded);
  }

  return {
    status,
    headers,
    buffer: bodyBuffer,
    text: bodyBuffer.toString("utf8"),
    json() {
      return JSON.parse(bodyBuffer.toString("utf8") || "{}");
    },
  };
}

function requestApp(app, { method = "GET", url = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuffer = body === undefined
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body));

    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    );

    if (bodyBuffer && normalizedHeaders["content-length"] === undefined) {
      normalizedHeaders["content-length"] = String(bodyBuffer.length);
    }

    const reqSocket = new MockSocket();
    const req = new http.IncomingMessage(reqSocket);
    req.method = method;
    req.url = url;
    req.headers = normalizedHeaders;
    req.connection = req.socket;

    const resSocket = new MockSocket();
    const res = new http.ServerResponse(req);
    res.assignSocket(resSocket);

    res.on("finish", () => {
      resolve(parseRawHttpResponse(Buffer.concat(resSocket.chunks)));
    });
    res.on("error", reject);

    app.handle(req, res, reject);

    if (bodyBuffer) {
      req.push(bodyBuffer);
    }
    req.push(null);
  });
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
      return run({
        request: (reqOptions) => requestApp(app, reqOptions),
      });
    },
    cleanup() {
      delete process.env.POS_DB_PATH;
      clearAppModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

module.exports = { createHarness };
