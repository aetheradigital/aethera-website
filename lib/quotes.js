'use strict';
/**
 * Quotes: pricing math, validation, payment schedules, terms and the service catalog.
 * Pure functions only (no I/O) so the server, the tests and the numbers on the client's page all agree.
 *
 * Money is kept in cents. Hours may be fractional (0.5 h). Rates and fixed prices are entered in dollars.
 * Pricing model (matches the Aethera quote PDFs):
 *   standard price = hours × standard rate          (shown struck through)
 *   your price      = hours × the client's rate     (the rate discount is the difference)
 *   startup discount = a % off the one-time subtotal (hours shown reduced by the same %)
 *   monthly lines are billed every month and aren't affected by the startup discount.
 */
const crypto = require('crypto');

const SERVICES = require('./desk').SERVICES;
const QUOTE_STATUS = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'void'];
const WHEN = ['signing', 'date', 'milestone'];
const MAX_ITEMS = 40;
const MAX_INSTALLMENTS = 8;

function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function numberOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T12:00:00Z')); }
function shortId() { return crypto.randomBytes(5).toString('base64url'); }

// ---------- validation ----------
// Returns { data } or { error }. `partial` allows a PATCH that sends only some fields.
function validateQuote(input, partial) {
  if (!input || typeof input !== 'object') return { error: 'Invalid request.' };
  const out = {};
  const str = { number: 40, title: 160, summary: 1000, included: 3000, not_included: 3000, notes: 3000, prepared_by: 120 };
  for (const k of Object.keys(str)) if (k in input) out[k] = clip(input[k], str[k]);
  if ('client_id' in input) {
    if (!/^cli_[A-Za-z0-9_-]{6,40}$/.test(String(input.client_id || ''))) return { error: 'Choose a client.' };
    out.client_id = String(input.client_id);
  }
  for (const k of ['issued', 'valid_until', 'monthly_start']) {
    if (!(k in input)) continue;
    if (input[k] === null || input[k] === '') { out[k] = null; continue; }
    if (!isDate(input[k])) return { error: { issued: 'Issued', valid_until: 'Valid through', monthly_start: 'Monthly start' }[k] + ' must be a date.' };
    out[k] = input[k];
  }
  const nums = { standard_rate: [0, 1000, 'Standard rate'], rate: [0, 1000, 'Client rate'], startup_discount_pct: [0, 100, 'Startup discount'], days_until_due: [1, 90, 'Days until due'] };
  for (const k of Object.keys(nums)) {
    if (!(k in input)) continue;
    const n = numberOf(input[k]);
    const r = nums[k];
    if (n === null) { out[k] = k === 'days_until_due' ? 7 : 0; continue; }
    if (isNaN(n) || n < r[0] || n > r[1]) return { error: r[2] + ' must be between ' + r[0] + ' and ' + r[1] + '.' };
    out[k] = k === 'days_until_due' ? Math.round(n) : n;
  }
  if ('items' in input) {
    if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) return { error: 'Add up to ' + MAX_ITEMS + ' lines.' };
    const ids = new Set(); out.items = [];
    for (const raw of input.items) {
      const it = raw || {};
      const name = clip(it.name, 160);
      if (!name) return { error: 'Every line needs a name.' };
      const pricing = it.pricing === 'fixed' ? 'fixed' : 'hours';
      const billing = it.billing === 'monthly' ? 'monthly' : 'one_time';
      const hours = pricing === 'hours' ? numberOf(it.hours) : null;
      const amount = pricing === 'fixed' ? numberOf(it.amount) : null;
      if (pricing === 'hours' && (hours === null || isNaN(hours) || hours < 0 || hours > 10000)) return { error: '“' + name + '” needs hours (0–10,000).' };
      if (pricing === 'fixed' && (amount === null || isNaN(amount) || amount < 0 || amount > 1000000)) return { error: '“' + name + '” needs a price.' };
      let id = /^[A-Za-z0-9_-]{4,20}$/.test(String(it.id || '')) ? String(it.id) : shortId();
      while (ids.has(id)) id = shortId();
      ids.add(id);
      out.items.push({
        id: id, name: name, description: clip(it.description, 1000), timeline: clip(it.timeline, 80),
        service: SERVICES.indexOf(it.service) >= 0 ? it.service : '',
        pricing: pricing, hours: pricing === 'hours' ? hours : null, amount: pricing === 'fixed' ? amount : null,
        billing: billing, optional: it.optional === true || it.optional === 'true'
      });
    }
  }
  if ('schedule' in input) {
    if (!Array.isArray(input.schedule) || input.schedule.length > MAX_INSTALLMENTS) return { error: 'Use up to ' + MAX_INSTALLMENTS + ' payments.' };
    out.schedule = [];
    for (const raw of input.schedule) {
      const s = raw || {};
      const label = clip(s.label, 120);
      const pct = numberOf(s.percent);
      const when = WHEN.indexOf(s.when) >= 0 ? s.when : 'signing';
      if (!label) return { error: 'Name each payment (for example “Deposit”).' };
      if (pct === null || isNaN(pct) || pct <= 0 || pct > 100) return { error: '“' + label + '” needs a percent between 1 and 100.' };
      if (when === 'date' && !isDate(s.date)) return { error: 'Pick a date for “' + label + '”.' };
      out.schedule.push({ label: label, percent: Math.round(pct * 100) / 100, when: when, date: when === 'date' ? s.date : null });
    }
    if (out.schedule.length) {
      const sum = out.schedule.reduce((t, s) => t + s.percent, 0);
      if (Math.abs(sum - 100) > 0.001) return { error: 'The payment schedule adds up to ' + (Math.round(sum * 100) / 100) + '%. It needs to total 100%.' };
    }
  }
  if ('key_dates' in input) {
    if (!Array.isArray(input.key_dates) || input.key_dates.length > 10) return { error: 'Add up to 10 key dates.' };
    out.key_dates = [];
    for (const raw of input.key_dates) {
      const k = raw || {}; const label = clip(k.label, 120);
      if (!label && !k.date) continue;
      if (!label) return { error: 'Name each key date.' };
      if (k.date && !isDate(k.date)) return { error: '“' + label + '” needs a valid date.' };
      out.key_dates.push({ label: label, date: k.date || null });
    }
  }
  if (!partial) {
    if (!out.client_id) return { error: 'Choose a client.' };
    if (!out.title) return { error: 'Give the quote a title.' };
  } else if ('title' in out && !out.title) return { error: 'Give the quote a title.' };
  return { data: out };
}

