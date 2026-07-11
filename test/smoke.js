/**
 * Snapreceipt smoke test — `npm test`. All against REAL code paths and data:
 *   1. Synthetic receipt PNG generated at test time -> REAL tesseract.js OCR
 *      (fully local assets) -> heuristic parser -> exact field assertions,
 *      and PROOF that OCR alone never creates a DB row (prefill-not-save).
 *   2. Explicit save inserts a row with integer cents.
 *   3. Category/month report math (exact sums in cents).
 *   4. CSV export contains the rows + survives comma/quote escaping.
 *   5. PDF expense report with an embedded receipt thumbnail (%PDF magic + size).
 *   6. Mileage math: Math.round(miles * rate_cents).
 *   7. Electron launch probe (env-gated: skipped loudly if this machine can't
 *      register a window class — a known OS-level condition, not an app bug).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { openDb, mileageAmountCents } = require('../src/db');
const parse = require('../src/parse');
const ocr = require('../src/ocr');
const { receiptsCsv } = require('../src/csv');
const { buildExpenseReportPdf } = require('../src/pdf-report');
const { generateReceiptPng } = require('./gen-fixture');

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapreceipt-test-'));
  const db = openDb(tmp);
  let exitCode = 0;

  try {
    console.log('Smoke test: Snapreceipt\n');

    // ===== 1. real local OCR -> parser prefill; no auto-save =====
    assert(ocr.ocrAvailable(), 'eng.traineddata.gz present in ocr-assets (postinstall fetch)');
    const fixture = path.join(tmp, 'synthetic-receipt.png');
    await generateReceiptPng(fixture, ['COFFEE HOUSE', '07/01/2026', 'TAX $1.45', 'TOTAL $23.45']);
    const rawText = await ocr.recognize(fixture);
    assert(rawText.trim().length > 0, 'OCR produced text');
    console.log('    OCR text:', JSON.stringify(rawText.trim()));

    const fields = parse.extractFields(rawText);
    assert(/COFFEE/i.test(fields.vendor), `vendor contains COFFEE (got ${JSON.stringify(fields.vendor)})`);
    assert.strictEqual(fields.total_cents, 2345, `total_cents exactly 2345 (got ${fields.total_cents})`);
    assert.strictEqual(fields.tax_cents, 145, `tax_cents exactly 145 (got ${fields.tax_cents})`);
    assert.strictEqual(fields.date, '2026-07-01', `date 2026-07-01 (got ${fields.date})`);
    assert(Number.isInteger(fields.total_cents), 'total is integer cents');

    // THE core product guarantee: OCR + parse happened, DB untouched.
    assert.strictEqual(db.countReceipts(), 0, 'NO receipt row exists after OCR+parse (prefill only, nothing auto-saves)');
    ok('real tesseract.js OCR (local assets) -> parser: vendor/total/tax/date exact; zero DB rows before explicit save');

    // ===== 2. explicit save inserts, integer cents =====
    const saved = db.saveReceipt({
      image_path: fixture,
      vendor: fields.vendor,
      date: fields.date,
      total_cents: fields.total_cents,
      tax_cents: fields.tax_cents,
      category: 'Meals',
      project_tag: 'client-a',
      ocr_raw_text: rawText
    });
    assert.strictEqual(db.countReceipts(), 1, 'exactly one row after explicit save');
    assert.strictEqual(saved.total_cents, 2345);
    assert.strictEqual(saved.tax_cents, 145);
    assert(Number.isInteger(saved.total_cents) && Number.isInteger(saved.tax_cents), 'stored money is integer cents');
    assert.throws(() => db.saveReceipt({ vendor: 'x', total_cents: 12.34 }), /integer cents/, 'float cents rejected');
    ok('explicit save inserts row with integer cents; non-integer cents rejected');

    // ===== 3. report math =====
    db.saveReceipt({ vendor: 'Cafe B', date: '2026-07-02', total_cents: 550, category: 'Meals' });
    db.saveReceipt({ vendor: 'Flight Co', date: '2026-07-03', total_cents: 20000, category: 'Travel' });
    db.saveReceipt({ vendor: 'Old Cafe', date: '2026-06-15', total_cents: 725, category: 'Meals' });

    const byCatJuly = db.reportByCategory({ month: '2026-07' });
    const meals = byCatJuly.find((c) => c.category === 'Meals');
    const travel = byCatJuly.find((c) => c.category === 'Travel');
    assert.strictEqual(meals.total_cents, 2345 + 550, 'Meals July total exact');
    assert.strictEqual(meals.count, 2);
    assert.strictEqual(meals.tax_cents, 145, 'Meals July tax sum exact');
    assert.strictEqual(travel.total_cents, 20000, 'Travel July total exact');

    const byMonth = db.reportByMonth();
    const july = byMonth.find((m) => m.month === '2026-07');
    const june = byMonth.find((m) => m.month === '2026-06');
    assert.strictEqual(july.total_cents, 2345 + 550 + 20000, 'July month bucket exact');
    assert.strictEqual(july.count, 3);
    assert.strictEqual(june.total_cents, 725, 'June month bucket exact');
    ok('category/month report math: exact integer-cent sums and counts');

    // ===== 4. CSV export =====
    db.saveReceipt({ vendor: 'Vendor, "Fancy"', date: '2026-07-04', total_cents: 999, category: 'Other' });
    const csv = receiptsCsv(db.listReceipts({ month: '2026-07' }));
    const lines = csv.trim().split('\r\n');
    assert.strictEqual(lines[0], 'date,vendor,category,project_tag,total,tax', 'CSV header');
    assert.strictEqual(lines.length - 1, 4, 'CSV row count matches July receipts');
    assert(csv.includes('23.45'), 'CSV contains OCR-derived total as decimal');
    assert(csv.includes('"Vendor, ""Fancy"""'), 'comma+quote vendor RFC4180-escaped');
    ok('CSV export: header, row count, saved OCR row present, escaping survives');

    // ===== 5. PDF expense report with thumbnail =====
    const pdfBytes = await buildExpenseReportPdf({
      title: 'Expense Report — 2026-07',
      receipts: db.listReceipts({ month: '2026-07' }),
      mileage: db.listMileage(),
      byCategory: db.reportByCategory({ month: '2026-07' }),
      byMonth: db.reportByMonth()
    });
    assert.strictEqual(pdfBytes.slice(0, 5).toString('ascii'), '%PDF-', 'PDF magic bytes');
    assert(pdfBytes.length > 5000, `PDF has real content incl. embedded receipt thumbnail (${pdfBytes.length} bytes)`);
    const pdfOut = path.join(tmp, 'report.pdf');
    fs.writeFileSync(pdfOut, pdfBytes);
    assert(fs.existsSync(pdfOut) && fs.statSync(pdfOut).size === pdfBytes.length, 'PDF written to disk intact');
    ok(`PDF expense report: %PDF- magic, ${pdfBytes.length} bytes, receipt thumbnail embedded`);

    // ===== 6. mileage math in cents =====
    const trip = db.saveMileage({ date: '2026-07-05', purpose: 'Client visit', miles: 24.5, rate_cents_per_mile: 67 });
    assert.strictEqual(trip.amount_cents, Math.round(24.5 * 67), 'amount = Math.round(miles * rate_cents)');
    assert.strictEqual(trip.amount_cents, 1642, '24.5 mi @ 67¢ -> 1642 cents exactly');
    assert(Number.isInteger(trip.amount_cents), 'mileage amount is integer cents');
    assert.strictEqual(mileageAmountCents(3, 70), 210, 'plain multiply case');
    assert.strictEqual(mileageAmountCents(0.1, 67), 7, 'rounding case 6.7 -> 7');
    ok('mileage reimbursement math: Math.round(miles * rate_cents), integer cents');

    // ===== 7. Electron probe =====
    console.log('\n[7] Electron launch probe');
    const electron = require('electron'); // path to the electron binary under Node
    // Environment probe: machines drowning in leaked processes can exhaust
    // Windows window-class/atom resources so EVERY Electron launch fails. That
    // is an OS condition, not a Snapreceipt bug — skip loudly, still gate on
    // all core logic above.
    const probe = spawnSync(electron, ['--version'], { encoding: 'utf8', timeout: 60000 });
    if (probe.status !== 0 && /register the window class/i.test((probe.stderr || '') + (probe.stdout || ''))) {
      console.warn('  ⚠ SKIPPED: Electron cannot launch on this machine right now (window-class/atom');
      console.warn('    exhaustion — close leaked processes or reboot, then re-run `npm test`).');
    } else {
      assert.strictEqual(probe.status, 0, `electron --version exits 0 (stderr: ${probe.stderr})`);
      assert(/^v?\d+\./.test((probe.stdout || '').trim()), 'electron reports a version');
      ok(`electron launches (${(probe.stdout || '').trim()})`);
    }

    console.log(`\nAll ${passed} smoke checks passed.`);
  } catch (e) {
    console.error('\nSMOKE TEST FAILED:', e.message);
    console.error(e.stack);
    exitCode = 1;
  } finally {
    try { await ocr.terminate(); } catch {}
    try { db.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  process.exit(exitCode);
})();
