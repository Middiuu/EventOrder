let restoreInProgress = false;

function beginRestore() {
  if (restoreInProgress) return false;
  restoreInProgress = true;
  return true;
}

function endRestore() {
  restoreInProgress = false;
}

// Durante un restore le letture possono continuare, ma nessuna seconda
// operazione deve modificare il database che sta per essere sostituito.
function maintenanceMiddleware(req, res, next) {
  if (!restoreInProgress || req.method === "GET" || req.method === "HEAD") {
    return next();
  }
  res.setHeader("Retry-After", "2");
  return res.status(503).json({
    error: "Ripristino del database in corso. Riprova tra pochi secondi.",
  });
}

module.exports = { beginRestore, endRestore, maintenanceMiddleware };