// ---------- pricing ----------
function cents(d) { return Math.round(Number(d || 0) * 100); }
function round2(n) { return Math.round(n * 100) / 100; }

// Which lines are in: every required line, plus the optional ones the client ticked.
function includedItems(q, selected) {
  const sel = new Set(Array.isArray(selected) ? selected : []);
  return (q.items || []).filter((it) => !it.optional || sel.has(it.id));
}

function lineAmounts(q, it) {
  const std = q.standard_rate != null ? q.standard_rate : 50;
  const rate = q.rate != null ? q.rate : std;
  if (it.pricing === 'fixed') { const c = cents(it.amount); return { standard: c, amount: c, hours: 0 }; }
  const h = Number(it.hours) || 0;
  return { standard: Math.round(h * std * 100), amount: Math.round(h * rate * 100), hours: h };
}

function totals(q, selected) {
  const items = includedItems(q, selected);
  const t = { hours: 0, standard: 0, subtotal: 0, rate_discount: 0, startup_pct: Number(q.startup_discount_pct) || 0, startup_discount: 0, startup_hours: 0,
    total: 0, hours_after: 0, monthly: 0, monthly_standard: 0, savings: 0, lines: {} };
  for (const it of items) {
    const a = lineAmounts(q, it);
    t.lines[it.id] = a;
    if (it.billing === 'monthly') { t.monthly += a.amount; t.monthly_standard += a.standard; continue; }
    t.hours += a.hours; t.standard += a.standard; t.subtotal += a.amount;
  }
  // per-line amounts for the optional lines too, so the page can show what each add-on costs
  for (const it of q.items || []) if (!t.lines[it.id]) t.lines[it.id] = lineAmounts(q, it);
  t.rate_discount = t.standard - t.subtotal;
  t.startup_discount = Math.round(t.subtotal * t.startup_pct / 100);
  t.startup_hours = round2(t.hours * t.startup_pct / 100);
  t.total = t.subtotal - t.startup_discount;
  t.hours_after = round2(t.hours - t.startup_hours);
  t.hours = round2(t.hours);
  t.savings = t.rate_discount + t.startup_discount;
  return t;
}

