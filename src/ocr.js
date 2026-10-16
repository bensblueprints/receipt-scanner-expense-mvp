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
const os = require('os');
const crypto = require('crypto');
const PImage = require('pureimage');
const { createWorker } = require('tesseract.js');

const ASSETS_DIR = path.join(__dirname, '..', 'ocr-assets');
const LANG_FILE = path.join(ASSETS_DIR, 'eng.traineddata.gz');

function ocrAvailable() {
  return fs.existsSync(LANG_FILE) && fs.statSync(LANG_FILE).size > 1024 * 1024;
}

// Preprocess photos for tesseract: phone pics of receipts are small, skewed
// and low-contrast. We produce TWO enhanced variants — (a) upscaled +
// grayscale + contrast-stretched, (b) the same but binarized to pure b/w —
// and run OCR on both plus the original, keeping whichever pass reports the
// highest confidence. Falls back to just the original for formats pureimage
// can't decode (tiff/bmp/webp — tesseract reads those itself).
function luminance(d, i) {
  return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
}

async function writePng(bitmap, suffix) {
  const tmp = path.join(os.tmpdir(), `snapreceipt-ocr-${suffix}-${crypto.randomBytes(6).toString('hex')}.png`);
  await PImage.encodePNGToStream(bitmap, fs.createWriteStream(tmp));
  return tmp;
}

async function preprocessVariants(imagePath) {
  let img;
  try {
    const lower = imagePath.toLowerCase();
    const stream = fs.createReadStream(imagePath);
    img = /\.jpe?g$/.test(lower)
      ? await PImage.decodeJPEGFromStream(stream)
      : await PImage.decodePNGFromStream(stream);
  } catch {
    return { files: [imagePath], temps: [] };
  }
  const scale = Math.min(5, Math.max(1, 2000 / img.width));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const stretched = PImage.make(w, h);
  stretched.getContext('2d').drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
  const d = stretched.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = luminance(d, i);
    if (l < min) min = l;
    if (l > max) max = l;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.max(0, Math.min(255, ((luminance(d, i) - min) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = g;
  }

  const binary = PImage.make(w, h);
  binary.getContext('2d').drawImage(stretched, 0, 0);
  const b = binary.data;
  for (let i = 0; i < b.length; i += 4) {
    const g = luminance(b, i) > 140 ? 255 : 0;
    b[i] = b[i + 1] = b[i + 2] = g;
  }

  const contrastPath = await writePng(stretched, 'contrast');
  const binaryPath = await writePng(binary, 'bin');
  return { files: [contrastPath, binaryPath, imagePath], temps: [contrastPath, binaryPath] };
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
  const { files, temps } = await preprocessVariants(imagePath);
  const worker = await getWorker();
  try {
    const passes = [];
    for (const f of files) {
      const { data } = await worker.recognize(f);
      passes.push({ text: data.text || '', confidence: data.confidence ?? 0 });
    }
    return passes;
  } finally {
    for (const t of temps) fs.rmSync(t, { force: true });
  }
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
