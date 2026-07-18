# 🧾 Snapreceipt

## Demo

VIDEO-PLACEHOLDER

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Scan receipts, log expenses, export tax-ready reports — 100% on your machine. Pay once, own it forever.**

Drop a receipt image in. Local OCR reads it. Snapreceipt prefills the vendor, date, total, and tax — **you review and hit Save**. Categorize, tag by project/client, log mileage, and export a CSV or a PDF expense report with receipt thumbnails attached. No subscription, no cloud, no per-user pricing, no telemetry.

> **OCR is 100% local, prefills only — you review before anything is saved.** Extraction results populate an editable review form; a receipt row is only ever created when you explicitly click Save. Nothing auto-saves, and no image or text ever leaves your machine.

![Snapreceipt screenshot](docs/screenshot.png)

## ✨ Features

- 📥 **Import anything** — drag & drop receipt images, file picker, or point a **watched folder** at your phone-sync directory and new photos land in a review inbox automatically (still never saved without you).
- 🔍 **Local OCR auto-extract** — tesseract.js running entirely on-disk pulls **vendor, date, total, and tax** with battle-tested heuristics (multi-format dates, TOTAL-keyword detection with sane fallbacks). Wrong guess? It's just a prefill — fix it in the form.
- 🏷️ **Categories + project/client tags** — bundled category list plus your own, and free-form project tags for billable-expense tracking.
- 📊 **Reports** — spend by category and by month, filterable, all math in exact integer cents.
- 📤 **Exports** — RFC 4180 CSV for your accountant, and a **PDF expense report with receipt thumbnails embedded** — ready to attach to a reimbursement request.
- 🚗 **Mileage log** — date, purpose, miles, configurable ¢/mile rate; reimbursement auto-calculated (`Math.round(miles × rate)` — never a floating-point cent in the ledger).
- 🔒 **Private by design** — SQLite file on your disk, receipt images copied into your app data folder, zero network calls at runtime.

The only network access Snapreceipt ever performs is a **one-time download of the English OCR language data (~11 MB)** during `npm install` (`scripts/fetch-ocr-data.js` — clearly surfaced, retryable, and the app degrades gracefully without it). After that: fully offline.

## 🚀 Quick start

```bash
npm install     # also fetches OCR language data (one time) + native bindings
npm run build   # build the renderer
npm start       # launch the desktop app
```

Run the test suite (real OCR on a generated receipt, report math, CSV/PDF exports, mileage math):

```bash
npm test
```

## ☕ Skip the setup — get the 1-click installer

Don't want to touch a terminal? Grab the packaged Windows installer (pay once, own it forever):

**→ [https://whop.com/benjisaiempire/snapreceipt](https://whop.com/benjisaiempire/snapreceipt)**

## 🛠 Tech stack

| Layer | Tech |
|---|---|
| Shell | Electron (contextIsolation on, narrow preload bridge) |
| UI | React + Vite + Tailwind CSS v4 + Framer Motion + Lucide |
| OCR | tesseract.js 7 with fully local assets (`ocr-assets/`, no CDN, ever) |
| Storage | better-sqlite3 (WAL), integer-cents money, idempotent schema |
| PDF | pdf-lib (pure JS — the exact export path is smoke-tested headlessly) |

## 💸 Snapreceipt vs Expensify

| | **Snapreceipt** | **Expensify** |
|---|---|---|
| Price | **$19 once** | $5–$9 /user/**month**, forever |
| Receipt OCR | ✅ 100% local | ✅ cloud (your receipts on their servers) |
| Works offline | ✅ always | ❌ |
| Your data | ✅ SQLite file you own | ❌ their cloud |
| Mileage log | ✅ configurable rate | ✅ (paid tiers) |
| PDF report w/ receipt images | ✅ | ✅ |
| Price after 3 years | **still $19** | $180–$324 per user |

**Pays for itself in ~3 months:** at Expensify's $5–9/user/mo, one user spends $15–27 in a single quarter — more than Snapreceipt costs once, for life.

## 📄 License

MIT © 2026 Ben ([bensblueprints](https://github.com/bensblueprints)) — see [LICENSE](LICENSE).

## macOS build

See [MAC-BUILD.md](MAC-BUILD.md). Quickest path: GitHub **Actions** tab -> run the **Mac Build** (`mac-build.yml`) workflow to get a downloadable `.dmg` (unsigned - right-click -> Open on first launch).
