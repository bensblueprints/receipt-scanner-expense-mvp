// Local SQLite storage (better-sqlite3). Schema is idempotent — safe to open
// the same file across versions. All money columns are INTEGER CENTS.
//
// Dual-ABI note: `npm test` runs under Node, `npm start` under Electron.
// scripts/setup-native.js vendors a binding for each runtime; we pick the
// right one here via the `nativeBinding` option (falls back to the default
// binding when the vendored file is missing, e.g. right after a fresh clone).
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_CATEGORIES = [
  'Meals', 'Travel', 'Fuel', 'Office Supplies', 'Software',
  'Hardware', 'Lodging', 'Parking', 'Utilities', 'Marketing', 'Other'
];

function bindingPath() {
  const vendor = path.join(__dirname, '..', 'vendor');
  const file = process.versions.electron
    ? path.join(vendor, 'better_sqlite3-electron.node')
    : path.join(vendor, 'better_sqlite3-node.node');
  return fs.existsSync(file) ? file : undefined;
}

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'snapreceipt.db'), { nativeBinding: bindingPath() });
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_path TEXT,
      vendor TEXT NOT NULL DEFAULT '',
      date TEXT,
      total_cents INTEGER NOT NULL DEFAULT 0,
      tax_cents INTEGER,
      category TEXT NOT NULL DEFAULT 'Other',
      project_tag TEXT NOT NULL DEFAULT '',
      ocr_raw_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mileage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      miles REAL NOT NULL DEFAULT 0,
      rate_cents_per_mile INTEGER NOT NULL DEFAULT 67,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
    CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category);
  `);

  const seedCat = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)');
  for (const c of DEFAULT_CATEGORIES) seedCat.run(c);

  return wrap(db);
}

function asInt(v, name) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be integer cents, got: ${v}`);
  return n;
}

// Mileage reimbursement in cents. Spec rule: Math.round(miles * rate_cents).
function mileageAmountCents(miles, rateCentsPerMile) {
  return Math.round(Number(miles) * Number(rateCentsPerMile));
}

function wrap(db) {
  return {
    raw: db,

    // ---- receipts (a row is ONLY created here, via an explicit user Save) ----
    saveReceipt(r) {
      const total = asInt(r.total_cents, 'total_cents');
      const tax = asInt(r.tax_cents, 'tax_cents');
      const info = db
        .prepare(
          `INSERT INTO receipts (image_path, vendor, date, total_cents, tax_cents, category, project_tag, ocr_raw_text)
           VALUES (@image_path, @vendor, @date, @total_cents, @tax_cents, @category, @project_tag, @ocr_raw_text)`
        )
        .run({
          image_path: r.image_path || null,
          vendor: r.vendor || '',
          date: r.date || null,
          total_cents: total == null ? 0 : total,
          tax_cents: tax,
          category: r.category || 'Other',
          project_tag: r.project_tag || '',
          ocr_raw_text: r.ocr_raw_text || ''
        });
      return this.getReceipt(info.lastInsertRowid);
    },
    getReceipt(id) {
      return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    },
    listReceipts(filters = {}) {
      const where = [];
      const args = {};
      if (filters.category) { where.push('category = @category'); args.category = filters.category; }
      if (filters.project_tag) { where.push('project_tag = @project_tag'); args.project_tag = filters.project_tag; }
      if (filters.from) { where.push('date >= @from'); args.from = filters.from; }
      if (filters.to) { where.push('date <= @to'); args.to = filters.to; }
      if (filters.month) { where.push("substr(date, 1, 7) = @month"); args.month = filters.month; }
      const sql = `SELECT * FROM receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC`;
      return db.prepare(sql).all(args);
    },
    updateReceipt(id, patch) {
      const cur = this.getReceipt(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare(
        `UPDATE receipts SET image_path=@image_path, vendor=@vendor, date=@date, total_cents=@total_cents,
         tax_cents=@tax_cents, category=@category, project_tag=@project_tag, ocr_raw_text=@ocr_raw_text WHERE id=@id`
      ).run({
        id,
        image_path: next.image_path || null,
        vendor: next.vendor || '',
        date: next.date || null,
        total_cents: asInt(next.total_cents, 'total_cents') ?? 0,
        tax_cents: asInt(next.tax_cents, 'tax_cents'),
        category: next.category || 'Other',
        project_tag: next.project_tag || '',
        ocr_raw_text: next.ocr_raw_text || ''
      });
      return this.getReceipt(id);
    },
    deleteReceipt(id) {
      return db.prepare('DELETE FROM receipts WHERE id = ?').run(id).changes > 0;
    },
    countReceipts() {
      return db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
    },

    // ---- reports (pure SQL aggregation, integer cents throughout) ----
    reportByCategory(filters = {}) {
      const where = [];
      const args = {};
      if (filters.month) { where.push("substr(date,1,7) = @month"); args.month = filters.month; }
      if (filters.from) { where.push('date >= @from'); args.from = filters.from; }
      if (filters.to) { where.push('date <= @to'); args.to = filters.to; }
      return db
        .prepare(
          `SELECT category, COUNT(*) AS count, SUM(total_cents) AS total_cents, SUM(COALESCE(tax_cents,0)) AS tax_cents
           FROM receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           GROUP BY category ORDER BY total_cents DESC`
        )
        .all(args);
    },
    reportByMonth() {
      return db
        .prepare(
          `SELECT substr(date,1,7) AS month, COUNT(*) AS count, SUM(total_cents) AS total_cents
           FROM receipts WHERE date IS NOT NULL GROUP BY month ORDER BY month DESC`
        )
        .all();
    },

    // ---- mileage ----
    saveMileage(m) {
      const rate = asInt(m.rate_cents_per_mile, 'rate_cents_per_mile') ?? 67;
      const info = db
        .prepare('INSERT INTO mileage_entries (date, purpose, miles, rate_cents_per_mile) VALUES (?, ?, ?, ?)')
        .run(m.date, m.purpose || '', Number(m.miles) || 0, rate);
      return this.getMileage(info.lastInsertRowid);
    },
    getMileage(id) {
      const row = db.prepare('SELECT * FROM mileage_entries WHERE id = ?').get(id);
      if (row) row.amount_cents = mileageAmountCents(row.miles, row.rate_cents_per_mile);
      return row;
    },
    listMileage() {
      return db.prepare('SELECT * FROM mileage_entries ORDER BY date DESC, id DESC').all()
        .map((row) => ({ ...row, amount_cents: mileageAmountCents(row.miles, row.rate_cents_per_mile) }));
    },
    deleteMileage(id) {
      return db.prepare('DELETE FROM mileage_entries WHERE id = ?').run(id).changes > 0;
    },

    // ---- categories ----
    listCategories() {
      return db.prepare('SELECT name FROM categories ORDER BY name').all().map((r) => r.name);
    },
    addCategory(name) {
      if (name && name.trim()) db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)').run(name.trim());
      return this.listCategories();
    },

    // ---- settings ----
    getSetting(key, fallback = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : fallback;
    },
    setSetting(key, value) {
      db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value == null ? null : String(value));
    },

    close() {
      db.close();
    }
  };
}

module.exports = { openDb, mileageAmountCents, DEFAULT_CATEGORIES };
