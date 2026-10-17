// Snapreceipt — Electron main process.
// Everything runs locally: SQLite in userData, OCR via tesseract.js with
// on-disk assets (see src/ocr.js). No telemetry, no network calls.
//
// SAVE SEMANTICS (deliberate): importing/scanning a receipt only runs OCR and
// returns a PREFILL to the renderer's review form. A `receipts` row is created
// exclusively by the explicit `receipts:save` IPC, i.e. the user's Save click.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDb } = require('./src/db');
const parse = require('./src/parse');
const ocr = require('./src/ocr');
const sharp = require('sharp');
const { receiptWarnings } = require('./src/checks');
const { receiptsCsv, mileageCsv } = require('./src/csv');
const { buildExpenseReportPdf } = require('./src/pdf-report');

// Prompt for the OPTIONAL cloud OCR (OpenAI vision). Used only when the user
// has set an API key AND clicks the cloud button — the image leaves the
// machine only in that explicit case.
const CLOUD_OCR_PROMPT = `Read this receipt or invoice image — including any HANDWRITTEN text.
Return ONLY a JSON object:
{
  "vendor": string,          // merchant/business name
  "date": string|null,       // transaction date, YYYY-MM-DD
  "total": number|null,      // final amount paid, dollars
  "tax": number|null,
  "subtotal": number|null,
  "bank_name": string,       // card brand / bank / "CASH" / "" when unknown
  "items": [{ "description": string, "amount": number }]
}
Use null for anything unreadable. Items only when a price is known.`;

function normalizeCloudFields(c) {
  const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
  const fields = {
    vendor: typeof c.vendor === 'string' ? c.vendor : '',
    bank_name: typeof c.bank_name === 'string' ? c.bank_name : '',
    date: typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null,
    total_cents: cents(c.total),
    tax_cents: cents(c.tax),
    subtotal_cents: cents(c.subtotal),
    items: Array.isArray(c.items)
      ? c.items
          .map((it) => ({ description: String((it && it.description) || '').trim(), amount_cents: cents(it && it.amount) }))
          .filter((it) => it.description || it.amount_cents != null)
      : []
  };
  fields.merchant_name = fields.vendor;
  return fields;
}

let db;
let win;
let watcher = null;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif', '.heic', '.heif']);

