'use strict';
/**
 * aetheradigital.com web server.
 * Serves the static site from ./public plus a small Stripe API:
 *   - branded Payment Element checkout for invoices and the Startup Partnership
 *   - an admin area (/admin) to create, send and void invoices
 *   - the signed Stripe webhook (/api/stripe/webhook)
 * No dependencies: Node 20+ (built-in fetch and crypto).
 *
 * Environment variables (set in Render, never in code):
 *   STRIPE_SECRET_KEY       sk_test_... / sk_live_...
 *   STRIPE_PUBLISHABLE_KEY  pk_test_... / pk_live_...
 *   ADMIN_PASSWORD          password for /admin (admin is disabled until this is set; use 12+ characters)
 *   SITE_URL                optional public origin used in emailed links, e.g. https://aetheradigital.com
 *                           (when unset, links use the public domain, or the address the admin page was opened on)
 *   ADMIN_HOST              hostname of the admin site (default admin.aetheradigital.com). On that host "/" is the
 *                           admin dashboard; on the public domain /admin redirects there and the admin API is off.
 *                           Other hosts (the onrender.com address, localhost) keep /admin as a fallback.
 *   PRICE_PARTNERSHIP       optional: comma-separated Price IDs for the $2,250/mo Startup Partnership
 *                           (defaults to the live or sandbox IDs, picked from the secret key)
 *   PORTAL_URL              optional: Stripe customer portal login link (defaults to live or sandbox the same way)
 *   STRIPE_AUTOMATIC_TAX    "on" to turn on Stripe Tax for new invoices and subscriptions (needs Tax set up)
 *   INVOICE_LINK_SECRET     optional key for signing invoice links (defaults to one derived from the secret key)
 *   STRIPE_WEBHOOK_SECRET   whsec_... signing secret of the webhook endpoint (/api/stripe/webhook)
 *   PAYMENTS_NOTIFY_URL     optional: Apps Script web app URL (payments sheet, alerts and invoice emails)
 *   PAYMENTS_NOTIFY_TOKEN   optional: shared token checked by the Apps Script (PAYMENTS_TOKEN script property)
 *   DESK_COLLECTOR_TOKEN    shared secret the Apps Script collector sends (Authorization: Bearer ...)
 *   ANTHROPIC_API_KEY       Claude API key used to turn client emails and meeting notes into suggested to-dos
 *   ANTHROPIC_MODEL         optional model override (default claude-haiku-5-5)
 *   DATABASE_URL            Postgres connection string for the Aethera Desk (Render internal URL). Without it the Desk
 *                           keeps data in memory only (lost on restart) and says so on screen.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const SECRET = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || '';
// Live or sandbox is decided by the installed secret key, so swapping keys in Render switches every ID below too.
const LIVE = /^(sk|rk)_live_/.test(SECRET);
// Startup Partnership prices: live is five monthly line items ($200 + $600 + $450 + $750 + $250 = $2,250);
// the sandbox keeps its single $2,250 price. PRICE_PARTNERSHIP (comma-separated price IDs) overrides either.
const PARTNERSHIP_PRICES_LIVE = [
  'price_1Ude58Ac3ai6mWIjWrBwlPa1', // Brand & Positioning $200
  'price_1Ude5gAc3ai6mWIjvRHYWNxW', // Website $600
  'price_1Ude64Ac3ai6mWIjrtj9zP8W', // SEO & AI Search Visibility $450
  'price_1Ude6SAc3ai6mWIjbnjLG5AE', // Customer Acquisition & Lead Follow-Up $750
  'price_1Ude82Ac3ai6mWIjAUtETc1t'  // Reporting & Strategy $250
];
const PARTNERSHIP_PRICES_TEST = ['price_1UdHOkA3W4CrH9UBqqAxdgXg'];
const PARTNERSHIP_PRICES = process.env.PRICE_PARTNERSHIP
  ? process.env.PRICE_PARTNERSHIP.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  : (LIVE ? PARTNERSHIP_PRICES_LIVE : PARTNERSHIP_PRICES_TEST);
const PORTAL_URL = process.env.PORTAL_URL || (LIVE
  ? 'https://billing.stripe.com/p/login/5kQ28qgsw00v8UGfDQ1gs00'
  : 'https://billing.stripe.com/p/login/test_5kQ28qfmPgiGgFc9Mg7wA00');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_HOST = String(process.env.ADMIN_HOST || 'admin.aetheradigital.com').toLowerCase();
const PUBLIC_DOMAIN = ADMIN_HOST.replace(/^admin\./, '');
const PUBLIC_HOSTS = [PUBLIC_DOMAIN, 'www.' + PUBLIC_DOMAIN];
const AUTOMATIC_TAX = /^(on|true|1)$/i.test(process.env.STRIPE_AUTOMATIC_TAX || '');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const NOTIFY_URL = process.env.PAYMENTS_NOTIFY_URL || '';
const NOTIFY_TOKEN = process.env.PAYMENTS_NOTIFY_TOKEN || '';
const WEBHOOK_TOLERANCE_SEC = 300; // reject signatures older than 5 minutes (replay protection)

const PAYMENT_METHOD_TYPES = ['card', 'us_bank_account'];
const ADMIN_COOKIE = 'aethera_admin';
const ADMIN_SESSION_SEC = 12 * 3600;
const LINK_KEY = process.env.INVOICE_LINK_SECRET
  ? Buffer.from(process.env.INVOICE_LINK_SECRET)
  : crypto.createHmac('sha256', SECRET || 'unset').update('aethera-invoice-links').digest();
const ADMIN_KEY = crypto.createHmac('sha256', ADMIN_PASSWORD || crypto.randomBytes(32)).update('aethera-admin-session:' + SECRET).digest();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com")',
  'Content-Security-Policy': "frame-ancestors 'self'"
};

// ---------- helpers ----------
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers || {}));
  res.end(body);
}
function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
}

// Encode nested objects/arrays the way Stripe's form API expects: a[b][0][c]=d
function encodeForm(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(function (k) {
    const v = obj[k];
    if (v === undefined || v === null) return;
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (Array.isArray(v)) {
      v.forEach(function (item, i) {
        if (item !== null && typeof item === 'object') encodeForm(item, key + '[' + i + ']', out);
        else out.push(encodeURIComponent(key + '[' + i + ']') + '=' + encodeURIComponent(String(item)));
      });
    } else if (typeof v === 'object') {
      encodeForm(v, key, out);
    } else {
      out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
    }
  });
  return out.join('&');
}

async function stripe(method, pathname, params) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/x-www-form-urlencoded' }
  };
  let url = STRIPE_API + pathname;
  if ((method === 'GET' || method === 'DELETE') && params) url += '?' + encodeForm(params);
  else if (params) opts.body = encodeForm(params);
  const r = await fetch(url, opts);
  const data = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || ('Stripe error ' + r.status));
    err.status = r.status;
    err.stripe = true;
    throw err;
  }
  return data;
}

function readRaw(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readBody(req, limit) {
  return (await readRaw(req, limit)).toString('utf8');
}
async function readJson(req, limit) {
  try { return JSON.parse((await readBody(req, limit)) || '{}') || {}; } catch (e) { return null; }
}

function hostOf(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}
// Which site this request is for: the admin subdomain, the public domain, or anything else (onrender.com, localhost).
function siteOf(req) {
  const h = hostOf(req);
  if (h === ADMIN_HOST) return 'admin';
  if (PUBLIC_HOSTS.indexOf(h) >= 0) return 'public';
  return 'other';
}
// Origin used for links we email. SITE_URL wins; links made from the admin subdomain use the public domain;
// otherwise the address this request came in on.
function originOf(req) {
  if (SITE_URL) return SITE_URL;
  if (siteOf(req) === 'admin') return 'https://' + PUBLIC_DOMAIN;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

// Allow API calls only from our own pages.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin GETs may omit Origin
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

// Tiny in-memory rate limiter: N requests per minute per IP and bucket.
const hits = new Map();
function limited(req, max, bucket) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = (bucket || 'api') + ':' + ip;
  const now = Date.now(); const windowStart = now - 60000;
  const list = (hits.get(key) || []).filter(function (t) { return t > windowStart; });
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$/;
const INVOICE_ID_RE = /^in_[A-Za-z0-9]{8,64}$/;

// ---------- signed invoice links ----------
// Anyone with the link can view and pay that one invoice (same model as Stripe's hosted invoice links),
// but links can't be guessed or altered.
function invoiceSig(id) {
  return crypto.createHmac('sha256', LINK_KEY).update('invoice:' + id).digest('base64url').slice(0, 32);
}
function invoicePath(id) {
  return '/pay/invoice/?i=' + encodeURIComponent(id) + '&k=' + invoiceSig(id);
}
function validInvoiceLink(id, k) {
  return INVOICE_ID_RE.test(id || '') && typeof k === 'string' && safeEqual(k, invoiceSig(id));
}

function money(cents, currency) {
  if (typeof cents !== 'number') return '';
  const s = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (String(currency || 'usd').toLowerCase() === 'usd' ? '$' + s : s + ' ' + String(currency).toUpperCase());
}
function dateText(sec) {
  if (!sec) return '';
  return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

// ---------- public payment API ----------
function config(req, res) {
  json(res, 200, {
    enabled: Boolean(SECRET && PUBLISHABLE),
    publishableKey: PUBLISHABLE || null,
    testMode: /^pk_test_/.test(PUBLISHABLE),
    portalUrl: PORTAL_URL,
    paymentMethodTypes: PAYMENT_METHOD_TYPES
  });
}

async function invoiceLines(inv) {
  if (!inv.lines) return [];
  let lines = inv.lines.data || [];
  if (inv.lines.has_more) {
    const all = await stripe('GET', '/v1/invoices/' + encodeURIComponent(inv.id) + '/lines', { limit: 100 });
    lines = all.data || lines;
  }
  return lines.map(function (l) {
    return { description: l.description || '', quantity: l.quantity || 1, amount: l.amount };
  });
}

// The fields a client may see. Never the customer id, metadata or internal notes.
async function publicInvoice(inv) {
  const payable = inv.status === 'open' && inv.amount_remaining > 0 && inv.confirmation_secret && inv.confirmation_secret.client_secret;
  return {
    number: inv.number || '',
    status: inv.status,
    currency: inv.currency,
    subtotal: inv.subtotal,
    tax: typeof inv.total_excluding_tax === 'number' ? inv.total - inv.total_excluding_tax : 0,
    total: inv.total,
    amount_paid: inv.amount_paid,
    amount_remaining: inv.amount_remaining,
    issued: dateText(inv.effective_at || inv.created),
    due: dateText(inv.due_date),
    customer_name: inv.customer_name || '',
    customer_email: inv.customer_email || '',
    memo: inv.description || '',
    lines: await invoiceLines(inv),
    pdf: inv.invoice_pdf || null,
    clientSecret: payable ? inv.confirmation_secret.client_secret : null
  };
}

async function getInvoice(req, res, url) {
  if (!SECRET) return json(res, 503, { error: 'Payments are not configured yet.' });
  if (limited(req, 60, 'invoice')) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });
  const id = url.searchParams.get('i') || ''; const k = url.searchParams.get('k') || '';
  if (!validInvoiceLink(id, k)) return json(res, 404, { error: 'We couldn’t find that invoice. Check the link in your email.' });
  try {
    const inv = await stripe('GET', '/v1/invoices/' + encodeURIComponent(id), { expand: ['confirmation_secret'] });
    if (inv.status === 'draft') return json(res, 404, { error: 'This invoice isn’t ready yet.' });
    return json(res, 200, await publicInvoice(inv));
  } catch (e) {
    console.error('invoice_get_failed', e.status, e.message);
    return json(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'We couldn’t find that invoice.' : 'We couldn’t load your invoice. Please try again.' });
  }
}

async function lookupInvoice(req, res) {
  if (!SECRET) return json(res, 503, { error: 'Payments are not configured yet.' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 10, 'lookup')) return json(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
  const body = await readJson(req, 2048);
  if (!body) return json(res, 400, { error: 'Invalid request.' });
  const number = clip(body.number, 40).toUpperCase();
  const email = clip(body.email, 200).toLowerCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(number)) return json(res, 400, { error: 'Enter the invoice number exactly as it appears on your invoice.' });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter the email address the invoice was sent to.' });
  const notFound = { error: 'We couldn’t find an invoice with that number and email. Check both, or email hello@aetheradigital.com.' };
  try {
    const found = await stripe('GET', '/v1/invoices/search', { query: 'number:"' + number + '"', limit: 5 });
    const inv = (found.data || []).find(function (x) {
      return x.status !== 'draft' && String(x.number || '').toUpperCase() === number && String(x.customer_email || '').toLowerCase() === email;
    });
    if (!inv) return json(res, 404, notFound);
    return json(res, 200, { url: invoicePath(inv.id) });
  } catch (e) {
    console.error('invoice_lookup_failed', e.status, e.message);
    return json(res, 502, { error: 'Lookup isn’t available right now. Please use the link in your invoice email.' });
  }
}

async function findOrCreateCustomer(email, name, company, source) {
  const existing = await stripe('GET', '/v1/customers', { email: email, limit: 1 });
  const found = existing.data && existing.data[0];
  if (found) {
    // Keep the customer record current: the name and business entered now win over old details.
    const display = company || name;
    if (display && (display !== found.name || (name && (found.metadata || {}).contact_name !== name))) {
      return stripe('POST', '/v1/customers/' + found.id, {
        name: display,
        metadata: { contact_name: name || (found.metadata || {}).contact_name || '', company: company || (found.metadata || {}).company || '' }
      });
    }
    return found;
  }
  return stripe('POST', '/v1/customers', {
    email: email,
    name: company || name || undefined,
    metadata: { contact_name: name || '', company: company || '', source: source }
  });
}

async function subscribe(req, res) {
  if (!SECRET || !PUBLISHABLE) return json(res, 503, { error: 'Payments are not configured yet.' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 8, 'subscribe')) return json(res, 429, { error: 'Too many attempts. Please wait a minute.' });
  const body = await readJson(req, 4096);
  if (!body) return json(res, 400, { error: 'Invalid request.' });
  const email = clip(body.email, 200).toLowerCase();
  const name = clip(body.name, 120);
  const company = clip(body.company, 120);
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter a valid email address.', field: 'email' });
  if (!name) return json(res, 400, { error: 'Enter your name.', field: 'name' });
  if (!company) return json(res, 400, { error: 'Enter your business name.', field: 'company' });
  try {
    const customer = await findOrCreateCustomer(email, name, company, 'aethera_partnership');
    const sub = await stripe('POST', '/v1/subscriptions', {
      customer: customer.id,
      items: PARTNERSHIP_PRICES.map(function (price) { return { price: price, quantity: 1 }; }),
      payment_behavior: 'default_incomplete',
      payment_settings: { payment_method_types: PAYMENT_METHOD_TYPES, save_default_payment_method: 'on_subscription' },
      automatic_tax: AUTOMATIC_TAX ? { enabled: true } : undefined,
      description: 'Aethera Digital Startup Partnership (month-to-month)',
      metadata: { plan: 'startup_partnership', source: 'aethera_pay_page', contact_name: name, company: company },
      expand: ['latest_invoice.confirmation_secret']
    });
    const cs = sub.latest_invoice && sub.latest_invoice.confirmation_secret;
    if (!cs || !cs.client_secret) throw new Error('No confirmation secret on first invoice');
    return json(res, 200, { clientSecret: cs.client_secret });
  } catch (e) {
    console.error('subscribe_failed', e.status, e.message);
    return json(res, 502, { error: 'We couldn’t start your partnership checkout. Please try again or email hello@aetheradigital.com.' });
  }
}

// ---------- admin ----------
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionSig(exp) { return crypto.createHmac('sha256', ADMIN_KEY).update('s:' + exp).digest('base64url'); }
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const v = parseCookies(req)[ADMIN_COOKIE] || '';
  const dot = v.indexOf('.');
  if (dot < 1) return false;
  const exp = v.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(v.slice(dot + 1), sessionSig(exp));
}
function adminCookie(req, value, maxAge) {
  const secure = SITE_URL.startsWith('https:') || /https/.test(String(req.headers['x-forwarded-proto'] || ''));
  return ADMIN_COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}

async function adminLogin(req, res) {
  if (!ADMIN_PASSWORD) return json(res, 503, { error: 'Admin is not set up yet. Add ADMIN_PASSWORD in Render.' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 8, 'login')) return json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
  const body = await readJson(req, 1024);
  const pass = body && typeof body.password === 'string' ? body.password : '';
  const a = crypto.createHash('sha256').update(pass).digest('hex');
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  if (!safeEqual(a, b)) {
    console.warn('admin_login_failed');
    return json(res, 401, { error: 'That password isn’t right.' });
  }
  const exp = String(Math.floor(Date.now() / 1000) + ADMIN_SESSION_SEC);
  return json(res, 200, { ok: true }, { 'Set-Cookie': adminCookie(req, exp + '.' + sessionSig(exp), ADMIN_SESSION_SEC) });
}
function adminLogout(req, res) {
  return json(res, 200, { ok: true }, { 'Set-Cookie': adminCookie(req, '', 0) });
}

function adminRow(inv, origin) {
  const md = inv.metadata || {};
  return {
    id: inv.id,
    number: inv.number || '',
    status: inv.status,
    customer_name: inv.customer_name || '',
    customer_email: inv.customer_email || '',
    total: inv.total,
    amount_remaining: inv.amount_remaining,
    currency: inv.currency,
    created: inv.created,
    due_date: inv.due_date,
    subscription: Boolean(inv.parent && inv.parent.subscription_details),
    emailed_at: md.emailed_at || '',
    pay_url: inv.status === 'open' || inv.status === 'paid' ? origin + invoicePath(inv.id) : null,
    stripe_url: 'https://dashboard.stripe.com/' + (inv.livemode ? '' : 'test/') + 'invoices/' + inv.id
  };
}

async function adminList(req, res, url) {
  const email = clip(url.searchParams.get('email'), 200).toLowerCase();
  if (email) return json(res, 200, { invoices: await stripeInvoicesFor(email, originOf(req)), testMode: /^sk_test_|^rk_test_/.test(SECRET) });
  const params = { limit: 50 };
  const st = url.searchParams.get('status');
  if (['draft', 'open', 'paid', 'void', 'uncollectible'].indexOf(st) >= 0) params.status = st;
  const list = await stripe('GET', '/v1/invoices', params);
  const origin = originOf(req);
  return json(res, 200, { invoices: (list.data || []).map(function (inv) { return adminRow(inv, origin); }), testMode: /^sk_test_|^rk_test_/.test(SECRET) });
}

async function sendInvoiceEmail(inv, origin) {
  const url = origin + invoicePath(inv.id);
  if (NOTIFY_URL) {
    const body = new URLSearchParams({
      kind: 'invoice_email', token: NOTIFY_TOKEN,
      to: inv.customer_email || '', name: inv.customer_name || '', number: inv.number || '',
      amount: money(inv.amount_remaining, inv.currency), due: dateText(inv.due_date), memo: inv.description || '',
      url: url, livemode: String(Boolean(inv.livemode))
    });
    const r = await fetch(NOTIFY_URL, {
      method: 'POST', body: body, redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000)
    });
    const out = await r.json().catch(function () { return {}; });
    if (!r.ok || out.ok !== true) throw new Error('invoice email failed: ' + r.status + ' ' + (out.error || ''));
    await stripe('POST', '/v1/invoices/' + inv.id, { metadata: { emailed_at: new Date().toISOString(), emailed_via: 'aethera' } });
    return 'aethera';
  }
  // No Apps Script configured: fall back to Stripe's own invoice email (links to Stripe's hosted page).
  await stripe('POST', '/v1/invoices/' + inv.id + '/send');
  await stripe('POST', '/v1/invoices/' + inv.id, { metadata: { emailed_at: new Date().toISOString(), emailed_via: 'stripe' } });
  return 'stripe';
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 25) return null;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const description = clip(it.description, 250);
    const quantity = Number(it.quantity);
    const cents = Math.round(Number(String(it.unit_amount).replace(/[$,\s]/g, '')) * 100);
    if (!description || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
    if (!Number.isFinite(cents) || cents < 1 || cents > 10000000) return null;
    out.push({ description: description, quantity: quantity, cents: cents });
  }
  return out;
}

async function adminCreate(req, res) {
  const body = await readJson(req, 32768);
  if (!body) return json(res, 400, { error: 'Invalid request.' });
  const email = clip(body.email, 200).toLowerCase();
  const name = clip(body.name, 120);
  const company = clip(body.company, 120);
  const memo = clip(body.memo, 500);
  const days = Number(body.days_until_due);
  const items = parseItems(body.items);
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter the client’s email address.', field: 'email' });
  if (!name && !company) return json(res, 400, { error: 'Enter a client or business name.', field: 'name' });
  if (!items) return json(res, 400, { error: 'Each line needs a description, a whole-number quantity and a price.', field: 'items' });
  if (!Number.isInteger(days) || days < 1 || days > 90) return json(res, 400, { error: 'Choose when the invoice is due.', field: 'days_until_due' });
  const total = items.reduce(function (s, it) { return s + it.cents * it.quantity; }, 0);
  if (total < 50) return json(res, 400, { error: 'The invoice total must be at least $0.50.', field: 'items' });

  let invoice = null;
  try {
    const customer = await findOrCreateCustomer(email, name, company, 'aethera_admin');
    invoice = await stripe('POST', '/v1/invoices', {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: days,
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      description: memo || undefined,
      footer: 'Aethera Digital · aetheradigital.com · hello@aetheradigital.com',
      payment_settings: { payment_method_types: PAYMENT_METHOD_TYPES },
      automatic_tax: AUTOMATIC_TAX ? { enabled: true } : undefined,
      metadata: { source: 'aethera_admin', contact_name: name, company: company }
    });
    for (const it of items) {
      await stripe('POST', '/v1/invoiceitems', {
        customer: customer.id, invoice: invoice.id, currency: 'usd',
        description: it.description, quantity: it.quantity, unit_amount_decimal: String(it.cents)
      });
    }
    invoice = await stripe('POST', '/v1/invoices/' + invoice.id + '/finalize', { auto_advance: false });
  } catch (e) {
    console.error('admin_invoice_create_failed', e.status, e.message);
    if (invoice && invoice.status === 'draft') {
      await stripe('DELETE', '/v1/invoices/' + invoice.id).catch(function () {});
    }
    return json(res, 502, { error: 'Stripe couldn’t create the invoice: ' + e.message });
  }

  const origin = originOf(req);
  let emailedVia = null; let emailError = null;
  if (body.send !== false) {
    try { emailedVia = await sendInvoiceEmail(invoice, origin); } catch (e) {
      console.error('admin_invoice_email_failed', e.message);
      emailError = 'The invoice was created, but the email didn’t send. Use Resend or copy the link.';
    }
  }
  console.log('admin_invoice_created ' + JSON.stringify({ id: invoice.id, number: invoice.number, total: invoice.total, emailed: emailedVia }));
  return json(res, 200, { invoice: adminRow(invoice, origin), emailed_via: emailedVia, email_error: emailError });
}

async function adminAction(req, res, id, action) {
  if (!INVOICE_ID_RE.test(id)) return json(res, 400, { error: 'Invalid invoice.' });
  const origin = originOf(req);
  try {
    let inv = await stripe('GET', '/v1/invoices/' + id);
    if (action === 'send') {
      if (inv.status !== 'open') return json(res, 400, { error: 'Only open invoices can be emailed.' });
      const via = await sendInvoiceEmail(inv, origin);
      inv = await stripe('GET', '/v1/invoices/' + id);
      return json(res, 200, { invoice: adminRow(inv, origin), emailed_via: via });
    }
    if (action === 'void') {
      if (inv.status !== 'open') return json(res, 400, { error: 'Only open invoices can be voided.' });
      inv = await stripe('POST', '/v1/invoices/' + id + '/void');
      return json(res, 200, { invoice: adminRow(inv, origin) });
    }
    if (action === 'mark-paid') {
      if (inv.status !== 'open') return json(res, 400, { error: 'Only open invoices can be marked paid.' });
      inv = await stripe('POST', '/v1/invoices/' + id + '/pay', { paid_out_of_band: true });
      return json(res, 200, { invoice: adminRow(inv, origin) });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('admin_invoice_action_failed', action, e.status, e.message);
    return json(res, 502, { error: e.stripe ? 'Stripe: ' + e.message : 'That didn’t work. Please try again.' });
  }
}

// ---------- Aethera Desk (clients, projects, checklists, files, approvals, reports) ----------
const deskLib = require('./lib/desk');
const desk = deskLib.createStore(process.env.DATABASE_URL || '');
let deskReady = null;
function deskInit() {
  if (!deskReady) deskReady = desk.init().catch(function (e) { deskReady = null; throw e; });
  return deskReady;
}
const MAX_FILE_BYTES = 15 * 1024 * 1024;

async function stripeInvoicesFor(email, origin) {
  if (!SECRET || !email) return [];
  const customers = await stripe('GET', '/v1/customers', { email: String(email).trim().toLowerCase(), limit: 10 });
  const out = [];
  for (const c of customers.data || []) {
    const list = await stripe('GET', '/v1/invoices', { customer: c.id, limit: 50 });
    (list.data || []).forEach(function (inv) { out.push(adminRow(inv, origin)); });
  }
  return out.sort(function (a, b) { return b.created - a.created; });
}

async function deskOverview(req, res) {
  const clients = await desk.allOf('client');
  const projects = await desk.allOf('project');
  const tasks = await desk.allOf('task');
  const approvals = await desk.allOf('approval');
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const byId = {}; clients.forEach(function (c) { byId[c.id] = c; });
  const projById = {}; projects.forEach(function (p) { projById[p.id] = p; });
  const status = {}; deskLib.CLIENT_STATUS.forEach(function (s) { status[s] = 0; });
  clients.forEach(function (c) { status[c.status || 'lead'] = (status[c.status || 'lead'] || 0) + 1; });
  const active = clients.filter(function (c) { return c.status === 'active'; });
  const openTasks = tasks.filter(function (t) { return !t.done && t.due; });
  const name = function (cid) { return byId[cid] ? (byId[cid].company || byId[cid].name) : ''; };
  const out = {
    store: desk.kind,
    pipeline: status,
    active_clients: active.length,
    monthly_recurring: active.reduce(function (s, c) { return s + (Number(c.monthly_value) || 0); }, 0),
    projects_open: projects.filter(function (p) { return p.status !== 'done'; }).length,
    tasks_due: openTasks.filter(function (t) { return t.due <= week; }).sort(function (a, b) { return a.due < b.due ? -1 : 1; }).slice(0, 12).map(function (t) {
      const pr = projById[t.project_id] || {};
      return { id: t.id, title: t.title, due: t.due, overdue: t.due < today, owner: t.owner || '', project_id: t.project_id, project: pr.name || '', client_id: t.client_id, client: name(t.client_id) };
    }),
    approvals_pending: approvals.filter(function (a) { return (a.status || 'pending') === 'pending'; }).map(function (a) {
      return { id: a.id, title: a.title, kind: a.kind || 'approval', requested: a.requested || '', client_id: a.client_id, client: name(a.client_id) };
    }),
    follow_ups: clients.filter(function (c) { return c.next_date && c.status !== 'past'; }).sort(function (a, b) { return a.next_date < b.next_date ? -1 : 1; }).slice(0, 8).map(function (c) {
      return { id: c.id, client: c.company || c.name, next_step: c.next_step || '', next_date: c.next_date, overdue: c.next_date < today, status: c.status };
    }),
    leads: (await desk.allOf('lead')).filter(function (x) { return x.status === 'new'; }).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }),
    suggestions: (await desk.allOf('suggestion')).filter(function (x) { return x.status === 'new'; })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 12)
      .map(function (x) { return Object.assign({}, x, { client: name(x.client_id) }); }),
    billing: null
  };
  if (SECRET) {
    try {
      const list = await stripe('GET', '/v1/invoices', { limit: 100 });
      const now = Date.now() / 1000; const monthAgo = now - 30 * 86400;
      const inv = list.data || [];
      const open = inv.filter(function (i) { return i.status === 'open'; });
      out.billing = {
        open_count: open.length,
        open_total: open.reduce(function (s, i) { return s + i.amount_remaining; }, 0),
        overdue_count: open.filter(function (i) { return i.due_date && i.due_date < now; }).length,
        paid_30d: inv.filter(function (i) { return i.status === 'paid' && i.status_transitions && i.status_transitions.paid_at >= monthAgo; }).reduce(function (s, i) { return s + i.amount_paid; }, 0),
        test_mode: /^sk_test_|^rk_test_/.test(SECRET)
      };
    } catch (e) { console.error('desk_overview_billing_failed', e.message); }
  }
  return json(res, 200, out);
}

async function deskApi(req, res, url) {
  try { await deskInit(); } catch (e) {
    console.error('desk_db_unavailable', e.message);
    return json(res, 503, { error: 'The Desk database is unavailable right now.' });
  }
  const p = url.pathname.replace(/^\/api\/admin\/desk/, '') || '/';
  const m = req.method;
  if (p === '/meta' && m === 'GET') {
    const templates = {}; Object.keys(deskLib.TEMPLATES).forEach(function (k) { templates[k] = { label: deskLib.TEMPLATES[k].label, count: deskLib.TEMPLATES[k].tasks.length }; });
    return json(res, 200, { store: desk.kind, templates: templates, services: deskLib.SERVICES, client_status: deskLib.CLIENT_STATUS, project_status: deskLib.PROJECT_STATUS, approval_status: deskLib.APPROVAL_STATUS, approval_kind: deskLib.APPROVAL_KIND, file_category: deskLib.FILE_CATEGORY, metrics: deskLib.METRICS });
  }
  if (p === '/overview' && m === 'GET') return deskOverview(req, res);

  // client profile with everything attached
  let mm = p.match(/^\/clients\/([a-z]{3}_[A-Za-z0-9_-]+)\/full$/);
  if (mm && m === 'GET') {
    const c = await desk.get('client', mm[1]);
    if (!c) return json(res, 404, { error: 'Client not found.' });
    const [projects, tasks, approvals, reports, files, suggestions] = await Promise.all([
      desk.list('project', { client_id: c.id }), desk.list('task', { client_id: c.id }), desk.list('approval', { client_id: c.id }),
      desk.list('report', { client_id: c.id }), desk.listFiles(c.id), desk.list('suggestion', { client_id: c.id })]);
    let invoices = []; let invoiceError = null;
    try { invoices = await stripeInvoicesFor(c.email, originOf(req)); } catch (e) { invoiceError = 'Couldn’t load invoices from Stripe.'; }
    return json(res, 200, { client: c, suggestions: suggestions.filter(function (x) { return x.status === 'new'; }).reverse(), projects: projects, tasks: tasks, approvals: approvals, reports: reports.sort(function (a, b) { return a.period < b.period ? 1 : -1; }), files: files, invoices: invoices, invoice_error: invoiceError });
  }

  // apply a checklist template to a project
  mm = p.match(/^\/projects\/([a-z]{3}_[A-Za-z0-9_-]+)\/checklist$/);
  if (mm && m === 'POST') {
    const body = await readJson(req, 2048);
    const tpl = body && deskLib.TEMPLATES[body.template];
    if (!tpl) return json(res, 400, { error: 'Choose a checklist.' });
    const pr = await desk.get('project', mm[1]);
    if (!pr) return json(res, 404, { error: 'Project not found.' });
    const existing = await desk.list('task', { project_id: pr.id });
    const created = [];
    for (let i = 0; i < tpl.tasks.length; i++) {
      created.push(await desk.create('task', { title: tpl.tasks[i], done: false, position: existing.length + i, project_id: pr.id }, { client_id: pr.client_id, project_id: pr.id }));
    }
    return json(res, 200, { tasks: created });
  }

  // suggested to-dos
  mm = p.match(/^\/suggestions\/(sug_[A-Za-z0-9_-]+)\/accept$/);
  if (mm && m === 'POST') return acceptSuggestion(req, res, mm[1]);
  mm = p.match(/^\/leads\/(lea_[A-Za-z0-9_-]+)\/accept$/);
  if (mm && m === 'POST') return acceptLead(req, res, mm[1]);
  if (p === '/collector' && m === 'GET') return collectorStatus(req, res);

  // files
  if (p === '/files' && m === 'POST') {
    const cid = url.searchParams.get('client_id') || '';
    const client = /^cli_/.test(cid) ? await desk.get('client', cid) : null;
    if (!client) return json(res, 400, { error: 'Choose a client.' });
    const category = deskLib.FILE_CATEGORY.indexOf(url.searchParams.get('category')) >= 0 ? url.searchParams.get('category') : 'other';
    const name = clip(url.searchParams.get('name') || 'file', 200).replace(/[\\/\0\r\n"]/g, '_');
    let content;
    try { content = await readRaw(req, MAX_FILE_BYTES); } catch (e) { return json(res, 413, { error: 'Files can be up to 15 MB.' }); }
    if (!content.length) return json(res, 400, { error: 'That file is empty.' });
    const mime = clip(String(req.headers['content-type'] || 'application/octet-stream').split(';')[0], 100);
    return json(res, 200, { file: await desk.putFile({ client_id: client.id, name: name, mime: mime, category: category, content: content }) });
  }
  mm = p.match(/^\/files\/(fil_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'GET') {
    const f = await desk.getFile(mm[1]);
    if (!f) return json(res, 404, { error: 'File not found.' });
    return send(res, 200, f.content, {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="' + String(f.name).replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name)
    });
  }
  if (mm && m === 'DELETE') { await desk.removeFile(mm[1]); return json(res, 200, { ok: true }); }

  // generic records: /clients, /projects, /tasks, /approvals, /reports (+ /:id)
  mm = p.match(/^\/(clients|projects|tasks|approvals|reports|suggestions|leads)(?:\/([a-z]{3}_[A-Za-z0-9_-]+))?$/);
  if (!mm) return json(res, 404, { error: 'Not found' });
  const type = deskLib.PLURAL[mm[1]]; const id = mm[2];
  if (!id && m === 'GET') {
    const where = {};
    if (url.searchParams.get('client_id')) where.client_id = url.searchParams.get('client_id');
    if (url.searchParams.get('project_id')) where.project_id = url.searchParams.get('project_id');
    return json(res, 200, { items: await desk.list(type, where) });
  }
  if (!id && m === 'POST') {
    const body = await readJson(req, 65536);
    const v = deskLib.validate(type, body, false);
    if (v.error) return json(res, 400, { error: v.error });
    const links = {};
    if (type === 'client') { v.data.status = v.data.status || 'lead'; }
    else if (type === 'lead') { v.data.status = v.data.status || 'new'; }
    else if (deskLib.SCHEMA[type].parent === 'client') {
      if (!(await desk.get('client', v.data.client_id))) return json(res, 400, { error: 'Client not found.' });
      links.client_id = v.data.client_id;
    } else if (type === 'task') {
      const pr = await desk.get('project', v.data.project_id);
      if (!pr) return json(res, 400, { error: 'Project not found.' });
      links.project_id = pr.id; links.client_id = pr.client_id;
    }
    if (type === 'project') v.data.status = v.data.status || 'planned';
    if (type === 'approval') { v.data.status = v.data.status || 'pending'; v.data.kind = v.data.kind || 'approval'; v.data.requested = v.data.requested || new Date().toISOString().slice(0, 10); }
    if (type === 'task' && v.data.done === undefined) v.data.done = false;
    if (type === 'report') {
      const dup = (await desk.list('report', { client_id: v.data.client_id })).find(function (r) { return r.period === v.data.period; });
      if (dup) return json(res, 409, { error: 'There’s already a report for that month. Open it to edit.' });
    }
    return json(res, 200, { item: await desk.create(type, v.data, links) });
  }
  if (id && m === 'GET') {
    const item = await desk.get(type, id);
    return item ? json(res, 200, { item: item }) : json(res, 404, { error: 'Not found.' });
  }
  if (id && m === 'PATCH') {
    const body = await readJson(req, 65536);
    if (body) { delete body.client_id; delete body.project_id; }
    const v = deskLib.validate(type, body, true);
    if (v.error) return json(res, 400, { error: v.error });
    const item = await desk.update(type, id, v.data);
    return item ? json(res, 200, { item: item }) : json(res, 404, { error: 'Not found.' });
  }
  if (id && m === 'DELETE') { await desk.remove(type, id); return json(res, 200, { ok: true }); }
  return json(res, 405, { error: 'Method not allowed' });
}

// ---------- Suggested to-dos: Apps Script collector -> Claude -> Desk ----------
const collectorLib = require('./lib/collector');
const COLLECTOR_TOKEN = process.env.DESK_COLLECTOR_TOKEN || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const ANTHROPIC_BASE = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
const ingestQueue = [];
let ingesting = false;
const collectorRuns = new Map(); // by -> { at, received, queued }
const ingestStats = { processed: 0, suggestions: 0, errors: 0, lastError: '' };

function collectorAuthorized(req) {
  const h = String(req.headers.authorization || '');
  return Boolean(COLLECTOR_TOKEN) && h.startsWith('Bearer ') && safeEqual(h.slice(7), COLLECTOR_TOKEN);
}

async function processIngest() {
  if (ingesting) return;
  ingesting = true;
  try {
    while (ingestQueue.length) {
      const job = ingestQueue.shift();
      try {
        const n = await ingestOne(job);
        ingestStats.processed++; ingestStats.suggestions += n;
      } catch (e) {
        ingestStats.errors++; ingestStats.lastError = e.message;
        console.error('collector_ingest_failed', job.item.key, e.message);
      }
    }
  } finally { ingesting = false; }
}

async function ingestOne(job) {
  const item = job.item;
  if (await desk.seen(item.key)) return 0;
  const clients = (await desk.allOf('client')).filter(function (c) { return c.status !== 'past'; });
  const candidates = collectorLib.matchClients(item, clients);
  if (!candidates.length) {
    // From the hello@ inbox: a sender we don't know may be a new prospect.
    if (item.lead) return ingestLead(job);
    // Not tied to a Desk client (yet): don't mark it seen, so it's picked up if that client is added later. No AI call is made.
    return 0;
  }
  const found = await collectorLib.extract(item, candidates, { model: ANTHROPIC_MODEL, apiKey: ANTHROPIC_KEY, apiBase: ANTHROPIC_BASE, today: new Date().toISOString().slice(0, 10) });
  let created = 0;
  for (const s of found) {
    const existing = (await desk.list('suggestion', { client_id: s.client_id }))
      .some(function (x) { return x.status === 'new' && collectorLib.norm(x.title) === collectorLib.norm(s.title); });
    if (existing) continue;
    const v = deskLib.validate('suggestion', {
      client_id: s.client_id, title: s.title, due: s.due, owner: s.owner, evidence: s.evidence, status: 'new',
      source: item.kind === 'meeting' ? 'meeting' : 'email', source_url: item.url, source_title: item.title, source_date: item.date,
      source_key: item.key, collected_by: job.by
    }, false);
    if (v.error) continue;
    await desk.create('suggestion', v.data, { client_id: s.client_id });
    created++;
  }
  await desk.markSeen(item.key);
  console.log('collector_ingested ' + JSON.stringify({ key: item.key, kind: item.kind, clients: candidates.length, suggestions: created }));
  return created;
}

async function ingestLead(job) {
  const item = job.item;
  const lead = await collectorLib.screenLead(item, deskLib.SERVICES, { model: ANTHROPIC_MODEL, apiKey: ANTHROPIC_KEY, apiBase: ANTHROPIC_BASE, today: new Date().toISOString().slice(0, 10) });
  await desk.markSeen(item.key);
  if (!lead) { console.log('collector_not_a_lead ' + JSON.stringify({ key: item.key })); return 0; }
  if (lead.email) {
    const known = (await desk.allOf('client')).some(function (c) { return (c.email || '').toLowerCase() === lead.email; }) ||
      (await desk.allOf('lead')).some(function (l) { return (l.email || '').toLowerCase() === lead.email && l.status !== 'dismissed'; });
    if (known) return 0;
  }
  const v = deskLib.validate('lead', Object.assign({}, lead, {
    status: 'new', source: 'email', source_url: item.url, source_title: item.title, source_date: item.date, source_key: item.key, collected_by: job.by
  }), false);
  if (v.error) { console.warn('collector_lead_invalid', v.error); return 0; }
  await desk.create('lead', v.data, {});
  console.log('collector_new_lead ' + JSON.stringify({ key: item.key, name: v.data.name }));
  return 1;
}

async function acceptLead(req, res, id) {
  const l = await desk.get('lead', id);
  if (!l) return json(res, 404, { error: 'Lead not found.' });
  if (l.status !== 'new') return json(res, 409, { error: 'That lead was already handled.' });
  const body = (await readJson(req, 4096)) || {};
  const status = deskLib.CLIENT_STATUS.indexOf(body.status) >= 0 ? body.status : 'lead';
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const notes = [l.summary, l.source_url ? 'Source: ' + (l.source_title || 'email') + ' (' + l.source_url + ')' : ''].filter(Boolean).join('\n\n');
  const v = deskLib.validate('client', { name: l.name, company: l.company || '', email: l.email || '', phone: l.phone || '', website: l.website || '',
    services: l.services || [], status: status, source: /website inquiry/i.test(l.source_title || '') ? 'Website form' : 'Email (hello@)',
    next_step: l.next_step || 'Reply to book a discovery call', next_date: tomorrow, notes: notes }, false);
  if (v.error) return json(res, 400, { error: v.error });
  const client = await desk.create('client', v.data, {});
  const updated = await desk.update('lead', l.id, { status: 'added', client_id: client.id });
  return json(res, 200, { lead: updated, client: client });
}

async function collectorApi(req, res, url) {
  if (!COLLECTOR_TOKEN) return json(res, 503, { error: 'Collector is not set up (DESK_COLLECTOR_TOKEN).' });
  if (!collectorAuthorized(req)) { console.warn('collector_unauthorized'); return json(res, 401, { error: 'Unauthorized' }); }
  try { await deskInit(); } catch (e) { return json(res, 503, { error: 'Desk database unavailable.' }); }
  const p = url.pathname;
  if (p === '/api/collector/clients' && req.method === 'GET') {
    return json(res, 200, { clients: collectorLib.collectorClients(await desk.allOf('client')), ai: Boolean(ANTHROPIC_KEY) });
  }
  if (p === '/api/collector/items' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) return json(res, 503, { error: 'ANTHROPIC_API_KEY is not set on the server.' });
    const body = await readJson(req, 2 * 1024 * 1024);
    if (!body || !Array.isArray(body.items)) return json(res, 400, { error: 'Invalid request.' });
    const by = clip(body.by, 200).toLowerCase() || 'unknown';
    let queued = 0; let skipped = 0;
    for (const raw of body.items.slice(0, 100)) {
      const item = {
        kind: raw.kind === 'meeting' ? 'meeting' : 'email',
        key: clip(raw.key, 300), url: /^https:\/\//.test(String(raw.url || '')) ? clip(raw.url, 500) : '',
        title: clip(raw.title, 300), date: clip(raw.date, 40), from: clip(raw.from, 1000), to: clip(raw.to, 2000), cc: clip(raw.cc, 2000),
        attendees: clip(raw.attendees, 2000), reply_to: clip(raw.reply_to, 300), lead: raw.lead === true,
        text: String(raw.text || '').slice(0, 20000)
      };
      if (!item.key || !item.text) { skipped++; continue; }
      if (await desk.seen(item.key) || ingestQueue.some(function (j) { return j.item.key === item.key; })) { skipped++; continue; }
      ingestQueue.push({ item: item, by: by }); queued++;
    }
    collectorRuns.set(by, { by: by, at: new Date().toISOString(), received: body.items.length, queued: queued });
    setImmediate(processIngest);
    return json(res, 200, { ok: true, queued: queued, skipped: skipped });
  }
  return json(res, 404, { error: 'Not found' });
}

async function acceptSuggestion(req, res, id) {
  const s = await desk.get('suggestion', id);
  if (!s) return json(res, 404, { error: 'Suggestion not found.' });
  if (s.status !== 'new') return json(res, 409, { error: 'That suggestion was already handled.' });
  const body = (await readJson(req, 4096)) || {};
  let project = null;
  if (body.project_id) {
    project = await desk.get('project', String(body.project_id));
    if (!project || project.client_id !== s.client_id) return json(res, 400, { error: 'Choose one of this client’s projects.' });
  } else {
    const projects = await desk.list('project', { client_id: s.client_id });
    project = projects.find(function (p) { return String(p.name || '').toLowerCase() === 'general to-dos'; });
    if (project && project.name !== 'General To-Dos') project = (await desk.update('project', project.id, { name: 'General To-Dos' })) || project;
    project = project ||
      await desk.create('project', { client_id: s.client_id, name: 'General To-Dos', status: 'in_progress', description: 'Follow-ups from email and meetings.' }, { client_id: s.client_id });
  }
  const title = clip(body.title || s.title, 300);
  const task = await desk.create('task', { project_id: project.id, title: title, done: false, due: s.due || null, owner: s.owner || null, position: Date.now() / 1e3 },
    { client_id: s.client_id, project_id: project.id });
  const updated = await desk.update('suggestion', s.id, { status: 'added', task_id: task.id });
  return json(res, 200, { suggestion: updated, task: task, project: { id: project.id, name: project.name } });
}

function collectorStatus(req, res) {
  return json(res, 200, {
    token: Boolean(COLLECTOR_TOKEN), ai: Boolean(ANTHROPIC_KEY), model: ANTHROPIC_MODEL,
    runs: Array.from(collectorRuns.values()), queue: ingestQueue.length + (ingesting ? 1 : 0), stats: ingestStats
  });
}

async function adminApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/admin/login' && req.method === 'POST') return adminLogin(req, res);
  if (p === '/api/admin/logout' && req.method === 'POST') return adminLogout(req, res);
  if (p === '/api/admin/me' && req.method === 'GET') return json(res, 200, { admin: isAdmin(req), configured: Boolean(ADMIN_PASSWORD), payments: Boolean(SECRET) });
  if (!isAdmin(req)) return json(res, 401, { error: 'Please sign in.' });
  if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (p.startsWith('/api/admin/desk/')) {
    try { return await deskApi(req, res, url); } catch (e) {
      console.error('desk_failed', req.method, p, e.code || '', e.message);
      return json(res, 500, { error: 'Something went wrong saving that. Please try again.' });
    }
  }
  if (!SECRET) return json(res, 503, { error: 'Stripe keys are not configured.' });
  if (p === '/api/admin/invoices' && req.method === 'GET') {
    try { return await adminList(req, res, url); } catch (e) {
      console.error('admin_list_failed', e.status, e.message);
      return json(res, 502, { error: 'Couldn’t load invoices from Stripe.' });
    }
  }
  if (p === '/api/admin/invoices' && req.method === 'POST') return adminCreate(req, res);
  const m = p.match(/^\/api\/admin\/invoices\/([^/]+)\/(send|void|mark-paid)$/);
  if (m && req.method === 'POST') return adminAction(req, res, m[1], m[2]);
  return json(res, 404, { error: 'Not found' });
}

// ---------- Stripe webhook ----------
// Stripe signs every event: header "t=<unix>,v1=<hex hmac>" over "<t>.<raw body>" with the endpoint secret.
function verifyStripeSignature(raw, header, secret, nowSec) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  String(header).split(',').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 1) return;
    const k = part.slice(0, i).trim(); const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  });
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  const now = nowSec === undefined ? Math.floor(Date.now() / 1000) : nowSec;
  if (Math.abs(now - Number(t)) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(t + '.').update(raw).digest('hex'), 'utf8');
  return sigs.some(function (s) {
    const b = Buffer.from(s, 'utf8');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
}

// Turn the events we care about into one flat record for logging and the payments sheet. Others return null.
function summarizeEvent(event) {
  const o = (event && event.data && event.data.object) || {};
  const md = o.metadata || {};
  const base = { event_id: event.id, event_type: event.type, livemode: Boolean(event.livemode), customer: o.customer || '' };
  const fromSession = function (status, label) {
    const cd = o.customer_details || {};
    return Object.assign(base, {
      label: label, status: status,
      amount: money(o.amount_total, o.currency),
      name: cd.business_name || cd.name || '', email: cd.email || '',
      plan: md.plan || (o.mode === 'subscription' ? 'subscription' : ''),
      invoice_number: md.invoice_number || '',
      reference: o.subscription || o.payment_intent || o.id || ''
    });
  };
  switch (event.type) {
    case 'checkout.session.completed':
      // Card payments arrive "paid"; ACH bank payments arrive "unpaid" and settle days later.
      if (o.payment_status === 'unpaid') return fromSession('processing', o.mode === 'subscription' ? 'Subscription started, bank payment processing' : 'Bank payment processing');
      return fromSession('paid', o.mode === 'subscription' ? 'Subscription started' : 'Invoice payment received');
    case 'checkout.session.async_payment_succeeded':
      return fromSession('paid', 'Bank payment cleared');
    case 'checkout.session.async_payment_failed':
      return fromSession('failed', 'Bank payment failed');
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      // Receipts for one-off pay-page payments are already covered by the checkout events above.
      if (md.source === 'aethera_pay_page') return null;
      const paid = event.type === 'invoice.paid';
      const renewal = o.billing_reason === 'subscription_cycle';
      const firstSub = o.billing_reason === 'subscription_create';
      return Object.assign(base, {
        label: paid ? (renewal ? 'Monthly renewal paid' : firstSub ? 'Partnership started (first payment)' : 'Invoice paid') : (renewal ? 'Monthly renewal failed' : firstSub ? 'Partnership first payment failed' : 'Invoice payment failed'),
        status: paid ? 'paid' : 'failed',
        amount: money(paid ? o.amount_paid : o.amount_due, o.currency),
        name: o.customer_name || '', email: o.customer_email || '',
        plan: (o.parent && o.parent.subscription_details && o.parent.subscription_details.metadata && o.parent.subscription_details.metadata.plan) || '',
        invoice_number: o.number || '',
        reference: o.hosted_invoice_url || o.id || ''
      });
    }
    case 'customer.subscription.updated': {
      const prev = (event.data && event.data.previous_attributes) || {};
      let label = null;
      if ('status' in prev && prev.status !== o.status) label = 'Subscription status: ' + o.status;
      else if ('cancel_at_period_end' in prev && o.cancel_at_period_end) label = 'Subscription set to cancel at period end';
      else if ('cancel_at_period_end' in prev && !o.cancel_at_period_end) label = 'Subscription cancellation undone';
      if (!label) return null;
      return Object.assign(base, { label: label, status: o.status || '', amount: '', name: '', email: '', plan: md.plan || '', invoice_number: '', reference: o.id || '' });
    }
    case 'customer.subscription.deleted':
      return Object.assign(base, { label: 'Subscription canceled', status: 'canceled', amount: '', name: '', email: '', plan: md.plan || '', invoice_number: '', reference: o.id || '' });
    default:
      return null;
  }
}

async function notifyPayments(rec) {
  if (!NOTIFY_URL) return;
  const body = new URLSearchParams(Object.assign({ kind: 'payment', token: NOTIFY_TOKEN }, rec, { livemode: String(rec.livemode) }));
  const r = await fetch(NOTIFY_URL, {
    method: 'POST', body: body, redirect: 'follow',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(8000)
  });
  const out = await r.json().catch(function () { return {}; });
  if (!r.ok || out.ok === false) throw new Error('notify failed: ' + r.status + ' ' + (out.error || ''));
}

// Event ids already handled, so Stripe's retries don't log or email twice.
const handledEvents = new Map();
function markHandled(id) {
  handledEvents.set(id, Date.now());
  if (handledEvents.size > 2000) handledEvents.delete(handledEvents.keys().next().value);
}

async function stripeWebhook(req, res) {
  if (!WEBHOOK_SECRET) return json(res, 503, { error: 'Webhook not configured.' });
  let raw;
  try { raw = await readRaw(req, 1024 * 1024); } catch (e) { return json(res, e.status || 400, { error: 'Bad request.' }); }
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], WEBHOOK_SECRET)) {
    console.warn('stripe_webhook_bad_signature');
    return json(res, 400, { error: 'Invalid signature.' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return json(res, 400, { error: 'Invalid payload.' }); }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return json(res, 400, { error: 'Invalid payload.' });
  if (handledEvents.has(event.id)) return json(res, 200, { received: true, duplicate: true });

  const rec = summarizeEvent(event);
  if (rec) {
    console.log('stripe_event ' + JSON.stringify(rec));
    try {
      await notifyPayments(rec);
    } catch (e) {
      // A non-2xx makes Stripe retry later (with backoff, for up to 3 days).
      console.error('stripe_event_notify_failed', event.id, e.message);
      return json(res, 500, { error: 'Could not record event.' });
    }
  }
  markHandled(event.id);
  return json(res, 200, { received: true });
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  fs.stat(file, function (err, st) {
    if (!err && st.isDirectory()) {
      if (!rel.endsWith('/')) return send(res, 301, '', { Location: rel + '/' + (url.search || '') });
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, function (err2, data) {
      if (err2) {
        return fs.readFile(path.join(PUBLIC_DIR, '404.html'), function (e3, nf) {
          send(res, 404, e3 ? 'Not found' : nf, { 'Content-Type': 'text/html; charset=utf-8' });
        });
      }
      const ext = path.extname(file).toLowerCase();
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
      send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
    });
  });
}

// ---------- router ----------
const server = http.createServer(async function (req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'Bad request'); }
  try {
    const p = url.pathname;
    const site = siteOf(req);
    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    // admin.aetheradigital.com: the dashboard at "/", its API and shared assets; everything else goes to the public site.
    if (site === 'admin') {
      if (p.startsWith('/api/admin/')) return await adminApi(req, res, url);
      if (p === '/' || p === '/index.html') return serveStatic(req, res, new URL('/admin/', 'http://localhost'));
      if (p === '/admin' || p.startsWith('/admin/')) return send(res, 301, '', { Location: '/' });
      if (p.startsWith('/assets/') || p === '/robots.txt' || p === '/api/config') {
        if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        if (p === '/api/config') return config(req, res);
        return serveStatic(req, res, url);
      }
      return send(res, 302, '', { Location: 'https://' + PUBLIC_DOMAIN + p + (url.search || '') });
    }
    // aetheradigital.com: no admin here.
    if (site === 'public') {
      if (p === '/admin' || p.startsWith('/admin/')) return send(res, 301, '', { Location: 'https://' + ADMIN_HOST + '/' });
      if (p.startsWith('/api/admin/')) return json(res, 404, { error: 'Not found' });
    }

    if (p === '/api/config' && req.method === 'GET') return config(req, res);
    if (p === '/api/invoice' && req.method === 'GET') return await getInvoice(req, res, url);
    if (p === '/api/invoice-lookup' && req.method === 'POST') return await lookupInvoice(req, res);
    if (p === '/api/subscribe' && req.method === 'POST') return await subscribe(req, res);
    if (p === '/api/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, res);
    if (p.startsWith('/api/collector/')) return await collectorApi(req, res, url);
    if (p.startsWith('/api/admin/')) return await adminApi(req, res, url);
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('unhandled', e);
    if (!res.headersSent) json(res, e.status || 500, { error: 'Something went wrong.' });
  }
});

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('aethera site listening on ' + PORT + (SECRET ? '' : ' (Stripe not configured)') + (ADMIN_PASSWORD ? '' : ' (admin disabled: set ADMIN_PASSWORD)'));
  });
}
module.exports = { server, encodeForm, verifyStripeSignature, summarizeEvent, invoiceSig, parseItems };
