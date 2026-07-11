// CSV export — pure string building (RFC 4180 escaping), testable headlessly.
// Money columns are rendered as decimal dollars from integer cents.

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function centsToDecimal(cents) {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

function receiptsCsv(receipts) {
  const header = ['date', 'vendor', 'category', 'project_tag', 'total', 'tax'];
  const rows = receipts.map((r) => [
    r.date || '',
    r.vendor || '',
    r.category || '',
    r.project_tag || '',
    centsToDecimal(r.total_cents),
    centsToDecimal(r.tax_cents)
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function mileageCsv(entries) {
  const header = ['date', 'purpose', 'miles', 'rate_per_mile', 'amount'];
  const rows = entries.map((m) => [
    m.date || '',
    m.purpose || '',
    m.miles,
    centsToDecimal(m.rate_cents_per_mile),
    centsToDecimal(m.amount_cents)
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

module.exports = { receiptsCsv, mileageCsv, csvEscape, centsToDecimal };
