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
const { receiptsCsv, mileageCsv } = require('./src/csv');
const { buildExpenseReportPdf } = require('./src/pdf-report');

let db;
let win;
let watcher = null;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

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

// OCR + heuristic parse -> prefill only. NEVER writes to the DB.
async function extractPrefill(storedPath) {
  let rawText = '';
  let ocrError = null;
  if (ocr.ocrAvailable()) {
    try {
      rawText = await ocr.recognize(storedPath);
    } catch (e) {
      ocrError = e.message;
    }
  } else {
    ocrError = 'OCR language data not downloaded yet (run: node scripts/fetch-ocr-data.js)';
  }
  const datePref = db.getSetting('date_pref', 'MDY');
  const fields = parse.extractFields(rawText, { datePref });
  return { image_path: storedPath, ocr_raw_text: rawText, fields, ocrError };
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
  ipcMain.handle('receipts:list', (_e, filters) => db.listReceipts(filters || {}));
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
    fs.writeFileSync(filePath, receiptsCsv(db.listReceipts(filters || {})));
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
    const receipts = db.listReceipts(filters || {});
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
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'] }]
    });
    return canceled ? [] : filePaths;
  });
  ipcMain.handle('dialog:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
  });
  ipcMain.handle('app:ocr-available', () => ocr.ocrAvailable());
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

app.whenReady().then(() => {
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
