// Stato transitorio delle vendite già registrate ma con stampa ancora in corso.
// Il server è locale e a processo singolo: questa mappa impedisce che altre API
// modifichino il turno mentre l'esito della stampa può ancora annullare la vendita.
const pendingSales = new Map();

function markSalePending(saleId, sessionId) {
  pendingSales.set(Number(saleId), Number(sessionId));
}

function unmarkSalePending(saleId) {
  pendingSales.delete(Number(saleId));
}

function isSalePending(saleId) {
  return pendingSales.has(Number(saleId));
}

function hasPendingSaleForSession(sessionId) {
  const target = Number(sessionId);
  return [...pendingSales.values()].some(id => id === target);
}

module.exports = {
  hasPendingSaleForSession,
  isSalePending,
  markSalePending,
  unmarkSalePending,
};
