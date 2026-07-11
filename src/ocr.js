// Local OCR via tesseract.js, running in the Node side (Electron main process
// or plain Node for tests). Every asset path is resolved from DISK:
//   - language data: ./ocr-assets/eng.traineddata.gz (downloaded ONCE by
//     scripts/fetch-ocr-data.js at install time — the app's only network call)
//   - worker + wasm core: node_modules on disk
//   - cache: ./ocr-assets
// NOTHING is ever loaded from a CDN at runtime. If the language file is
// missing, ocrAvailable() is false and the UI says so instead of phoning home.
//
// OCR output only PREFILLS the review form (via src/parse.js). No DB writes
// happen here or anywhere downstream until the user explicitly saves.
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');

const ASSETS_DIR = path.join(__dirname, '..', 'ocr-assets');
const LANG_FILE = path.join(ASSETS_DIR, 'eng.traineddata.gz');

function ocrAvailable() {
  return fs.existsSync(LANG_FILE) && fs.statSync(LANG_FILE).size > 1024 * 1024;
}

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    // corePath: point tesseract.js at the wasm core on disk so it can never
    // fall back to its CDN default.
    const corePath = path.dirname(require.resolve('tesseract.js-core/package.json'));
    workerPromise = createWorker('eng', 1, {
      langPath: ASSETS_DIR,
      cachePath: ASSETS_DIR,
      corePath,
      gzip: true
    });
  }
  return workerPromise;
}

// Recognize an image file (path) -> raw text. Fully local.
async function recognize(imagePath) {
  if (!ocrAvailable()) {
    throw new Error('OCR language data missing — run: node scripts/fetch-ocr-data.js');
  }
  const worker = await getWorker();
  const { data } = await worker.recognize(imagePath);
  return data.text || '';
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { recognize, terminate, ocrAvailable, ASSETS_DIR };