// The one-time total split into the payment schedule. The last payment absorbs rounding so the parts add up exactly.
function installments(q, total) {
  const sched = q.schedule && q.schedule.length ? q.schedule : [{ label: 'Due on signing', percent: 100, when: 'signing', date: null }];
  if (!total) return [];
  let used = 0;
  return sched.map((s, i) => {
    const amount = i === sched.length - 1 ? total - used : Math.round(total * s.percent / 100);
    used += amount;
    return { index: i, label: s.label, percent: s.percent, when: s.when, date: s.date || null, amount: amount };
  });
}

// ---------- numbering ----------
const SKIP = new Set(['and', 'of', 'the', 'llc', 'inc', 'co', 'company', 'ltd', 'corp', '&']);
function clientCode(client) {
  const name = String((client && (client.company || client.name)) || 'Client');
  let words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !SKIP.has(w.toLowerCase()));
  // keep a trailing "Company" style word when it's part of how the client is known (Liberty Tool Company → LTC)
  if (/\b(company|co)\b\.?$/i.test(name) && kept.length >= 2) kept.push('C');
  words = kept.length ? kept : words;
  let code = words.map((w) => w[0]).join('').toUpperCase();
  if (code.length < 2) code = (words[0] || 'CL').slice(0, 3).toUpperCase();
  return code.slice(0, 5);
}
function nextNumber(client, existing, year) {
  const prefix = 'AD-' + clientCode(client) + '-' + year + '-';
  let max = 0;
  for (const q of existing || []) {
    const m = String(q.number || '').match(/-(\d{4})-(\d{2,4})$/);
    if (m && m[1] === String(year)) max = Math.max(max, Number(m[2]));
  }
  return prefix + String(max + 1).padStart(2, '0');
}

