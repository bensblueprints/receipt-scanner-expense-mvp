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
const SUBTOTAL_RE = /SUB\s*[- ]?\s*TOTAL/i;
const TAX_KEYWORDS = /\b(TAX|VAT|GST|HST|PST|TAK|TAM)\b/i; // TAK/TAM: common tesseract misreads of TAX on thermal paper
const MONEY_RE = /(?:[$€£])?\s*([\d,]+\.\d{2})/g;
// Lines that carry money but are never merchandise: payment/tender/card
// trailers. Item collection also stops outright at the first TOTAL line.
const NON_ITEM_KEYWORDS = /\b(CASH|CHANGE|TENDER|PAYMENT|VISA|MASTERCARD|AMEX|DISCOVER|DEBIT|CREDIT|CARD|AUTH(?:ORIZATION)?|APPROVAL|REF\s|TIP|GRATUITY)\b/i;

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

// Vendor: first plausible business-name line. Receipts bury the name under
// addresses, phone numbers, URLs, dates and "welcome" boilerplate — skip all
// of those before accepting a line.
const ADDRESS_RE = /^\d{1,6}([.\s]|$)/; // "123 Main St", "3450.5 CALIFORNIA AVE" — starts with a number
const PHONE_RE = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
const URL_OR_EMAIL_RE = /(www\.|https?:|\.com\b|\.net\b|\.org\b|@)/i;
const NON_VENDOR_WORDS = /\b(receipt|invoice|order\s*#|ticket|guest|server|cashier|welcome|thank\s*you|tel|phone|fax|date|time|copy|merchant|transaction|terminal|device|authorization|batch|response|approved|sequence|retrieval|issuer|customer|duplicate|total|subtotal|tax|sale|payment|change|shift|trans|status|fuel|agreement|voucher|signature)\b/i;

function looksLikeNonVendor(line) {
  if (looksLikeDateOrNumber(line)) return true;
  if (URL_OR_EMAIL_RE.test(line)) return true;
  if (PHONE_RE.test(line)) return true;
  if (ADDRESS_RE.test(line)) return true;
  if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(line)) return true; // "CHICAGO, IL 60608"
  if (NON_VENDOR_WORDS.test(line)) return true;
  if (moneyIn(line).length) return true; // priced line (item/total), not a name
  if (!/[A-Za-z]{2,}/.test(line)) return true; // a name needs letters
  return false;
}

