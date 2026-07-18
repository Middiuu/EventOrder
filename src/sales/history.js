const { cleanText, localYmdToUtcSql, parseLocalYmd } = require("../validation");
const { badRequest } = require("./errors");
const { loadSaleItems } = require("./items");

function escapeLikeTerm(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function ftsPhrase(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function createSalesHistory({ database, getOpenSession, isSalePending, paymentMethods }) {
  function decorate(sales) {
    const itemsBySale = loadSaleItems(database, sales.map(sale => sale.id));
    const openSession = getOpenSession();
    return sales.map(sale => ({
      ...sale,
      can_void: !sale.voided && sale.session_id === openSession?.id,
      can_reprint: !sale.voided && !isSalePending(sale.id),
      items: itemsBySale.get(sale.id) || [],
    }));
  }

  function list(query) {
    const requestedLimit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw badRequest("Limite non valido");
    }
    const limit = Math.min(500, requestedLimit);
    const where = [];
    const params = [];

    if (query.cursor !== undefined && query.cursor !== "") {
      const cursor = Number(query.cursor);
      if (!Number.isSafeInteger(cursor) || cursor <= 0) {
        throw badRequest("Cursore non valido");
      }
      where.push("id < ?");
      params.push(cursor);
    }

    if (query.session !== undefined) {
      const sessionId = Number(query.session);
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw badRequest("Turno non valido");
      }
      where.push("session_id = ?");
      params.push(sessionId);
    }

    if (query.number !== undefined && query.number !== "") {
      const number = Number(query.number);
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw badRequest("Numero vendita non valido");
      }
      where.push("sale_number = ?");
      params.push(number);
    }

    if (query.from) {
      if (!parseLocalYmd(query.from)) {
        throw badRequest("Data 'from' non valida: usa YYYY-MM-DD");
      }
      where.push("created_at >= ?");
      params.push(localYmdToUtcSql(query.from));
    }
    if (query.to) {
      if (!parseLocalYmd(query.to)) {
        throw badRequest("Data 'to' non valida: usa YYYY-MM-DD");
      }
      where.push("created_at < ?");
      params.push(localYmdToUtcSql(query.to, 1));
    }

    if (query.operator) {
      const operator = cleanText(String(query.operator), 80);
      if (!operator) throw badRequest("Operatore non valido");
      where.push("operator LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikeTerm(operator)}%`);
    }

    if (query.product) {
      const product = cleanText(String(query.product), 120);
      if (!product) throw badRequest("Prodotto non valido");
      if ([...product].length < 3) {
        throw badRequest("La ricerca prodotto richiede almeno 3 caratteri");
      }
      where.push(`id IN (
        SELECT si.sale_id
        FROM sale_items_search
        JOIN sale_items si ON si.id = sale_items_search.rowid
        WHERE sale_items_search MATCH ?
      )`);
      params.push(ftsPhrase(product));
    }

    if (query.method) {
      const method = String(query.method);
      if (!paymentMethods.has(method)) throw badRequest("Metodo di pagamento non valido");
      where.push("payment_method = ?");
      params.push(method);
    }

    if (query.status) {
      const status = String(query.status);
      if (status !== "valid" && status !== "voided") {
        throw badRequest("Stato non valido: usa 'valid' o 'voided'");
      }
      where.push("voided = ?");
      params.push(status === "voided" ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = database.prepare(`
      SELECT * FROM sales ${whereSql} ORDER BY id DESC LIMIT ?
    `).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const sales = decorate(hasMore ? rows.slice(0, limit) : rows);
    return {
      sales,
      nextCursor: hasMore ? sales.at(-1).id : null,
    };
  }

  function findById(id) {
    const sale = database.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    return sale ? decorate([sale])[0] : null;
  }

  return { findById, list };
}

module.exports = { createSalesHistory, escapeLikeTerm };
