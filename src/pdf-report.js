// PDF expense report via pdf-lib (pure JS — renders headlessly in Node, so the
// smoke test exercises the exact code path the app uses). Layout:
//   page 1+  : summary tables (spend by category, spend by month) + receipt list
//   appendix : one receipt per block with an embedded image thumbnail (PNG/JPG)
// All money is integer cents in, formatted as dollars out.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE = { w: 612, h: 792, margin: 50 }; // US Letter
const INK = rgb(0.13, 0.13, 0.16);
const MUTED = rgb(0.45, 0.45, 0.5);
const ACCENT = rgb(0.15, 0.5, 0.35);
const LINE = rgb(0.85, 0.85, 0.88);

function fmt(cents) {
  return cents == null ? '—' : '$' + (cents / 100).toFixed(2);
}

async function buildExpenseReportPdf({ title = 'Expense Report', receipts = [], mileage = [], byCategory = [], byMonth = [] }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;

  const newPageIfNeeded = (needed) => {
    if (y - needed < PAGE.margin) {
      page = doc.addPage([PAGE.w, PAGE.h]);
      y = PAGE.h - PAGE.margin;
    }
  };
  const text = (str, x, size = 10, f = font, color = INK) => {
    page.drawText(String(str), { x, y, size, font: f, color });
  };
  const hr = () => {
    page.drawLine({ start: { x: PAGE.margin, y: y + 4 }, end: { x: PAGE.w - PAGE.margin, y: y + 4 }, thickness: 0.5, color: LINE });
  };

  // ---- header ----
  text(title, PAGE.margin, 22, bold);
  y -= 18;
  text(`Generated ${new Date().toISOString().slice(0, 10)} · Snapreceipt (local, pay-once)`, PAGE.margin, 9, font, MUTED);
  y -= 30;

  const totalCents = receipts.reduce((s, r) => s + (r.total_cents || 0), 0);
  const taxCents = receipts.reduce((s, r) => s + (r.tax_cents || 0), 0);
  const mileageCents = mileage.reduce((s, m) => s + (m.amount_cents || 0), 0);
  text(`Receipts: ${receipts.length}   Total: ${fmt(totalCents)}   Tax: ${fmt(taxCents)}   Mileage: ${fmt(mileageCents)}   Grand total: ${fmt(totalCents + mileageCents)}`, PAGE.margin, 11, bold, ACCENT);
  y -= 28;

  // ---- table helper ----
  const table = (heading, headers, widths, rows) => {
    newPageIfNeeded(60 + rows.length * 16);
    text(heading, PAGE.margin, 13, bold);
    y -= 18;
    let x = PAGE.margin;
    headers.forEach((h, i) => { text(h, x, 9, bold, MUTED); x += widths[i]; });
    y -= 6;
    hr();
    y -= 12;
    for (const row of rows) {
      newPageIfNeeded(16);
      x = PAGE.margin;
      row.forEach((cell, i) => { text(String(cell), x, 9); x += widths[i]; });
      y -= 14;
    }
    y -= 16;
  };

  if (byCategory.length) {
    table('Spend by category', ['Category', 'Receipts', 'Total', 'Tax'], [200, 90, 110, 110],
      byCategory.map((c) => [c.category, c.count, fmt(c.total_cents), fmt(c.tax_cents)]));
  }
  if (byMonth.length) {
    table('Spend by month', ['Month', 'Receipts', 'Total'], [200, 90, 110],
      byMonth.map((m) => [m.month || '—', m.count, fmt(m.total_cents)]));
  }
  if (receipts.length) {
    table('Receipts', ['Date', 'Vendor', 'Category', 'Project', 'Total'], [70, 170, 100, 90, 80],
      receipts.map((r) => [r.date || '—', (r.vendor || '').slice(0, 34), r.category || '', (r.project_tag || '').slice(0, 16), fmt(r.total_cents)]));
  }
  if (mileage.length) {
    table('Mileage', ['Date', 'Purpose', 'Miles', 'Rate', 'Amount'], [70, 200, 70, 80, 80],
      mileage.map((m) => [m.date, (m.purpose || '').slice(0, 40), m.miles, fmt(m.rate_cents_per_mile), fmt(m.amount_cents)]));
  }

  // ---- appendix: receipt image thumbnails ----
  const withImages = receipts.filter((r) => r.image_path && fs.existsSync(r.image_path));
  if (withImages.length) {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
    text('Attached receipts', PAGE.margin, 16, bold);
    y -= 26;

    for (const r of withImages) {
      let img;
      try {
        const bytes = fs.readFileSync(r.image_path);
        const ext = path.extname(r.image_path).toLowerCase();
        img = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch {
        continue; // unreadable/unsupported image — skip the thumbnail, keep the report
      }
      const maxW = 220;
      const maxH = 220;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      newPageIfNeeded(h + 40);
      text(`${r.date || '—'}  ·  ${r.vendor || 'Unknown vendor'}  ·  ${fmt(r.total_cents)}  ·  ${r.category || ''}`, PAGE.margin, 10, bold);
      y -= h + 8;
      page.drawImage(img, { x: PAGE.margin, y, width: w, height: h });
      y -= 24;
    }
  }

  return Buffer.from(await doc.save());
}

module.exports = { buildExpenseReportPdf };
