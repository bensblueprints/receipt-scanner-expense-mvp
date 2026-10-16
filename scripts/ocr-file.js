// Debug/training utility: run one image through the REAL OCR + parse pipeline
// and print the extracted fields. Usage: node scripts/ocr-file.js <image>
const ocr = require('../src/ocr');
const parse = require('../src/parse');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/ocr-file.js <image>');
    process.exit(1);
  }
  const passes = await ocr.recognizeAll(file);
  passes.sort((a, b) => b.confidence - a.confidence);
  const parsed = passes.map((p) => parse.extractFields(p.text));
  const f = parse.voteFields(parsed);
  console.log('passes   :', passes.map((p) => Math.round(p.confidence)).join(', '), '(confidence, best first)');
  console.log('merchant :', JSON.stringify(f.vendor));
  console.log('date     :', f.date);
  console.log('total    :', f.total_cents, 'cents');
  console.log('tax      :', f.tax_cents);
  console.log('subtotal :', f.subtotal_cents);
  console.log('bank     :', JSON.stringify(f.bank_name));
  console.log('items    :', JSON.stringify(f.items, null, 1));
  console.log('--- raw OCR (best pass) ---');
  console.log(passes[0].text);
  await ocr.terminate();
})().catch((e) => { console.error(e.message); process.exit(1); });