// ---------- integrity ----------
// A fingerprint of exactly what was signed: the quote's content, the chosen add-ons, the totals and the terms text.
function fingerprint(q, selected, t, terms) {
  const content = {
    number: q.number, title: q.title, summary: q.summary || '', issued: q.issued || null, valid_until: q.valid_until || null,
    standard_rate: q.standard_rate, rate: q.rate, startup_discount_pct: q.startup_discount_pct || 0,
    items: (q.items || []).map((it) => [it.id, it.name, it.description, it.timeline, it.pricing, it.hours, it.amount, it.billing, it.optional]),
    selected: (Array.isArray(selected) ? selected : []).slice().sort(),
    schedule: installments(q, t.total).map((s) => [s.label, s.percent, s.when, s.date, s.amount]),
    monthly: t.monthly, monthly_start: q.monthly_start || null, total: t.total,
    included: q.included || '', not_included: q.not_included || '', notes: q.notes || '', key_dates: q.key_dates || [],
    terms_version: terms ? terms.version : null, terms_body: terms ? terms.body : ''
  };
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// ---------- defaults ----------
const DEFAULT_TERMS = [
  '1. Scope and price. The price in this quote covers the scope, phases and add-ons listed in it. Work outside that scope is billed at the client rate shown in this quote, and only after the client approves it in writing (email is fine).',
  '',
  '2. Payments. Invoices follow the payment schedule in this quote and are due within the number of days shown on each invoice. Work on a phase begins once the payment due before it has been received. Payment by US bank account (ACH) is preferred; cards are also accepted.',
  '',
  '3. Monthly services. Monthly services are billed in advance each month, are month-to-month, and can be canceled by either party with 30 days’ written notice. Fees already paid for a month in progress are not refunded.',
  '',
  '4. Client resources and timing. Dates in this quote depend on the client providing content, access (accounts, logins, brand files) and feedback in a timely way. Delays in those items move the schedule by the same amount of time.',
  '',
  '5. Approvals. Each deliverable is presented for review. The client has 5 business days to request changes; after that, or once the client approves it, the deliverable is considered final. Changes after final approval are additional work.',
  '',
  '6. Third-party costs. Advertising spend, software subscriptions, domains, hosting, stock assets, plugins and other third-party costs are not included unless listed in this quote, and are paid by the client directly or billed at cost.',
  '',
  '7. Ownership. Once a project is paid in full, the client owns the final deliverables created for them. Aethera Digital keeps ownership of its own tools, templates, code libraries and methods, and may show the finished work in its portfolio unless the client asks it not to.',
  '',
  '8. Cancellation. Either party may cancel a project with written notice. The client pays for work completed through the date of cancellation; deposits cover work already scheduled and are non-refundable.',
  '',
  '9. Discounts. Discounts shown in this quote, including the startup discount, apply only if this quote is accepted by its valid-through date.',
  '',
  '10. Electronic signatures. Both parties agree that this quote and these terms may be signed electronically, and that an electronic signature has the same effect as a handwritten one.'
].join('\n');

const DEFAULT_CATALOG = [
  { name: 'Brand & Positioning', service: 'Brand Development & Design', pricing: 'fixed', amount: 200, billing: 'monthly', description: 'Ongoing brand and messaging direction.' },
  { name: 'Website', service: 'Website Development & Refinement', pricing: 'fixed', amount: 600, billing: 'monthly', description: 'Up to a 5-page website, kept current.' },
  { name: 'SEO & AI Search Visibility', service: 'SEO & AI Search Visibility', pricing: 'fixed', amount: 450, billing: 'monthly', description: 'Search and AI-answer visibility work each month.' },
  { name: 'Customer Acquisition & Lead Follow-Up', service: 'Advertising & Funnels', pricing: 'fixed', amount: 750, billing: 'monthly', description: 'One ad platform where appropriate, plus lead follow-up.' },
  { name: 'Reporting & Strategy', service: 'Reporting & Strategy', pricing: 'fixed', amount: 250, billing: 'monthly', description: 'Monthly report and one strategy meeting.' },
  { name: 'Project Setup & Management', service: '', pricing: 'hours', hours: 4, billing: 'one_time', description: 'Kickoff, planning and coordination.' },
  { name: 'Discovery & Planning', service: '', pricing: 'hours', hours: 6, billing: 'one_time', description: 'Goals, audience, sitemap and plan.' },
  { name: 'Testing & Launch', service: 'Website Development & Refinement', pricing: 'hours', hours: 4, billing: 'one_time', description: 'Cross-device testing, launch and DNS.' },
  { name: 'Training & Handoff', service: '', pricing: 'hours', hours: 2, billing: 'one_time', description: 'Walkthrough, how-to notes and handoff.' }
];

function validateCatalogItem(input) {
  const v = validateQuote({ items: [Object.assign({}, input, { id: 'catalog0' })] }, true);
  if (v.error) return v;
  const it = v.data.items[0]; delete it.id; delete it.optional; delete it.timeline;
  return { data: it };
}

module.exports = { QUOTE_STATUS, WHEN, validateQuote, validateCatalogItem, totals, installments, includedItems, nextNumber, clientCode, fingerprint, DEFAULT_TERMS, DEFAULT_CATALOG, isDate };
