require("dotenv").config({ quiet: true });

const { createApp } = require("./app");
const { config } = require("./config");
const { closeDatabase } = require("./db");

const PORT = process.env.PORT || 3000;
const app = createApp();
let server;
let shuttingDown = false;

function shutdown(signal) {
  if (!server || shuttingDown) return;
  shuttingDown = true;
  console.log(`Ricevuto ${signal}: arresto ordinato in corso...`);

  // Le richieste gia' avviate (in particolare stampa, backup e restore) devono
  // terminare davvero prima di chiudere SQLite. Forzarne il socket non annulla
  // necessariamente il lavoro asincrono sottostante.
  server.close((serverError) => {
    let exitCode = serverError ? 1 : 0;
    if (serverError) console.error("Errore durante la chiusura HTTP:", serverError);
    try {
      closeDatabase();
    } catch (err) {
      exitCode = 1;
      console.error("Errore durante la chiusura SQLite:", err);
    }
    process.exitCode = exitCode;
  });
  server.closeIdleConnections();
}

function startServer() {
  if (server) return server;
  server = app.listen(PORT, config.HOST, () => {
    console.log(`${config.APP_NAME} avviato su http://${config.HOST}:${PORT}`);
  });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, shutdown };
