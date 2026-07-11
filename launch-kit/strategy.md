# Launch Strategy — Snapreceipt

## Positioning
"Expensify is $9/user/mo to OCR a receipt you could OCR locally for free, once." Pay once ($19), own it forever, everything stays on your machine.

## Target communities

| Community | Angle (rules-aware) |
|---|---|
| r/freelance | "How I stopped losing billable expenses" story post; mention tool only when asked / in comments. No link-dropping — their rules ban self-promo threads. |
| r/smallbusiness | Answer recurring "cheap Expensify alternative?" threads with an honest comparison incl. free options; disclose you built it. |
| r/selfhosted | "Local-first receipt OCR desktop app, MIT source" — this crowd loves no-cloud; lead with the GitHub repo, not the paid installer. |
| r/tax + r/Bookkeeping | Educational post on organizing receipts for Schedule C; tool mentioned as one workflow. Follow flair rules. |
| r/degoogle / r/privacy | Privacy angle: receipts reveal location + spending patterns; local OCR means zero upload. Disclose affiliation per sub rules. |

## Hacker News — Show HN draft
**Title:** Show HN: Snapreceipt – local receipt OCR and expense reports, no cloud ($19 once)

**Body:**
I kept seeing small teams pay $9/user/month for what is, mechanically, Tesseract plus a form. So I built the pay-once version.

Snapreceipt is an Electron app: drop in a receipt image (or watch a phone-sync folder), tesseract.js runs entirely from on-disk assets (the language model is fetched once at install — never from a CDN at runtime), and heuristics prefill vendor/date/total/tax. Deliberately, OCR only *prefills* — a row hits SQLite only when you click Save, because OCR on crumpled thermal paper will always be wrong sometimes and silent bad data is worse than a 3-second review.

All money is integer cents end-to-end. Reports are SQL aggregations; exports are RFC 4180 CSV and a pdf-lib PDF with receipt thumbnails embedded. Mileage log with a configurable rate rounds out the tax-season story.

Source is MIT (it doubles as my portfolio); the $19 is for the packaged Windows installer. Happy to discuss the OCR heuristics — vendor = first non-numeric line, total = max amount near TOTAL keywords, date = multi-format cascade — and where they fall over.

## SEO keywords (10)
1. expensify alternative free
2. receipt scanner app offline
3. expense tracker with ocr
4. mileage log app desktop
5. one time purchase expense tracker
6. receipt ocr local no cloud
7. expense report pdf generator with receipts
8. small business receipt organizer software
9. self hosted expense tracker
10. scan receipts for taxes offline

## AppSumo / PitchGround pitch
Snapreceipt is the anti-subscription expense tool: a Windows desktop app that OCRs receipts 100% locally, prefills vendor/date/total/tax for one-click review, tags expenses by category and client, logs mileage at a configurable rate, and exports accountant-ready CSVs plus PDF expense reports with the receipt images embedded. No cloud, no per-seat pricing, no data leaving the machine — a perfect lifetime-deal product because there's literally no server cost behind it. Your audience gets an Expensify replacement that pays for itself in one quarter; you get a clean MIT-source product with an installer already packaged.

## Pricing
**$19 one-time.** Expensify is $5–9/user/month → a single user spends $15–27 per quarter. **Snapreceipt pays for itself in ~3 months** (2.1–3.8 months depending on tier), and every month after that is pure savings — $161–305 saved over 3 years, per user.