function receiptsDir() {
  const dir = path.join(app.getPath('userData'), 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Copy an imported image into the app data dir (originals stay untouched).
function storeImage(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const dest = path.join(receiptsDir(), name);
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

// OCR (multi-pass) + heuristic parse with per-field voting -> prefill only.
// NEVER writes to the DB.
async function extractPrefill(storedPath) {
  let passes = [];
  let ocrError = null;
  if (ocr.ocrAvailable()) {
    try {
      passes = await ocr.recognizeAll(storedPath);
    } catch (e) {
      ocrError = e.message;
    }
  } else {
    ocrError = 'OCR language data not downloaded yet (run: node scripts/fetch-ocr-data.js)';
  }
  passes.sort((a, b) => b.confidence - a.confidence);
  const rawText = passes.length ? passes[0].text : '';
  const datePref = db.getSetting('date_pref', 'MDY');
  const parsed = passes.map((p) => parse.extractFields(p.text, { datePref }));
  const fields = parsed.length ? parse.voteFields(parsed) : parse.extractFields('', { datePref });

  // Uncertainty flags for the review form:
  //  - disagreement: the OCR passes extracted DIFFERENT values for a field
  //    (one pass read 6.11, another 6.41) -> user must eyeball that field
  //  - lowQuality: even the best pass is unconfident -> the photo itself is
  //    the problem; suggest a sharper, higher-res retake
  const flags = { fields: [], lowQuality: false, bestConfidence: passes.length ? Math.round(passes[0].confidence) : 0 };
  for (const key of ['total_cents', 'subtotal_cents', 'tax_cents', 'date', 'vendor', 'bank_name']) {
    const distinct = new Set(parsed.map((p) => p[key]).filter((v) => v != null && v !== ''));
    if (distinct.size > 1) flags.fields.push(key);
  }
  if (passes.length && passes[0].confidence < 50) flags.lowQuality = true;

  return { image_path: storedPath, ocr_raw_text: rawText, fields, flags, ocrError };
}

function startWatcher() {
  stopWatcher();
  const dir = db.getSetting('watch_folder');
  if (!dir || !fs.existsSync(dir)) return;
  try {
    watcher = fs.watch(dir, (event, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return;
      const full = path.join(dir, filename);
      // debounce: file may still be mid-copy from a phone-sync tool
      setTimeout(async () => {
        if (!fs.existsSync(full) || !win || win.isDestroyed()) return;
        try {
          const stored = storeImage(full);
          const prefill = await extractPrefill(stored);
          // Renderer shows this in the review inbox — user still has to Save.
          win.webContents.send('watch:new-receipt', prefill);
        } catch {}
      }, 1500);
    });
  } catch {}
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function registerIpc() {
  // ---- import & OCR (prefill only) ----
  ipcMain.handle('receipts:import', async (_e, sourcePath) => {
    const stored = storeImage(sourcePath);
    return extractPrefill(stored);
  });
  ipcMain.handle('receipts:import-bytes', async (_e, { name, bytes }) => {
    const ext = path.extname(name || '').toLowerCase() || '.png';
    const dest = path.join(receiptsDir(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${IMAGE_EXTS.has(ext) ? ext : '.png'}`);
    fs.writeFileSync(dest, Buffer.from(bytes));
    return extractPrefill(dest);
  });
  ipcMain.handle('receipts:discard-import', (_e, imagePath) => {
    // user cancelled the review form before saving — remove the copied image
    if (imagePath && imagePath.startsWith(receiptsDir())) fs.rmSync(imagePath, { force: true });
    return true;
  });

  // ---- receipts CRUD (save = the ONLY way a row is created) ----
  ipcMain.handle('receipts:save', (_e, data) => db.saveReceipt(data));
  ipcMain.handle('receipts:list', (_e, filters) => {
    const rows = db.listReceipts(filters || {});
    return rows.map((r) => ({ ...r, warnings: receiptWarnings(r, db.getItems(r.id)) }));
  });
  ipcMain.handle('receipts:get-items', (_e, id) => db.getItems(id));
  ipcMain.handle('receipts:update', (_e, { id, patch }) => db.updateReceipt(id, patch));
  ipcMain.handle('receipts:delete', (_e, id) => {
    const row = db.getReceipt(id);
    if (row && row.image_path && row.image_path.startsWith(receiptsDir())) fs.rmSync(row.image_path, { force: true });
    return db.deleteReceipt(id);
  });
  ipcMain.handle('receipts:image-data-url', (_e, imagePath) => {
    try {
      if (!imagePath || !imagePath.startsWith(receiptsDir())) return null;
      const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
    } catch {
      return null;
    }
  });

  // ---- categories / settings ----
  ipcMain.handle('categories:list', () => db.listCategories());
  ipcMain.handle('categories:add', (_e, name) => db.addCategory(name));
  ipcMain.handle('settings:get', (_e, key) => db.getSetting(key));
  ipcMain.handle('settings:set', (_e, { key, value }) => {
    db.setSetting(key, value);
    if (key === 'watch_folder') startWatcher();
    return true;
  });

  // ---- mileage ----
  ipcMain.handle('mileage:save', (_e, m) => db.saveMileage(m));
  ipcMain.handle('mileage:list', () => db.listMileage());
  ipcMain.handle('mileage:delete', (_e, id) => db.deleteMileage(id));

  // ---- reports & exports ----
  ipcMain.handle('reports:summary', (_e, filters) => ({
    byCategory: db.reportByCategory(filters || {}),
    byMonth: db.reportByMonth()
  }));
  ipcMain.handle('export:csv', async (_e, filters) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapreceipt-expenses-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return null;
    const rows = db.listReceipts(filters || {})
      .map((r) => ({ ...r, warnings: receiptWarnings(r, db.getItems(r.id)) }));
    fs.writeFileSync(filePath, receiptsCsv(rows));
    shell.showItemInFolder(filePath);
    return filePath;
  });
  ipcMain.handle('export:mileage-csv', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapreceipt-mileage-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, mileageCsv(db.listMileage()));
    shell.showItemInFolder(filePath);
    return filePath;
  });
  ipcMain.handle('export:pdf', async (_e, filters) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `snapreceipt-report-${new Date().toISOString().slice(0, 10)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return null;
    const receipts = db.listReceipts(filters || {})
      .map((r) => ({ ...r, warnings: receiptWarnings(r, db.getItems(r.id)) }));
    const bytes = await buildExpenseReportPdf({
      title: filters && filters.month ? `Expense Report — ${filters.month}` : 'Expense Report',
      receipts,
      mileage: db.listMileage(),
      byCategory: db.reportByCategory(filters || {}),
      byMonth: db.reportByMonth()
    });
    fs.writeFileSync(filePath, bytes);
    shell.showItemInFolder(filePath);
    return filePath;
  });

  // ---- pickers / misc ----
  ipcMain.handle('dialog:pick-images', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif'] }]
    });
    return canceled ? [] : filePaths;
  });
  ipcMain.handle('dialog:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
  });
  ipcMain.handle('app:ocr-available', () => ocr.ocrAvailable());

  // ---- OPTIONAL cloud OCR (OpenAI vision) — only fires when the user has
  // set their own API key AND explicitly clicks the button in the UI ----
  ipcMain.handle('ocr:cloud', async (_e, imagePath) => {
    const apiKey = db.getSetting('openai_api_key');
    if (!apiKey) return { error: 'No API key — add your OpenAI key in Settings → Cloud OCR first.' };
    try {
      const jpeg = await sharp(imagePath)
        .rotate()
        .resize({ width: 1500, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: db.getSetting('openai_model', 'gpt-4o-mini') || 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: CLOUD_OCR_PROMPT },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }
            ]
          }]
        })
      });
      if (!res.ok) return { error: `OpenAI error ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const json = await res.json();
      const content = JSON.parse(json.choices[0].message.content);
      return { fields: normalizeCloudFields(content) };
    } catch (e) {
      return { error: `Cloud OCR failed: ${e.message}` };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  db = openDb(app.getPath('userData'));
  registerIpc();
  createWindow();
  startWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopWatcher();
  ocr.terminate().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
