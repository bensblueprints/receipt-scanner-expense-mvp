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
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const ASSETS_DIR = path.join(__dirname, '..', 'ocr-assets');
const LANG_FILE = path.join(ASSETS_DIR, 'eng.traineddata.gz');

function ocrAvailable() {
  return fs.existsSync(LANG_FILE) && fs.statSync(LANG_FILE).size > 1024 * 1024;
}

// HEIC/HEIF (iPhone photos) isn't in sharp's prebuilt libvips (patent) —
// decode those with heic-convert (pure JS) and hand sharp the PNG.
function isHeif(buf) {
  return (
    buf.length > 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(buf.toString('ascii', 8, 12)) &&
    !/^(avif|avis)$/.test(buf.toString('ascii', 8, 12)) // avif IS handled by sharp
  );
}

// Open any realistic phone/image format as a sharp pipeline with EXIF
// auto-orientation applied (phone pics are frequently stored rotated).
// sharp sniffs the real format from content — the extension is irrelevant,
// so "receipt.jpeg" that is secretly AVIF still works.
async function openImage(imagePath) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(imagePath, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (isHeif(head)) {
    const convert = require('heic-convert');
    const png = await convert({ buffer: fs.readFileSync(imagePath), format: 'PNG' });
    return sharp(Buffer.from(png)).rotate();
  }
  return sharp(imagePath).rotate();
}

// Preprocess for tesseract: resize small photos up, grayscale, contrast
// stretch — plus a pure b/w variant. OCR runs on BOTH variants (and the
// original when tesseract can read it), highest confidence wins.
async function preprocessVariants(imagePath) {
  let base;
  try {
    base = await openImage(imagePath);
    await base.metadata(); // force decode now so we can fall back cleanly
  } catch {
    return { variants: [imagePath] }; // last resort: tesseract tries the file itself
  }
  const meta = await base.metadata();
  const width = Math.min(Math.max(meta.width || 1200, 1200), 2400);
  const normalized = base.resize({ width });
  const contrast = await normalized.clone().grayscale().normalize().png().toBuffer();
  const binary = await normalized.clone().grayscale().normalize().threshold(140).png().toBuffer();
  const variants = [contrast, binary];
  // Include the untouched original as a third pass only when tesseract
  // (leptonica) can actually read the DETECTED format — a ".jpeg" file that
  // is secretly AVIF would crash it.
  const leptonicaFormats = new Set(['jpeg', 'png', 'tiff', 'bmp', 'gif', 'webp']);
  if (leptonicaFormats.has(meta.format)) variants.push(imagePath);
  return { variants };
}

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    // corePath: point tesseract.js at the wasm core on disk so it can never
    // fall back to its CDN default.
    const corePath = path.dirname(require.resolve('tesseract.js-core/package.json'));
    workerPromise = (async () => {
      const worker = await createWorker('eng', 1, {
        langPath: ASSETS_DIR,
        cachePath: ASSETS_DIR,
        corePath,
        gzip: true
      });
      // Receipts are a single column of text — PSM 4 reads them measurably
      // better than the fully-automatic default (verified on POS photos).
      await worker.setParameters({ tessedit_pageseg_mode: '4' });
      return worker;
    })();
  }
  return workerPromise;
}

// Recognize an image file (path) -> one result per OCR pass
// [{text, confidence}], unsorted. Fully local.
async function recognizeAll(imagePath) {
  if (!ocrAvailable()) {
    throw new Error('OCR language data missing — run: node scripts/fetch-ocr-data.js');
  }
  const { variants } = await preprocessVariants(imagePath);
  const worker = await getWorker();
  const passes = [];
  for (const v of variants) {
    try {
      const { data } = await worker.recognize(v);
      passes.push({ text: data.text || '', confidence: data.confidence ?? 0 });
    } catch {
      // one unreadable variant must not sink the whole scan
    }
  }
  if (!passes.length) throw new Error('OCR could not read this image (unsupported or corrupt file)');
  return passes;
}

// Single-text convenience wrapper: highest-confidence pass wins.
async function recognize(imagePath) {
  const passes = await recognizeAll(imagePath);
  passes.sort((a, b) => b.confidence - a.confidence);
  return passes.length ? passes[0].text : '';
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { recognize, recognizeAll, terminate, ocrAvailable, ASSETS_DIR };
