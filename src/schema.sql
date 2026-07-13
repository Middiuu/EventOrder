PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(typeof(price_cents) = 'integer' AND price_cents >= 0),
  category TEXT NOT NULL DEFAULT 'Generale',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(typeof(sort_order) = 'integer'),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Turni di cassa (sessioni): fondo iniziale e chiusura con conteggio contanti
CREATE TABLE IF NOT EXISTS cash_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(opening_float_cents) = 'integer' AND opening_float_cents >= 0),
  counted_cash_cents INTEGER CHECK(counted_cash_cents IS NULL OR (typeof(counted_cash_cents) = 'integer' AND counted_cash_cents >= 0)),
  expected_cash_cents INTEGER CHECK(expected_cash_cents IS NULL OR (typeof(expected_cash_cents) = 'integer' AND expected_cash_cents >= 0)),
  difference_cents INTEGER CHECK(difference_cents IS NULL OR typeof(difference_cents) = 'integer'),
  operator TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number INTEGER NOT NULL,
  total_cents INTEGER NOT NULL CHECK(typeof(total_cents) = 'integer' AND total_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(discount_cents) = 'integer' AND discount_cents >= 0),
  discount_type TEXT,
  discount_value REAL,
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash', 'card', 'other')),
  cash_received_cents INTEGER CHECK(cash_received_cents IS NULL OR (typeof(cash_received_cents) = 'integer' AND cash_received_cents >= 0)),
  change_cents INTEGER CHECK(change_cents IS NULL OR (typeof(change_cents) = 'integer' AND change_cents >= 0)),
  operator TEXT,
  session_id INTEGER,
  void_reason TEXT,
  voided_at TEXT,
  void_operator TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided INTEGER NOT NULL DEFAULT 0 CHECK(voided IN (0, 1)),
  FOREIGN KEY (session_id) REFERENCES cash_sessions(id)
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  int_value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK(typeof(qty) = 'integer' AND qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK(typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK(typeof(line_total_cents) = 'integer' AND line_total_cents >= 0),
  product_name TEXT NOT NULL DEFAULT '',
  product_category TEXT NOT NULL DEFAULT 'Generale',
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_session ON sales(session_id);
CREATE INDEX IF NOT EXISTS idx_sales_voided ON sales(voided, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_sale_number ON sales(sale_number);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_sessions_single_open
ON cash_sessions((1)) WHERE closed_at IS NULL;

-- Unicità nome prodotto (case-insensitive + trim)
CREATE UNIQUE INDEX IF NOT EXISTS ux_products_name_ci
ON products (lower(trim(name)));
