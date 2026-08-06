require("dotenv").config({ quiet: true });

const { createApp } = require("./app");
const { config } = require("./config");
const { closeDatabase } = require("./db");
const { markShuttingDown } = require("./operational-status");
const { createShutdownController } = require("./server-lifecycle");

const app = createApp();
let server;
let shutdownController;

function shutdown(signal) {
  return shutdownController?.shutdown(signal) || false;
}

function startServer() {
  if (server) return server;
  server = app.listen(config.PORT, config.HOST, () => {
    const actualPort = server.address().port;
    console.log(`${config.APP_NAME} avviato su http://${config.HOST}:${actualPort}`);
  });
  shutdownController = createShutdownController({
    server,
    closeDatabase,
    markShuttingDown,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  process.once("SIGINT", shutdown.bind(null, "SIGINT"));
  process.once("SIGTERM", shutdown.bind(null, "SIGTERM"));
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, shutdown };
