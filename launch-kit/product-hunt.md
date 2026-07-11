# Product Hunt Launch — Snapreceipt

## Name
Snapreceipt

## Tagline (60 chars)
Local receipt OCR + expense reports. $19 once, no cloud.

## Description (260 chars)
Drop a receipt image in — local OCR prefills vendor, date, total & tax; you review and save. Categories, project tags, mileage log, CSV + PDF expense reports with receipt thumbnails. 100% offline, SQLite you own. $19 once vs Expensify's $5–9/user/mo forever.

## Full description
Snapreceipt is a pay-once desktop receipt scanner and expense logger.

- **Import**: drag & drop receipt images, or watch your phone-sync folder — new photos land in a review inbox automatically.
- **Local OCR**: tesseract.js running entirely on your machine extracts vendor, date, total, and tax. It only *prefills* an editable form — nothing is ever saved until you click Save, and nothing ever leaves your computer.
- **Organize**: bundled + custom categories, project/client tags for billable expenses.
- **Report**: spend by category and month, RFC 4180 CSV export, and a PDF expense report with receipt thumbnails embedded — ready to attach to a reimbursement request.
- **Mileage**: log trips with a configurable ¢/mile rate; reimbursement calculated in exact integer cents.

No subscription. No per-user pricing. No telemetry. One $19 payment, yours forever. Source is MIT on GitHub — the paid version is the 1-click Windows installer for people who don't want to touch a terminal.

## Maker first comment
Hey PH 👋

I got tired of paying $9/user/month to Expensify to... OCR a receipt. That's it. That's the product. OCR is a solved, free, local problem — Tesseract has done it for years — yet every expense tool wraps it in a cloud subscription and keeps your receipts on their servers.

So I built Snapreceipt: a desktop app where the OCR runs on YOUR machine. It reads the receipt, prefills a form, and then gets out of the way — you fix anything it misread and hit Save. Your data is a SQLite file on your disk. The PDF expense report (with receipt images attached) comes out ready for your accountant or your boss.

One design decision I want to be upfront about: OCR is never trusted blindly. Heuristics get vendor/date/total right most of the time, but a crumpled thermal receipt will fool any OCR — so nothing auto-saves, ever. It's prefill + human review, honestly.

$19 once. Happy to answer anything — especially "why isn't this a subscription" 😄

## Gallery shots (5)
1. **Hero** — dark UI, drag-drop zone with a receipt mid-scan, "OCR runs 100% on this machine" caption visible.
2. **Review form** — receipt image on the left, prefilled vendor/date/total/tax fields on the right with the "nothing is saved until you hit Save" banner.
3. **Reports view** — spend-by-category bars + spend-by-month table, with Export CSV / PDF buttons.
4. **PDF report** — the exported PDF open in a viewer showing summary tables and receipt thumbnails page.
5. **Mileage log** — trip entries with live reimbursement math and the configurable ¢/mile rate.
