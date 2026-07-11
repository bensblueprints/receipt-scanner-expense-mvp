// Snapreceipt renderer. Talks to main only through window.snap (preload bridge).
// Key UX rule mirrored from the backend: OCR results only PREFILL the review
// form — a receipt exists in the database only after the user clicks Save.
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ReceiptText, Upload, FolderSearch, BarChart3, Car, Settings as SettingsIcon,
  Trash2, Pencil, FileDown, FileText, Save, X, ScanLine, Loader2, Plus,
  FolderOpen, Tag, AlertTriangle, Inbox
} from 'lucide-react';

const fmt = (cents) => (cents == null || cents === '' ? '—' : `$${(cents / 100).toFixed(2)}`);
const centsFromInput = (v) => {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const dollarsFromCents = (c) => (c == null ? '' : (c / 100).toFixed(2));

/* ---------- small primitives ---------- */
function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
const inputCls =
  'w-full rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40 placeholder:text-zinc-600';

function Button({ children, onClick, variant = 'ghost', className = '', ...rest }) {
  const base = 'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-500',
    ghost: 'bg-zinc-800/70 text-zinc-200 hover:bg-zinc-700/70 border border-zinc-700/50',
    danger: 'bg-red-900/40 text-red-300 hover:bg-red-900/70 border border-red-800/40'
  };
  return (
    <button onClick={onClick} className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ---------- review form (the explicit-save gate) ---------- */
function ReviewForm({ draft, categories, onSaved, onCancel }) {
  const isEdit = !!draft.id;
  const [vendor, setVendor] = useState(draft.fields?.vendor ?? draft.vendor ?? '');
  const [date, setDate] = useState(draft.fields?.date ?? draft.date ?? '');
  const [total, setTotal] = useState(dollarsFromCents(draft.fields?.total_cents ?? draft.total_cents));
  const [tax, setTax] = useState(dollarsFromCents(draft.fields?.tax_cents ?? draft.tax_cents));
  const [category, setCategory] = useState(draft.category ?? 'Other');
  const [projectTag, setProjectTag] = useState(draft.project_tag ?? '');
  const [imgUrl, setImgUrl] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (draft.image_path) window.snap.imageDataUrl(draft.image_path).then(setImgUrl);
  }, [draft.image_path]);

  const save = async () => {
    setSaving(true);
    const payload = {
      image_path: draft.image_path || null,
      vendor,
      date: date || null,
      total_cents: centsFromInput(total) ?? 0,
      tax_cents: centsFromInput(tax),
      category,
      project_tag: projectTag,
      ocr_raw_text: draft.ocr_raw_text ?? ''
    };
    if (isEdit) await window.snap.updateReceipt(draft.id, payload);
    else await window.snap.saveReceipt(payload); // <-- the ONLY insert path
    setSaving(false);
    onSaved();
  };

  const cancel = async () => {
    // brand-new import discarded before save -> clean up the copied image
    if (!isEdit && draft.image_path) await window.snap.discardImport(draft.image_path);
    onCancel();
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    >
      <motion.div
        className="flex max-h-full w-full max-w-3xl gap-5 overflow-auto rounded-2xl border border-zinc-800 bg-[#11141c] p-6 shadow-2xl"
        initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 12 }}
      >
        <div className="w-2/5 shrink-0">
          {imgUrl ? (
            <img src={imgUrl} alt="receipt" className="max-h-[60vh] w-full rounded-lg border border-zinc-800 object-contain bg-zinc-900" />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-zinc-700 text-zinc-600">
              <ReceiptText size={40} />
            </div>
          )}
          {draft.ocrError && (
            <p className="mt-3 flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {draft.ocrError}
            </p>
          )}
        </div>
        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{isEdit ? 'Edit receipt' : 'Review before saving'}</h2>
            <button onClick={cancel} className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><X size={18} /></button>
          </div>
          {!isEdit && (
            <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
              OCR prefilled these fields — nothing is saved until you hit Save. Fix anything it got wrong.
            </p>
          )}
          <Field label="Vendor"><input className={inputCls} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Coffee House" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><input type="date" className={inputCls} value={date || ''} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Category">
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Total ($)"><input className={inputCls} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="23.45" /></Field>
            <Field label="Tax ($)"><input className={inputCls} value={tax} onChange={(e) => setTax(e.target.value)} placeholder="1.45" /></Field>
          </div>
          <Field label="Project / client tag">
            <input className={inputCls} value={projectTag} onChange={(e) => setProjectTag(e.target.value)} placeholder="acme-rebrand" />
          </Field>
          {draft.ocr_raw_text ? (
            <details className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 text-xs text-zinc-400">
              <summary className="cursor-pointer select-none text-zinc-500">Raw OCR text</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{draft.ocr_raw_text}</pre>
            </details>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={cancel}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {isEdit ? 'Update' : 'Save receipt'}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ---------- receipts view ---------- */
function ReceiptsView({ categories, refreshKey, bump }) {
  const [receipts, setReceipts] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filterCat, setFilterCat] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [inbox, setInbox] = useState([]);

  const load = useCallback(() => {
    window.snap.listReceipts({ category: filterCat || undefined, project_tag: filterTag || undefined }).then(setReceipts);
  }, [filterCat, filterTag]);
  useEffect(load, [load, refreshKey]);

  useEffect(() => window.snap.onWatchedReceipt((prefill) => setInbox((q) => [...q, prefill])), []);

  const importFiles = async (paths) => {
    setBusy(true);
    try {
      for (const p of paths) {
        const prefill = await window.snap.importReceipt(p);
        setInbox((q) => [...q, prefill]);
      }
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    setBusy(true);
    try {
      for (const file of Array.from(e.dataTransfer.files)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const prefill = await window.snap.importReceiptBytes(file.name, Array.from(bytes));
        setInbox((q) => [...q, prefill]);
      }
    } finally {
      setBusy(false);
    }
  };

  const openNext = () => {
    if (!inbox.length) return;
    setDraft(inbox[0]);
    setInbox((q) => q.slice(1));
  };
  useEffect(() => { if (!draft && inbox.length) openNext(); }, [inbox, draft]); // eslint-disable-line

  const tags = useMemo(() => [...new Set(receipts.map((r) => r.project_tag).filter(Boolean))], [receipts]);

  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 transition-colors ${
          dragOver ? 'border-emerald-500 bg-emerald-950/30' : 'border-zinc-700/70 bg-zinc-900/40 hover:border-zinc-600'
        }`}
      >
        {busy ? <Loader2 size={32} className="animate-spin text-emerald-400" /> : <ScanLine size={32} className="text-emerald-400" />}
        <p className="text-sm text-zinc-400">
          {busy ? 'Running local OCR…' : 'Drop receipt images here — OCR runs 100% on this machine'}
        </p>
        <div className="flex gap-2">
          <Button onClick={async () => importFiles(await window.snap.pickImages())} disabled={busy}>
            <Upload size={15} /> Choose files
          </Button>
        </div>
        <p className="text-xs text-zinc-600">Extraction only prefills the review form. You approve every save.</p>
      </div>

      {inbox.length > 0 && (
        <button onClick={openNext} className="flex w-full items-center gap-2 rounded-xl border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300 hover:bg-amber-950/50">
          <Inbox size={16} /> {inbox.length} scanned receipt{inbox.length > 1 ? 's' : ''} waiting for your review
        </button>
      )}

      <div className="flex items-center gap-2">
        <select className={`${inputCls} !w-44`} value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={`${inputCls} !w-44`} value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
          <option value="">All projects</option>
          {tags.map((t) => <option key={t}>{t}</option>)}
        </select>
        <div className="flex-1" />
        <span className="text-sm text-zinc-500">{receipts.length} receipts · {fmt(receipts.reduce((s, r) => s + r.total_cents, 0))}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/80 text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-2.5">Date</th><th className="px-4 py-2.5">Vendor</th>
              <th className="px-4 py-2.5">Category</th><th className="px-4 py-2.5">Project</th>
              <th className="px-4 py-2.5 text-right">Tax</th><th className="px-4 py-2.5 text-right">Total</th>
              <th className="px-4 py-2.5 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/50">
                <td className="px-4 py-2.5 text-zinc-400">{r.date || '—'}</td>
                <td className="px-4 py-2.5 font-medium">{r.vendor || 'Unknown'}</td>
                <td className="px-4 py-2.5"><span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{r.category}</span></td>
                <td className="px-4 py-2.5 text-zinc-400">{r.project_tag ? <span className="inline-flex items-center gap-1 text-xs"><Tag size={11} />{r.project_tag}</span> : ''}</td>
                <td className="px-4 py-2.5 text-right text-zinc-500">{fmt(r.tax_cents)}</td>
                <td className="px-4 py-2.5 text-right font-semibold text-emerald-400">{fmt(r.total_cents)}</td>
                <td className="px-2 py-2.5">
                  <div className="flex justify-end gap-1">
                    <button className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => setDraft(r)}><Pencil size={14} /></button>
                    <button className="rounded p-1.5 text-zinc-500 hover:bg-red-950 hover:text-red-400" onClick={async () => { await window.snap.deleteReceipt(r.id); load(); bump(); }}><Trash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {!receipts.length && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-zinc-600">No receipts yet — drop an image above to scan your first one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {draft && (
          <ReviewForm
            draft={draft}
            categories={categories}
            onSaved={() => { setDraft(null); load(); bump(); }}
            onCancel={() => setDraft(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- reports view ---------- */
function ReportsView({ refreshKey }) {
  const [summary, setSummary] = useState({ byCategory: [], byMonth: [] });
  const [month, setMonth] = useState('');

  useEffect(() => {
    window.snap.reportSummary(month ? { month } : {}).then(setSummary);
  }, [month, refreshKey]);

  const maxCat = Math.max(1, ...summary.byCategory.map((c) => c.total_cents));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <input type="month" className={`${inputCls} !w-48`} value={month} onChange={(e) => setMonth(e.target.value)} />
        <div className="flex-1" />
        <Button onClick={() => window.snap.exportCsv(month ? { month } : {})}><FileDown size={15} /> Export CSV</Button>
        <Button variant="primary" onClick={() => window.snap.exportPdf(month ? { month } : {})}><FileText size={15} /> PDF expense report</Button>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Spend by category {month && `· ${month}`}</h3>
          <div className="space-y-3">
            {summary.byCategory.map((c) => (
              <div key={c.category}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{c.category} <span className="text-zinc-600">({c.count})</span></span>
                  <span className="font-medium text-emerald-400">{fmt(c.total_cents)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <motion.div className="h-full rounded-full bg-emerald-600" initial={{ width: 0 }} animate={{ width: `${(c.total_cents / maxCat) * 100}%` }} />
                </div>
              </div>
            ))}
            {!summary.byCategory.length && <p className="text-sm text-zinc-600">Nothing here yet.</p>}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Spend by month</h3>
          <table className="w-full text-sm">
            <tbody>
              {summary.byMonth.map((m) => (
                <tr key={m.month} className="border-b border-zinc-800/60 last:border-0">
                  <td className="py-2 text-zinc-300">{m.month}</td>
                  <td className="py-2 text-zinc-600">{m.count} receipts</td>
                  <td className="py-2 text-right font-medium text-emerald-400">{fmt(m.total_cents)}</td>
                </tr>
              ))}
              {!summary.byMonth.length && <tr><td className="py-2 text-sm text-zinc-600">No dated receipts yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ---------- mileage view ---------- */
function MileageView({ bump }) {
  const [entries, setEntries] = useState([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [purpose, setPurpose] = useState('');
  const [miles, setMiles] = useState('');
  const [rate, setRate] = useState('67');

  const load = () => window.snap.listMileage().then(setEntries);
  useEffect(() => {
    load();
    window.snap.getSetting('mileage_rate_cents').then((v) => { if (v) setRate(v); });
  }, []);

  const add = async () => {
    if (!miles) return;
    await window.snap.saveMileage({ date, purpose, miles: parseFloat(miles), rate_cents_per_mile: parseInt(rate, 10) || 67 });
    await window.snap.setSetting('mileage_rate_cents', rate);
    setPurpose(''); setMiles('');
    load(); bump();
  };

  const preview = miles ? Math.round(parseFloat(miles || '0') * (parseInt(rate, 10) || 0)) : null;
  const total = entries.reduce((s, m) => s + m.amount_cents, 0);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">Log a trip</h3>
        <div className="grid grid-cols-5 items-end gap-3">
          <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Purpose"><input className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Client site visit" /></Field>
          <Field label="Miles"><input className={inputCls} value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="24.5" /></Field>
          <Field label="Rate (¢/mile)"><input className={inputCls} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <Button variant="primary" onClick={add} className="h-[38px] justify-center"><Plus size={15} /> Add {preview != null && `(${fmt(preview)})`}</Button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-zinc-500">{entries.length} trips · total reimbursement <span className="font-semibold text-emerald-400">{fmt(total)}</span></span>
        <Button onClick={() => window.snap.exportMileageCsv()}><FileDown size={15} /> Export mileage CSV</Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900/80 text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr><th className="px-4 py-2.5">Date</th><th className="px-4 py-2.5">Purpose</th><th className="px-4 py-2.5 text-right">Miles</th><th className="px-4 py-2.5 text-right">Rate</th><th className="px-4 py-2.5 text-right">Amount</th><th className="w-12"></th></tr>
          </thead>
          <tbody>
            {entries.map((m) => (
              <tr key={m.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/50">
                <td className="px-4 py-2.5 text-zinc-400">{m.date}</td>
                <td className="px-4 py-2.5">{m.purpose}</td>
                <td className="px-4 py-2.5 text-right">{m.miles}</td>
                <td className="px-4 py-2.5 text-right text-zinc-500">{m.rate_cents_per_mile}¢</td>
                <td className="px-4 py-2.5 text-right font-semibold text-emerald-400">{fmt(m.amount_cents)}</td>
                <td className="px-2 py-2.5"><button className="rounded p-1.5 text-zinc-500 hover:bg-red-950 hover:text-red-400" onClick={async () => { await window.snap.deleteMileage(m.id); load(); }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
            {!entries.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-zinc-600">No trips logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- settings view ---------- */
function SettingsView({ categories, onCategoriesChanged }) {
  const [watchFolder, setWatchFolder] = useState('');
  const [datePref, setDatePref] = useState('MDY');
  const [newCat, setNewCat] = useState('');
  const [ocrOk, setOcrOk] = useState(true);

  useEffect(() => {
    window.snap.getSetting('watch_folder').then((v) => setWatchFolder(v || ''));
    window.snap.getSetting('date_pref').then((v) => setDatePref(v || 'MDY'));
    window.snap.ocrAvailable().then(setOcrOk);
  }, []);

  return (
    <div className="max-w-2xl space-y-5">
      {!ocrOk && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-800/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          OCR language data hasn't been downloaded. Run <code className="mx-1 rounded bg-zinc-800 px-1">node scripts/fetch-ocr-data.js</code> once (the app's only network call). Until then imports open a blank review form.
        </p>
      )}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Watched folder</h3>
        <p className="mb-3 text-sm text-zinc-500">Point this at your phone-sync folder. New images get scanned automatically and land in the review inbox — never saved without you.</p>
        <div className="flex gap-2">
          <input className={inputCls} value={watchFolder} readOnly placeholder="No folder watched" />
          <Button onClick={async () => {
            const dir = await window.snap.pickFolder();
            if (dir) { await window.snap.setSetting('watch_folder', dir); setWatchFolder(dir); }
          }}><FolderOpen size={15} /> Choose</Button>
          {watchFolder && <Button variant="danger" onClick={async () => { await window.snap.setSetting('watch_folder', ''); setWatchFolder(''); }}><X size={15} /></Button>}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Date format on receipts</h3>
        <select className={`${inputCls} !w-64`} value={datePref} onChange={async (e) => { setDatePref(e.target.value); await window.snap.setSetting('date_pref', e.target.value); }}>
          <option value="MDY">US — MM/DD/YYYY</option>
          <option value="DMY">International — DD/MM/YYYY</option>
        </select>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Categories</h3>
        <div className="mb-3 flex flex-wrap gap-2">
          {categories.map((c) => <span key={c} className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">{c}</span>)}
        </div>
        <div className="flex gap-2">
          <input className={inputCls} value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Add a category…" />
          <Button variant="primary" onClick={async () => { if (newCat.trim()) { await window.snap.addCategory(newCat); setNewCat(''); onCategoriesChanged(); } }}><Plus size={15} /></Button>
        </div>
      </div>
      <p className="text-xs text-zinc-600">Snapreceipt is 100% local. OCR never leaves this machine and extraction only prefills forms — you review before anything is saved.</p>
    </div>
  );
}

/* ---------- shell ---------- */
const TABS = [
  { id: 'receipts', label: 'Receipts', icon: ReceiptText },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'mileage', label: 'Mileage', icon: Car },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

export default function App() {
  const [tab, setTab] = useState('receipts');
  const [categories, setCategories] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  const loadCats = () => window.snap.listCategories().then(setCategories);
  useEffect(() => { loadCats(); }, []);

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 flex-col border-r border-zinc-800/80 bg-[#0d1017] p-4">
        <div className="mb-8 flex items-center gap-2 px-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600"><ScanLine size={18} /></div>
          <div>
            <h1 className="text-sm font-bold leading-tight">Snapreceipt</h1>
            <p className="text-[10px] text-zinc-500">Pay once. Own it forever.</p>
          </div>
        </div>
        <nav className="space-y-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === id ? 'bg-emerald-600/15 text-emerald-400' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
              }`}
            >
              <Icon size={17} /> {label}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <p className="px-2 text-[10px] leading-relaxed text-zinc-600">100% local OCR · no subscription · no telemetry</p>
      </aside>
      <main className="flex-1 overflow-auto p-8">
        {tab === 'receipts' && <ReceiptsView categories={categories} refreshKey={refreshKey} bump={bump} />}
        {tab === 'reports' && <ReportsView refreshKey={refreshKey} />}
        {tab === 'mileage' && <MileageView bump={bump} />}
        {tab === 'settings' && <SettingsView categories={categories} onCategoriesChanged={loadCats} />}
      </main>
    </div>
  );
}
