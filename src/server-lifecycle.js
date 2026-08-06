function createShutdownController({
  server,
  closeDatabase,
  markShuttingDown,
  timeoutMs,
  logger = console,
  exit = process.exit,
}) {
  let shuttingDown = false;
  let finalized = false;
  let timeout;

  function finalize(serverError) {
    if (finalized) return;
    finalized = true;
    if (timeout) clearTimeout(timeout);

    let exitCode = serverError ? 1 : 0;
    if (serverError) logger.error("Errore durante la chiusura HTTP:", serverError);
    try {
      closeDatabase();
    } catch (error) {
      exitCode = 1;
      logger.error("Errore durante la chiusura SQLite:", error);
    }
    process.exitCode = exitCode;
  }

  function shutdown(signal) {
    if (shuttingDown) return false;
    shuttingDown = true;
    markShuttingDown();
    logger.log(`Ricevuto ${signal}: arresto ordinato in corso...`);

    timeout = setTimeout(() => {
      logger.error(`Arresto forzato dopo ${timeoutMs} ms: richieste HTTP ancora attive.`);
      try {
        server.closeAllConnections?.();
      } catch (error) {
        logger.error("Errore durante la chiusura forzata delle connessioni:", error);
      }
      finalize(new Error("Timeout arresto HTTP"));
      exit(1);
    }, timeoutMs);
    timeout.unref?.();

    try {
      server.close(finalize);
      server.closeIdleConnections?.();
    } catch (error) {
      finalize(error);
    }
    return true;
  }

  return { shutdown };
}

module.exports = { createShutdownController };
