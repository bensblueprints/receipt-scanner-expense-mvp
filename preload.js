// Preload — the only bridge between renderer and main. contextIsolation is ON;
// the renderer gets this narrow, promise-based API and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snap', {
  // import & OCR — returns a PREFILL for the review form; nothing is saved yet
  importReceipt: (sourcePath) => ipcRenderer.invoke('receipts:import', sourcePath),
  importReceiptBytes: (name, bytes) => ipcRenderer.invoke('receipts:import-bytes', { name, bytes }),
  discardImport: (imagePath) => ipcRenderer.invoke('receipts:discard-import', imagePath),

  // explicit save — the ONLY call that creates a receipt row
  saveReceipt: (data) => ipcRenderer.invoke('receipts:save', data),
  listReceipts: (filters) => ipcRenderer.invoke('receipts:list', filters),
  updateReceipt: (id, patch) => ipcRenderer.invoke('receipts:update', { id, patch }),
  deleteReceipt: (id) => ipcRenderer.invoke('receipts:delete', id),
  imageDataUrl: (imagePath) => ipcRenderer.invoke('receipts:image-data-url', imagePath),

  listCategories: () => ipcRenderer.invoke('categories:list'),
  addCategory: (name) => ipcRenderer.invoke('categories:add', name),
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),

  saveMileage: (m) => ipcRenderer.invoke('mileage:save', m),
  listMileage: () => ipcRenderer.invoke('mileage:list'),
  deleteMileage: (id) => ipcRenderer.invoke('mileage:delete', id),

  reportSummary: (filters) => ipcRenderer.invoke('reports:summary', filters),
  exportCsv: (filters) => ipcRenderer.invoke('export:csv', filters),
  exportMileageCsv: () => ipcRenderer.invoke('export:mileage-csv'),
  exportPdf: (filters) => ipcRenderer.invoke('export:pdf', filters),

  pickImages: () => ipcRenderer.invoke('dialog:pick-images'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  ocrAvailable: () => ipcRenderer.invoke('app:ocr-available'),

  onWatchedReceipt: (cb) => {
    const listener = (_e, prefill) => cb(prefill);
    ipcRenderer.on('watch:new-receipt', listener);
    return () => ipcRenderer.removeListener('watch:new-receipt', listener);
  }
});