// POS slips often label the merchant explicitly ("MERCHANT: COFFEE HOUSE").
// Trust that label before any heuristic — but only when MERCHANT starts the
// line (footer text like "...(merchant agreement)" is NOT a label), and never
// accept boilerplate values like COPY / ID / NUMBER.
const MERCHANT_LABEL_RE = /^[^A-Za-z]{0,4}MERCHANT(?:\s+NAME)?\b\s*[:#\-–—]?\s*(.+)/i;

function extractMerchantName(lines) {
  for (const line of lines) {
    if (/MERCHANT\s*(ID|NUMBER|#|REF|COPY|AGREEMENT)/i.test(line)) continue;
    const m = line.match(MERCHANT_LABEL_RE);
    if (!m) continue;
    const value = m[1].trim();
    if (value.length < 3 || moneyIn(value).length) continue;
    if (/^(COPY|GOPI?|ID|NUM(BER)?|REF|AGREEMENT|SIGNATURE)\W*$/i.test(value)) continue; // OCR of "MERCHANT COPY" etc.
    return value;
  }
  return null;
}

// OCR garbles the repeated asterisk borders above/below receipts into long
// strings of X/K/R junk, and headers into noise. Score vendor candidates so a
// clean all-caps business name beats OCR garbage, instead of first-line-wins.
function vendorScore(line) {
  const letters = line.match(/[A-Za-z]/g) || [];
  if (!letters.length) return -Infinity;
  let s = 0;
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  if (upper / letters.length > 0.8) s += 2;
  if (/#\s*\d|\b(LLC|INC|LTD|CO|STORE|SHOP|CAFE|MARKET|MART|GAS)\b/i.test(line)) s += 1;
  if (/[?|~{}[\]<>\\^]/.test(line)) s -= 2;
  const freq = {};
  for (const c of letters) freq[c] = (freq[c] || 0) + 1;
  if (Math.max(...Object.values(freq)) / letters.length > 0.35) s -= 2; // border junk
  if (Object.keys(freq).length / letters.length < 0.25) s -= 2; // repetitive OCR garbage ("ARRARAPUNE...")
  return s;
}

// Merchant names live at the TOP of a receipt — only score candidates from
// the first 40% of lines so footer junk (TERMINAL ID, auth codes) can't win.
function extractVendor(lines) {
  const labeled = extractMerchantName(lines);
  if (labeled) return labeled;
  const window_ = lines.slice(0, Math.max(5, Math.ceil(lines.length * 0.4)));
  let best = null;
  let bestScore = -Infinity;
  for (const line of window_) {
    if (looksLikeNonVendor(line)) continue;
    const score = vendorScore(line);
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (!best) return '';
  return best
    .replace(/[^\w\s#'&.,()/\-]/gu, ' ') // drop OCR symbol junk
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s.,#]+$/, '')
    .trim();
}

// Bank / card processor: explicit labels first ("ISSUER:", "BANK:", ...),
// then a scan for known institution/processor names anywhere on the slip.
const BANK_LABEL_RE = /\b(?:ISSUER|ISSUING\s+BANK|ACQUIRER|PROCESSOR|BANK)\b\s*[:#\-–—]?\s*(.+)/i;
const KNOWN_BANKS_RE = new RegExp(
  '\\b(' +
    [
      'Bank of America', 'Wells Fargo', 'JPMorgan Chase', 'Chase', 'Citibank', 'Citi',
      'Capital One', 'U\\.?S\\.? Bank', 'PNC', 'Truist', 'TD Bank', 'American Express',
      'Amex', 'Discover', 'Barclays', 'HSBC', 'Navy Federal', 'USAA', 'Fifth Third',
      'KeyBank', 'Regions', 'Citizens', 'Huntington', 'Ally', 'Synchrony', 'BMO',
      'Santander', 'Union Bank', 'Comerica', 'Zions', 'Frost', 'WebBank',
      // common POS processors that print their name where the bank would be
      'Stripe', 'Square', 'PayPal', 'Block', 'Clover', 'Toast', 'Shift4', 'Fiserv',
      'First Data', 'Worldpay', 'Global Payments', 'Elavon', 'Adyen'
    ].join('|') +
  ')\\b',
  'i'
);

function extractBankName(text) {
  const lines = linesOf(text);
  for (const line of lines) {
    const m = line.match(BANK_LABEL_RE);
    if (m && m[1].trim().length >= 2 && !moneyIn(m[1]).length && !/\d{6,}/.test(m[1])) {
      return m[1].trim();
    }
  }
  for (const line of lines) {
    const m = line.match(KNOWN_BANKS_RE);
    if (m) return m[1];
  }
  return null;
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
    if (!TAX_KEYWORDS.test(line)) return;
    const sameLine = moneyIn(line);
    if (sameLine.length) {
      // "SALES TAX TOTAL $ 0.00" is a tax line even though it says TOTAL
      candidates.push(...sameLine);
    } else {
      // label/value split across OCR lines — but never steal the TOTAL line's amount
      const next = lines[i + 1] || '';
      if (!TOTAL_KEYWORDS.test(next.replace(SUBTOTAL_RE, ''))) candidates.push(...moneyIn(next));
    }
  });
  return candidates.length ? toCents(Math.max(...candidates)) : null;
}

// Subtotal: money on/next to a SUBTOTAL-keyword line.
function extractSubtotalCents(text) {
  const lines = linesOf(text);
  const candidates = [];
  lines.forEach((line, i) => {
    if (SUBTOTAL_RE.test(line)) {
      candidates.push(...moneyIn(line), ...moneyIn(lines[i + 1] || ''));
    }
  });
  return candidates.length ? toCents(Math.max(...candidates)) : null;
}

// Line items: priced lines in the merchandise section (everything above the
// first TOTAL line), skipping subtotal/tax/payment/date boilerplate. The item
// amount is the LAST money value on the line ("2 @ 4.50  9.00" -> 9.00).
function extractLineItems(text) {
  const items = [];
  for (const line of linesOf(text)) {
    if (TOTAL_KEYWORDS.test(line.replace(SUBTOTAL_RE, ''))) break; // totals section ends items
    if (SUBTOTAL_RE.test(line) || TAX_KEYWORDS.test(line)) continue;
    if (NON_ITEM_KEYWORDS.test(line)) continue;
    if (/^\s*(QTY|QTV|QTY|QUANTITY)\b/i.test(line)) continue; // "QTY: 1.6 GAL, PRICE: ..." detail lines
    if (looksLikeDateOrNumber(line) || /\d{1,2}:\d{2}/.test(line)) continue; // dates/times
    const amounts = moneyIn(line);
    if (!amounts.length) continue;
    const description = line
      .replace(MONEY_RE, '')
      .replace(/[$€£]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (description.length < 2 || !/[A-Za-z]/.test(description)) continue;
    items.push({ description, amount_cents: toCents(amounts[amounts.length - 1]) });
  }
  return items.slice(0, 50);
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
  const vendor = extractVendor(lines);
  return {
    vendor,
    merchant_name: vendor, // POS terminology — same field, explicit alias
    bank_name: extractBankName(text),
    date: extractDate(text, opts.datePref || 'MDY'),
    total_cents: extractTotalCents(text),
    tax_cents: extractTaxCents(text),
    subtotal_cents: extractSubtotalCents(text),
    items: extractLineItems(text)
  };
}

module.exports = {
  extractFields, extractVendor, extractDate, extractTotalCents, extractTaxCents,
  extractSubtotalCents, extractLineItems, extractBankName, extractMerchantName, toCents
};
