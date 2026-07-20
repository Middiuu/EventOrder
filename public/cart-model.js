/* exported EventOrderCart */
(function attachCartModel(root) {
  const CART_DRAFT_KEY = "eventorder-current-cart-v1";

  function productAvailable(product) {
    return !product.sold_out && !(product.stock != null && product.stock <= 0);
  }

  function createCartModel(storage) {
    const items = new Map();
    let persistenceEnabled = false;

    function total() {
      let value = 0;
      for (const item of items.values()) value += item.qty * item.unit_price_cents;
      return value;
    }

    function buildItem(product, qty, selectedIds = [], note = null) {
      if (!Number.isSafeInteger(qty) || qty <= 0) return { error: "Quantità non valida" };
      const normalizedIds = [...new Set(selectedIds.map(Number))].sort((a, b) => a - b);
      const selectedSet = new Set(normalizedIds);
      const groups = product.option_groups || [];
      const known = new Set(groups.flatMap(group => group.options.map(option => option.id)));
      if (normalizedIds.some(id => !known.has(id))) return { error: "Opzione non più disponibile" };

      const selectedOptions = [];
      for (const group of groups) {
        const selected = group.options.filter(option => selectedSet.has(option.id));
        if (group.required && selected.length === 0) {
          return { error: `Scegli un'opzione per ${group.name}` };
        }
        if (group.selection_type === "single" && selected.length > 1) {
          return { error: `Scegli una sola opzione per ${group.name}` };
        }
        for (const option of selected) {
          selectedOptions.push({
            group_id: group.id,
            group_name: group.name,
            value_id: option.id,
            name: option.name,
            price_delta_cents: option.price_delta_cents,
          });
        }
      }

      const cleanNote = String(note || "").trim().slice(0, 240) || null;
      const unitPrice = product.price_cents
        + selectedOptions.reduce((sum, option) => sum + option.price_delta_cents, 0);
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
        return { error: "Prezzo finale non valido" };
      }
      const key = JSON.stringify([product.id, normalizedIds, cleanNote]);
      return {
        key,
        item: {
          product,
          qty,
          selected_option_value_ids: normalizedIds,
          selected_options: selectedOptions,
          note: cleanNote,
          unit_price_cents: unitPrice,
        },
      };
    }

    function quantityForProduct(productId, exceptKey = null) {
      let qty = 0;
      for (const [key, item] of items) {
        if (key !== exceptKey && item.product.id === productId) qty += item.qty;
      }
      return qty;
    }

    function removeStoredDraft() {
      try { storage.removeItem(CART_DRAFT_KEY); } catch {}
    }

    function persist({ sessionId, databaseInstanceId, note }) {
      if (!persistenceEnabled) return;
      try {
        if (items.size === 0) {
          storage.removeItem(CART_DRAFT_KEY);
          return;
        }
        storage.setItem(CART_DRAFT_KEY, JSON.stringify({
          session_id: sessionId ?? null,
          database_instance_id: databaseInstanceId,
          saved_at: new Date().toISOString(),
          note: String(note || "").trim() || null,
          items: Array.from(items.values()).map(item => ({
            product_id: item.product.id,
            qty: item.qty,
            selected_option_value_ids: item.selected_option_value_ids,
            note: item.note,
          })),
        }));
      } catch {
        // Lo storage locale puo' essere disabilitato: il POS resta utilizzabile.
      }
    }

    function recover({ products, sessionId, databaseInstanceId }) {
      let draft;
      try {
        draft = JSON.parse(storage.getItem(CART_DRAFT_KEY) || "null");
      } catch {
        removeStoredDraft();
        return { recovered: false, skipped: [] };
      }
      if (!draft || !Array.isArray(draft.items)) return { recovered: false, skipped: [] };
      if (draft.database_instance_id !== databaseInstanceId
        || (draft.session_id != null && draft.session_id !== sessionId)) {
        removeStoredDraft();
        return { recovered: false, skipped: [] };
      }

      const byId = new Map(products.map(product => [product.id, product]));
      let recovered = 0;
      const skipped = [];
      const usedStock = new Map();
      for (const draftItem of draft.items) {
        const product = byId.get(draftItem?.product_id);
        if (!product || !Number.isSafeInteger(draftItem?.qty)
          || draftItem.qty <= 0 || !productAvailable(product)) {
          skipped.push(product?.name || `Prodotto #${draftItem?.product_id || "?"}`);
          continue;
        }
        const built = buildItem(
          product,
          draftItem.qty,
          draftItem.selected_option_value_ids || [],
          draftItem.note
        );
        if (built.error) {
          skipped.push(product.name);
          continue;
        }
        const alreadyUsed = usedStock.get(product.id) || 0;
        const qty = product.stock == null
          ? draftItem.qty
          : Math.min(draftItem.qty, Math.max(0, product.stock - alreadyUsed));
        if (qty <= 0) {
          skipped.push(product.name);
          continue;
        }
        if (qty !== draftItem.qty) skipped.push(product.name);
        built.item.qty = qty;
        items.set(built.key, built.item);
        usedStock.set(product.id, alreadyUsed + qty);
        recovered += qty;
      }
      return {
        recovered: recovered > 0,
        skipped: [...new Set(skipped)],
        note: String(draft.note || "").slice(0, 500),
      };
    }

    function reconcile(products) {
      const byId = new Map(products.map(product => [product.id, product]));
      const oldTotal = total();
      const priceChanges = [];
      const removed = [];
      const unavailable = [];
      const reconciled = new Map();
      const requestedStock = new Map();

      for (const item of items.values()) {
        const current = byId.get(item.product.id);
        if (!current) {
          removed.push(item.product.name);
          continue;
        }
        const built = buildItem(
          current,
          item.qty,
          item.selected_option_value_ids,
          item.note
        );
        if (built.error) {
          removed.push(`${current.name} (${built.error})`);
          continue;
        }
        if (built.item.unit_price_cents !== item.unit_price_cents) {
          priceChanges.push({
            name: current.name,
            from: item.unit_price_cents,
            to: built.item.unit_price_cents,
          });
        }
        reconciled.set(built.key, built.item);
        requestedStock.set(current.id, (requestedStock.get(current.id) || 0) + item.qty);
        if (!productAvailable(current)) unavailable.push(current.name);
      }

      items.clear();
      for (const [key, item] of reconciled) items.set(key, item);
      for (const [productId, qty] of requestedStock) {
        const product = byId.get(productId);
        if (product?.stock != null && qty > product.stock) unavailable.push(product.name);
      }
      return { oldTotal, newTotal: total(), priceChanges, removed, unavailable };
    }

    return Object.freeze({
      items,
      total,
      buildItem,
      quantityForProduct,
      persist,
      recover,
      reconcile,
      enablePersistence() { persistenceEnabled = true; },
    });
  }

  root.EventOrderCart = Object.freeze({ createCartModel, productAvailable });
})(globalThis);
