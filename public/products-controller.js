/* exported initProdotti */
/* global api, closeModal, escapeHtml, euro, isTopModal, openModal, showToast, uiAlert, uiConfirm, uiError, withFormSubmitLock */
// Controller della pagina Prodotti. Script classico per restare compatibile
// con il router SPA senza introdurre un secondo sistema di moduli.
async function initProdotti(signal) {
  const table = document.querySelector("#productsTable");
  const form = document.querySelector("#productForm");
  const createCard = document.querySelector("#productCreateCard");
  const newBtn = document.querySelector("#newProductBtn");
  const cancelCreateBtn = document.querySelector("#cancelEditBtn");
  const searchEl = document.querySelector("#productsSearch");
  const modalEl = document.querySelector("#editProductModal");
  const editForm = document.querySelector("#editProductForm");
  const closeModalBtn = document.querySelector("#closeEditModalBtn");
  const cancelModalBtn = document.querySelector("#cancelEditModalBtn");
  const deleteBtn = document.querySelector("#deleteProductBtn");
  const createOptionsRoot = document.querySelector("#createOptionsEditor");
  const editOptionsRoot = document.querySelector("#editOptionsEditor");

  if (!table || !form) return;

  const nameEl = form.querySelector('input[name="name"]');
  const categoryEl = form.querySelector('input[name="category"]');
  const priceEl = form.querySelector('input[name="price_eur"]');
  const sortEl = form.querySelector('input[name="sort_order"]');
  const activeEl = form.querySelector('input[name="active"]');
  const stockEl = form.querySelector('input[name="stock"]');
  const costEl = form.querySelector('input[name="cost_eur"]');
  const editIdEl = editForm?.querySelector('input[name="id"]');
  const editNameEl = editForm?.querySelector('input[name="name"]');
  const editCategoryEl = editForm?.querySelector('input[name="category"]');
  const editPriceEl = editForm?.querySelector('input[name="price_eur"]');
  const editSortEl = editForm?.querySelector('input[name="sort_order"]');
  const editActiveEl = editForm?.querySelector('input[name="active"]');
  const editStockEl = editForm?.querySelector('input[name="stock"]');
  const editCostEl = editForm?.querySelector('input[name="cost_eur"]');
  const editSoldOutEl = editForm?.querySelector('input[name="sold_out"]');

  let allRows = [];
  let filteredRows = [];
  let sortable = null;

  function centsFromEuroInput(value) {
    const n = Number(String(value).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  }

  // Scorte dal form: "" = non tracciate (null), altrimenti intero >= 0.
  // Ritorna undefined se il valore non è valido.
  function stockFromInput(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return n;
  }

  // Costo dal form: "" = non tracciato (null), altrimenti euro -> centesimi.
  // Ritorna undefined se il valore non è valido.
  function costFromInput(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const cents = centsFromEuroInput(raw);
    if (cents === null) return undefined;
    return cents;
  }

  function setupOptionsEditor(root) {
    const list = root?.querySelector("[data-option-groups]");
    if (!root || !list) return { reset() {}, set() {}, read() { return { groups: [] }; } };

    function optionRow(option = {}) {
      const row = document.createElement("div");
      row.className = "option-value-row";
      if (option.id) row.dataset.optionId = String(option.id);
      row.innerHTML = `
        <label class="field"><span class="field-label">Scelta</span><input class="input" data-option-name maxlength="80" placeholder="Es. Grande" value="${escapeHtml(option.name || "")}"></label>
        <label class="field"><span class="field-label">Variazione €</span><input class="input mono" data-option-price type="number" step="0.01" value="${(Number(option.price_delta_cents || 0) / 100).toFixed(2)}"></label>
        <button class="btn btn-ghost btn-compact" type="button" data-remove-option>Rimuovi</button>`;
      return row;
    }

    function addGroup(group = {}) {
      const card = document.createElement("div");
      card.className = "option-group-card";
      if (group.id) card.dataset.groupId = String(group.id);
      card.innerHTML = `
        <div class="option-group-row">
          <label class="field"><span class="field-label">Nome gruppo</span><input class="input" data-group-name maxlength="80" placeholder="Es. Formato" value="${escapeHtml(group.name || "")}"></label>
          <label class="field"><span class="field-label">Tipo</span><select class="input" data-group-type><option value="single">Scelta singola</option><option value="multiple">Scelta multipla</option></select></label>
          <label class="toggle"><input type="checkbox" data-group-required><span>Obbligatoria</span></label>
          <button class="btn btn-ghost btn-compact" type="button" data-remove-group>Rimuovi gruppo</button>
        </div>
        <div class="option-values-list" data-option-values></div>
        <button class="btn btn-secondary btn-compact" type="button" data-add-option>Aggiungi scelta</button>`;
      card.querySelector("[data-group-type]").value = group.selection_type || "single";
      card.querySelector("[data-group-required]").checked = Boolean(group.required);
      const values = card.querySelector("[data-option-values]");
      const options = group.options?.length ? group.options : [{}, {}];
      for (const option of options) values.appendChild(optionRow(option));
      list.appendChild(card);
    }

    root.addEventListener("click", event => {
      if (event.target.closest("[data-add-option-group]")) addGroup();
      const removeGroup = event.target.closest("[data-remove-group]");
      if (removeGroup) removeGroup.closest(".option-group-card")?.remove();
      const addOption = event.target.closest("[data-add-option]");
      if (addOption) addOption.closest(".option-group-card")?.querySelector("[data-option-values]")?.appendChild(optionRow());
      const removeOption = event.target.closest("[data-remove-option]");
      if (removeOption) removeOption.closest(".option-value-row")?.remove();
    });

    return {
      reset() { list.innerHTML = ""; },
      set(groups = []) { list.innerHTML = ""; groups.forEach(addGroup); },
      read() {
        const groups = [];
        for (const [groupIndex, card] of [...list.querySelectorAll(".option-group-card")].entries()) {
          const name = card.querySelector("[data-group-name]").value.trim();
          if (!name) return { error: `Inserisci il nome del gruppo ${groupIndex + 1}.` };
          const options = [];
          for (const [optionIndex, row] of [...card.querySelectorAll(".option-value-row")].entries()) {
            const optionName = row.querySelector("[data-option-name]").value.trim();
            const rawPrice = row.querySelector("[data-option-price]").value.trim() || "0";
            const price = Number(rawPrice.replace(",", "."));
            if (!optionName) return { error: `Inserisci il nome della scelta ${optionIndex + 1} in ${name}.` };
            if (!Number.isFinite(price)) return { error: `Variazione prezzo non valida in ${name}.` };
            options.push({
              ...(row.dataset.optionId ? { id: Number(row.dataset.optionId) } : {}),
              name: optionName,
              price_delta_cents: Math.round(price * 100),
            });
          }
          if (options.length === 0) return { error: `Aggiungi almeno una scelta al gruppo ${name}.` };
          groups.push({
            ...(card.dataset.groupId ? { id: Number(card.dataset.groupId) } : {}),
            name,
            selection_type: card.querySelector("[data-group-type]").value,
            required: card.querySelector("[data-group-required]").checked ? 1 : 0,
            options,
          });
        }
        return { groups };
      },
    };
  }

  const createOptionsEditor = setupOptionsEditor(createOptionsRoot);
  const editOptionsEditor = setupOptionsEditor(editOptionsRoot);

  function resetCreateForm() {
    form.reset();
    sortEl.value = "0";
    activeEl.checked = true;
    createOptionsEditor.reset();
  }

  function openCreateForm() {
    resetCreateForm();
    if (createCard) createCard.hidden = false;
    createCard?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => nameEl.focus(), 0);
  }

  function closeCreateForm() {
    resetCreateForm();
    if (createCard) createCard.hidden = true;
  }

  function openEditModal(product) {
    if (!modalEl || !editForm) return;
    editIdEl.value = String(product.id);
    editNameEl.value = product.name ?? "";
    editCategoryEl.value = product.category ?? "Generale";
    editPriceEl.value = (Number(product.price_cents) / 100).toFixed(2);
    editSortEl.value = String(product.sort_order ?? 0);
    editActiveEl.checked = !!product.active;
    if (editStockEl) editStockEl.value = product.stock == null ? "" : String(product.stock);
    if (editCostEl) editCostEl.value = product.cost_cents == null ? "" : (Number(product.cost_cents) / 100).toFixed(2);
    if (editSoldOutEl) editSoldOutEl.checked = !!product.sold_out;
    editOptionsEditor.set(product.option_groups || []);
    openModal(modalEl);
    setTimeout(() => editNameEl.focus(), 0);
  }

  function closeEditModal() {
    if (!modalEl || !editForm) return;
    closeModal(modalEl);
    editForm.reset();
    editOptionsEditor.reset();
  }

  function statusPill(p) {
    if (!p.active) return '<span class="status-pill is-inactive">Disattivo</span>';
    if (p.sold_out || (p.stock != null && p.stock <= 0)) {
      return '<span class="status-pill is-soldout">Esaurito</span>';
    }
    return '<span class="status-pill is-active">Attivo</span>';
  }

  function renderTable() {
    const canReorder = !(searchEl?.value || "").trim();
    table.innerHTML = filteredRows.map((p, index) => `
      <tr>
        <td data-label="Sposta">
          <span class="table-handle" aria-hidden="true">⋮⋮</span>
          <span class="reorder-actions">
            <button class="btn btn-ghost btn-compact" data-move-product="${p.id}" data-direction="up" type="button" aria-label="Sposta ${escapeHtml(p.name)} in alto" ${!canReorder || index === 0 ? "disabled" : ""}>↑</button>
            <button class="btn btn-ghost btn-compact" data-move-product="${p.id}" data-direction="down" type="button" aria-label="Sposta ${escapeHtml(p.name)} in basso" ${!canReorder || index === filteredRows.length - 1 ? "disabled" : ""}>↓</button>
          </span>
        </td>
        <td data-label="Stato">${statusPill(p)}</td>
        <td data-label="Nome"><b>${escapeHtml(p.name)}</b>${p.option_groups?.length ? `<div class="small">${p.option_groups.length} ${p.option_groups.length === 1 ? "gruppo opzioni" : "gruppi opzioni"}</div>` : ""}</td>
        <td data-label="Categoria">${escapeHtml(p.category)}</td>
        <td data-label="Prezzo">${euro(p.price_cents)}</td>
        <td data-label="Scorte">${p.stock == null ? "—" : p.stock}</td>
        <td data-label="Azioni">
          <button class="btn btn-secondary btn-compact" data-edit="${p.id}" type="button">Modifica</button>
        </td>
      </tr>
    `).join("");

    syncSortableState();
  }

  function applySearch() {
    const q = (searchEl?.value || "").trim().toLowerCase();
    filteredRows = !q ? [...allRows] : allRows.filter(p => (`${p.name} ${p.category}`).toLowerCase().includes(q));
    renderTable();
  }

  function syncSortableState() {
    if (!window.Sortable || !table) return;

    if (!sortable) {
      sortable = window.Sortable.create(table, {
        animation: 180,
        handle: ".table-handle",
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        // Touch: piccola pressione prima di trascinare, così lo scroll col dito
        // non fa partire un riordino accidentale (col mouse resta immediato).
        delay: 140,
        delayOnTouchOnly: true,
        touchStartThreshold: 6,
        onEnd: async (evt) => {
          if (evt.oldIndex === evt.newIndex) return;
          if ((searchEl?.value || "").trim()) {
            showToast("Svuota la ricerca per riordinare l'elenco.");
            await refresh();
            return;
          }

          try {
            await moveProduct(evt.oldIndex, evt.newIndex);
          } catch (err) {
            await uiError(err);
            await refresh();
          }
        }
      });
    }

    sortable.option("disabled", Boolean((searchEl?.value || "").trim()));
  }

  async function moveProduct(fromIndex, toIndex) {
    if ((searchEl?.value || "").trim()) {
      showToast("Svuota la ricerca per riordinare l'elenco.");
      return;
    }
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const moved = filteredRows.splice(fromIndex, 1)[0];
    filteredRows.splice(toIndex, 0, moved);
    allRows = [...filteredRows];
    await api("/api/products/reorder", {
      method: "POST",
      body: JSON.stringify({ order: allRows.map(row => row.id) })
    });
    showToast("Ordine prodotti aggiornato");
    await refresh();
  }

  async function refresh() {
    allRows = await api("/api/products/all");
    filteredRows = [...allRows];
    applySearch();
  }

  table.addEventListener("click", (e) => {
    const moveButton = e.target?.closest?.("[data-move-product]");
    if (moveButton) {
      const index = allRows.findIndex(row => String(row.id) === moveButton.dataset.moveProduct);
      const offset = moveButton.dataset.direction === "up" ? -1 : 1;
      moveButton.disabled = true;
      moveProduct(index, index + offset).catch(async err => {
        await uiError(err);
        await refresh();
      });
      return;
    }
    const id = e.target?.getAttribute?.("data-edit");
    if (!id) return;
    const p = allRows.find(x => String(x.id) === String(id));
    if (p) openEditModal(p);
  });

  newBtn?.addEventListener("click", openCreateForm);
  cancelCreateBtn?.addEventListener("click", closeCreateForm);
  deleteBtn?.addEventListener("click", async () => {
    const id = String(editIdEl?.value || "").trim();
    if (!id) return;
    const p = allRows.find(x => String(x.id) === id);
    const ok = await uiConfirm(
      `Eliminare definitivamente "${p ? p.name : "questo prodotto"}"? L'operazione non si può annullare.`,
      "Elimina prodotto"
    );
    if (!ok) return;
    try {
      await api(`/api/products/${encodeURIComponent(id)}`, { method: "DELETE" });
      showToast("Prodotto eliminato");
      closeEditModal();
      await refresh();
    } catch (err) {
      await uiError(err);
    }
  });
  searchEl?.addEventListener("input", applySearch);
  closeModalBtn?.addEventListener("click", closeEditModal);
  cancelModalBtn?.addEventListener("click", closeEditModal);
  modalEl?.addEventListener("click", (e) => {
    if (e.target?.getAttribute?.("data-close-modal") === "1") {
      closeEditModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalEl && isTopModal(modalEl)) {
      closeEditModal();
    }
  }, { signal });

  form.onsubmit = async (e) => {
    e.preventDefault();

    const name = String(nameEl.value || "").trim();
    const category = String(categoryEl.value || "Generale").trim() || "Generale";
    const price_cents = centsFromEuroInput(priceEl.value);
    const sort_order = Number(sortEl.value || 0);
    const active = activeEl.checked ? 1 : 0;
    const stock = stockFromInput(stockEl?.value);
    const cost_cents = costFromInput(costEl?.value);
    const optionGroups = createOptionsEditor.read();

    if (!name) return uiAlert("Inserisci un nome prodotto.");
    if (price_cents === null) return uiAlert("Prezzo non valido.");
    if (stock === undefined) return uiAlert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return uiAlert("Costo non valido: importo in euro o vuoto.");
    if (optionGroups.error) return uiAlert(optionGroups.error);

    await withFormSubmitLock(form, async () => {
      try {
        await api("/api/products", { method: "POST", body: JSON.stringify({
          name, category, price_cents, sort_order, active, stock, cost_cents,
          option_groups: optionGroups.groups,
        }) });
        showToast("Prodotto creato");
        await refresh();
        closeCreateForm();
      } catch (err) {
        await uiError(err);
      }
    });
  };

  editForm.onsubmit = async (e) => {
    e.preventDefault();

    const id = String(editIdEl.value || "").trim();
    const name = String(editNameEl.value || "").trim();
    const category = String(editCategoryEl.value || "Generale").trim() || "Generale";
    const price_cents = centsFromEuroInput(editPriceEl.value);
    const sort_order = Number(editSortEl.value || 0);
    const active = editActiveEl.checked ? 1 : 0;
    const sold_out = editSoldOutEl?.checked ? 1 : 0;
    const stock = stockFromInput(editStockEl?.value);
    const cost_cents = costFromInput(editCostEl?.value);
    const optionGroups = editOptionsEditor.read();

    if (!id) return uiAlert("Prodotto non valido.");
    if (!name) return uiAlert("Inserisci un nome prodotto.");
    if (price_cents === null) return uiAlert("Prezzo non valido.");
    if (stock === undefined) return uiAlert("Scorte non valide: intero >= 0 o vuoto.");
    if (cost_cents === undefined) return uiAlert("Costo non valido: importo in euro o vuoto.");
    if (optionGroups.error) return uiAlert(optionGroups.error);

    await withFormSubmitLock(editForm, async () => {
      try {
        await api(`/api/products/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name, category, price_cents, sort_order, active, sold_out, stock, cost_cents,
            option_groups: optionGroups.groups,
          })
        });
        showToast("Prodotto aggiornato");
        closeEditModal();
        await refresh();
        resetCreateForm();
      } catch (err) {
        await uiError(err);
      }
    });
  };

  await refresh();
  resetCreateForm();
  if (createCard) createCard.hidden = true;
}
