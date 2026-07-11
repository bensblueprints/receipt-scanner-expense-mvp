// Heuristic OCR text -> structured receipt fields. Pure module (no image, no
// DB, no I/O) so it's cheap to unit test. Adapted from Ledgerly's proven
// server/ocr.js heuristics, extended with tax extraction and integer-cents
// output (all money in Snapreceipt is integer cents — never floats).
//
// IMPORTANT: results from this parser only PREFILL the review form in the UI.
// Nothing is ever saved to the database until the user explicitly hits Save.
const { parse, isValid, format } = require('date-fns');

const TOTAL_KEYWORDS = /\b(TOTAL|AMOUNT\s*DUE|BALANCE(?:\s*DUE)?|GRAND\s*TOTAL)\b/i;
// "SUBTOTAL" must not count as a TOTAL line — handled by stripping it first.
const SUBTOTAL_RE = /\bSUB\s*[- ]?\s*TOTAL\b/i;
const TAX_KEYWORDS = /\b(TAX|VAT|GST|HST|PST)\b/i;
const MONEY_RE = /(?:[$€£])?\s*([\d,]+\.\d{2})/g;

const DATE_FORMATS_MDY = ['MM/dd/yyyy', 'M/d/yyyy', 'MM/dd/yy', 'M/d/yy'];
const DATE_FORMATS_DMY = ['dd/MM/yyyy', 'd/M/yyyy', 'dd/MM/yy', 'd/M/yy'];
const DATE_FORMATS_OTHER = ['yyyy-MM-dd', 'MMM d, yyyy', 'MMM. d, yyyy', 'MMMM d, yyyy'];

function toCents(amount) {
  return amount == null ? null : Math.round(amount * 100);
}

function linesOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function looksLikeDateOrNumber(line) {
  if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(line)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(line)) return true;
  if (/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/.test(line)) return true;
  if (/^[\d.,$€£\s-]+$/.test(line)) return true;
  return false;
}

// Vendor: first line that isn't just a date or a number — on real receipts
// the store name is almost always the first printed text.
function extractVendor(lines) {
  for (const line of lines) {
    if (!looksLikeDateOrNumber(line)) return line;
  }
  return '';
}

function moneyIn(line) {
  const out = [];
  let m;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(line))) out.push(parseFloat(m[1].replace(/,/g, '')));
  return out;
}

// Total: max money amount on/next to a TOTAL-keyword line (label and value are
// often split across OCR lines); fallback = largest money-shaped number anywhere.
function extractTotalCents(text) {
  const lines = linesOf(text);
  const candidates = [];

  lines.forEach((line, i) => {
    const cleaned = line.replace(SUBTOTAL_RE, '');
    if (TOTAL_KEYWORDS.test(cleaned)) {
      for (const l of [line, lines[i + 1] || '']) candidates.push(...moneyIn(l));
    }
  });
  if (candidates.length) return toCents(Math.max(...candidates));

  const all = moneyIn(String(text || '').replace(/\r?\n/g, ' '));
  return all.length ? toCents(Math.max(...all)) : null;
}

// Tax: max money amount on/next to a TAX-keyword line. No global fallback —
// guessing a tax amount from a random number would be worse than leaving it
// blank for the user to fill in.
function extractTaxCents(text) {
  const lines = linesOf(text);
  const candidates = [];
  lines.forEach((line, i) => {
    if (TAX_KEYWORDS.test(line) && !TOTAL_KEYWORDS.test(line.replace(SUBTOTAL_RE, ''))) {
      const sameLine = moneyIn(line);
      if (sameLine.length) {
        candidates.push(...sameLine);
      } else {
        // label/value split across OCR lines — but never steal the TOTAL line's amount
        const next = lines[i + 1] || '';
        if (!TOTAL_KEYWORDS.test(next.replace(SUBTOTAL_RE, ''))) candidates.push(...moneyIn(next));
      }
    }
  });
  return candidates.length ? toCents(Math.max(...candidates)) : null;
}

function tryFormats(str, formats) {
  for (const fmt of formats) {
    const d = parse(str, fmt, new Date());
    if (isValid(d) && d.getFullYear() > 1990 && d.getFullYear() < 2100) return d;
  }
  return null;
}

function extractDate(text, datePref = 'MDY') {
  const lines = linesOf(text);
  const slashRe = /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/;
  const isoRe = /\b(\d{4}-\d{2}-\d{2})\b/;
  const monthRe = /\b([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/;

  const primaryFormats = datePref === 'DMY' ? DATE_FORMATS_DMY : DATE_FORMATS_MDY;

  for (const line of lines) {
    let m = line.match(isoRe);
    if (m) {
      const d = tryFormats(m[1], DATE_FORMATS_OTHER);
      if (d) return format(d, 'yyyy-MM-dd');
    }
    m = line.match(monthRe);
    if (m) {
      const normalized = m[1].replace(/\.(?=\s)/, '');
      const d = tryFormats(normalized, DATE_FORMATS_OTHER);
      if (d) return format(d, 'yyyy-MM-dd');
    }
    m = line.match(slashRe);
    if (m) {
      const raw = m[1].replace(/-/g, '/');
      const d = tryFormats(raw, primaryFormats) || tryFormats(raw, datePref === 'DMY' ? DATE_FORMATS_MDY : DATE_FORMATS_DMY);
      if (d) return format(d, 'yyyy-MM-dd');
    }
  }
  return null;
}

// The one entry point the app uses: raw OCR text in, prefill suggestion out.
// All money fields are integer cents (or null when nothing was found).
function extractFields(text, opts = {}) {
  const lines = linesOf(text);
  return {
    vendor: extractVendor(lines),
    date: extractDate(text, opts.datePref || 'MDY'),
    total_cents: extractTotalCents(text),
    tax_cents: extractTaxCents(text)
  };
}

module.exports = { extractFields, extractVendor, extractDate, extractTotalCents, extractTaxCents, toCents };
