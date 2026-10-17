// Shared "does the math add up" check. ONE definition used by the dashboard
// row flags, the review form, the CSV export and the PDF report, so every
// surface flags exactly the same receipts. Pure module — easy to test.
//
// A digit misread (6.11 vs 6.41) always breaks one of these identities:
//   subtotal + tax = total
//   sum(line items) = subtotal

function dollars(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function effectiveSubtotalCents(r) {
  if (r.subtotal_cents != null) return r.subtotal_cents;
  if (r.total_cents != null && r.tax_cents != null) return r.total_cents - r.tax_cents;
  return null;
}

// receipt row + its line items -> array of human-readable warnings ([] = ok)
function receiptWarnings(r, items) {
  const warnings = [];
  const sub = r.subtotal_cents;
  if (r.total_cents != null && sub != null && r.tax_cents != null && sub + r.tax_cents !== r.total_cents) {
    warnings.push(`subtotal+tax ${dollars(sub + r.tax_cents)} != total ${dollars(r.total_cents)}`);
  }
  if (Array.isArray(items) && items.length && sub != null) {
    const sum = items.reduce((s, it) => s + (it.amount_cents || 0), 0);
    if (sum > 0 && sum !== sub) {
      warnings.push(`items sum ${dollars(sum)} != subtotal ${dollars(sub)}`);
    }
  }
  return warnings;
}

module.exports = { receiptWarnings, effectiveSubtotalCents };
