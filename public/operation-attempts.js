/* exported EventOrderAttempts */
(function attachOperationAttempts(root) {
  const keys = Object.freeze({
    checkout: "eventorder-pending-checkout-v1",
    movement: "eventorder-pending-movement-v1",
    suspend: "eventorder-pending-suspend-v1",
    resume: "eventorder-pending-resume-v1",
  });

  function newRequestId(cryptoApi = root.crypto, now = Date.now, random = Math.random) {
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `eo-${now().toString(36)}-${random().toString(36).slice(2)}`;
  }

  function createAttemptStore(storage) {
    function storageKey(kind) {
      const key = keys[kind];
      if (!key) throw new TypeError(`Tentativo operativo sconosciuto: ${kind}`);
      return key;
    }

    function clear(kind) {
      try { storage.removeItem(storageKey(kind)); } catch {}
    }

    function save(kind, value, { sessionId, databaseInstanceId }) {
      try {
        const key = storageKey(kind);
        if (!value) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify({
          ...value,
          session_id: sessionId ?? null,
          database_instance_id: databaseInstanceId,
        }));
      } catch {
        // Il server resta idempotente anche se lo storage del browser e' disabilitato.
      }
    }

    function load(kind, { sessionId, databaseInstanceId }) {
      try {
        const value = JSON.parse(storage.getItem(storageKey(kind)) || "null");
        if (!value) return null;
        if (value.session_id !== (sessionId ?? null)
          || value.database_instance_id !== databaseInstanceId
          || typeof value.requestId !== "string") {
          clear(kind);
          return null;
        }
        return value;
      } catch {
        clear(kind);
        return null;
      }
    }

    return Object.freeze({ clear, load, save });
  }

  root.EventOrderAttempts = Object.freeze({ createAttemptStore, keys, newRequestId });
})(globalThis);
