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
 *   CLIENT_HOST             hostname of the client portal (default client.aetheradigital.com). Elsewhere it's at /client/.
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *                           Cloudflare R2 bucket for Desk and portal files (without them, files are kept in Postgres)
 *   DATABASE_URL            Postgres connection string for the Aethera Desk (Render internal URL). Without it the Desk
 *                           keeps data in memory only (lost on restart) and says so on screen.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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
const CLIENT_HOST = String(process.env.CLIENT_HOST || 'client.' + PUBLIC_DOMAIN).toLowerCase();
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
  if (h === CLIENT_HOST) return 'client';
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

// Create, fill and finalize a send-invoice Stripe invoice. Deletes the draft if anything fails part way.
// o: { email, name, company, memo, days, items: [{ description, quantity, cents }], source, metadata }
async function createInvoice(o) {
  let invoice = null;
  try {
    const customer = await findOrCreateCustomer(o.email, o.name, o.company, o.source || 'aethera_admin');
    invoice = await stripe('POST', '/v1/invoices', {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: o.days,
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      description: o.memo || undefined,
      footer: 'Aethera Digital · aetheradigital.com · hello@aetheradigital.com',
      payment_settings: { payment_method_types: PAYMENT_METHOD_TYPES },
      automatic_tax: AUTOMATIC_TAX ? { enabled: true } : undefined,
      metadata: Object.assign({ source: o.source || 'aethera_admin', contact_name: o.name || '', company: o.company || '' }, o.metadata || {})
    });
    for (const it of o.items) {
      await stripe('POST', '/v1/invoiceitems', {
        customer: customer.id, invoice: invoice.id, currency: 'usd',
        description: it.description, quantity: it.quantity, unit_amount_decimal: String(it.cents)
      });
    }
    return await stripe('POST', '/v1/invoices/' + invoice.id + '/finalize', { auto_advance: false });
  } catch (e) {
    console.error('invoice_create_failed', o.source, e.status, e.message);
    if (invoice && invoice.status === 'draft') await stripe('DELETE', '/v1/invoices/' + invoice.id).catch(function () {});
    throw e;
  }
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
    invoice = await createInvoice({ email: email, name: name, company: company, memo: memo, days: days, items: items, source: 'aethera_admin' });
  } catch (e) {
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
    return json(res, 200, { store: desk.kind, templates: templates, services: deskLib.SERVICES, client_status: deskLib.CLIENT_STATUS, project_status: deskLib.PROJECT_STATUS, approval_status: deskLib.APPROVAL_STATUS, approval_kind: deskLib.APPROVAL_KIND, file_category: deskLib.FILE_CATEGORY, metrics: deskLib.METRICS,
      metric_groups: deskLib.METRIC_GROUPS, collector: Boolean(COLLECTOR_TOKEN), report_status: deskLib.REPORT_STATUS, report_month: deskLib.lastFullMonth(), ai: Boolean(ANTHROPIC_KEY),
      file_limit_mb: Math.round(fileLimit() / 1048576), file_storage: r2.enabled ? 'r2' : 'database', client_host: CLIENT_HOST });
  }
  if (p === '/overview' && m === 'GET') return deskOverview(req, res);
  if (/^\/(portal|audit)(\/|$)/.test(p)) { const r = await portalAdmin(req, res, p, m, url); if (r !== null) return r; return json(res, 404, { error: 'Not found' }); }
  if (/^\/(quotes|terms|catalog)(\/|$)/.test(p)) { const r = await quotesApi(req, res, p, m, url); if (r !== null) return r; return json(res, 404, { error: 'Not found' }); }

  // client profile with everything attached
  let mm = p.match(/^\/clients\/([a-z]{3}_[A-Za-z0-9_-]+)\/full$/);
  if (mm && m === 'GET') {
    const c = await desk.get('client', mm[1]);
    if (!c) return json(res, 404, { error: 'Client not found.' });
    const [projects, tasks, approvals, reports, files, suggestions, assets] = await Promise.all([
      desk.list('project', { client_id: c.id }), desk.list('task', { client_id: c.id }), desk.list('approval', { client_id: c.id }),
      desk.list('report', { client_id: c.id }), desk.listFiles(c.id), desk.list('suggestion', { client_id: c.id }), desk.list('asset', { client_id: c.id })]);
    let invoices = []; let invoiceError = null;
    try { invoices = await stripeInvoicesFor(c.email, originOf(req)); } catch (e) { invoiceError = 'Couldn’t load invoices from Stripe.'; }
    return json(res, 200, { client: c, suggestions: suggestions.filter(function (x) { return x.status === 'new'; }).reverse(), projects: projects, tasks: tasks, approvals: approvals, reports: reports.sort(function (a, b) { return a.period < b.period ? 1 : -1; }), files: files, assets: assets, invoices: invoices, invoice_error: invoiceError,
      quotes: (await desk.list('quote', { client_id: c.id })).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).map(function (q) { const o = {}; o[c.id] = c; return quoteSummary(q, o); }) });
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

  // monthly reports: create this month's drafts now; draft the commentary with Claude
  if (p === '/reports/drafts' && m === 'POST') {
    const body = (await readJson(req, 1024)) || {};
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(body.period || '')) ? body.period : deskLib.lastFullMonth();
    return json(res, 200, { period: period, created: await ensureReportDrafts(period, true) });
  }
  mm = p.match(/^\/reports\/(rep_[A-Za-z0-9_-]+)\/commentary$/);
  if (mm && m === 'POST') return reportCommentary(req, res, mm[1]);

  // files
  if (p === '/files' && m === 'POST') {
    const cid = url.searchParams.get('client_id') || '';
    const client = /^cli_/.test(cid) ? await desk.get('client', cid) : null;
    if (!client) return json(res, 400, { error: 'Choose a client.' });
    const category = deskLib.FILE_CATEGORY.indexOf(url.searchParams.get('category')) >= 0 ? url.searchParams.get('category') : 'other';
    const name = clip(url.searchParams.get('name') || 'file', 200).replace(/[\\/\0\r\n"]/g, '_');
    let content;
    try { content = await readRaw(req, fileLimit()); } catch (e) { return json(res, 413, { error: 'Files can be up to ' + fileLimitText() + '.' }); }
    if (!content.length) return json(res, 400, { error: 'That file is empty.' });
    const mime = clip(String(req.headers['content-type'] || 'application/octet-stream').split(';')[0], 100);
    const shared = url.searchParams.get('shared') === '1';
    const file = await storeFile({ client_id: client.id, name: name, mime: mime, category: category, content: content, shared: shared, uploaded_by: 'aethera' });
    if (shared) await adminAudit(req, client.id, 'file', 'File shared with you', name);
    return json(res, 200, { file: file });
  }
  mm = p.match(/^\/files\/(fil_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'GET') {
    const f = await desk.getFileMeta(mm[1]);
    if (!f) return json(res, 404, { error: 'File not found.' });
    return sendStoredFile(res, f);
  }
  if (mm && m === 'PATCH') {
    const body = await readJson(req, 1024);
    if (!body || typeof body.shared !== 'boolean') return json(res, 400, { error: 'Invalid request.' });
    const before = await desk.getFileMeta(mm[1]);
    if (!before) return json(res, 404, { error: 'File not found.' });
    const f = await desk.setFileShared(mm[1], body.shared);
    if (before.shared !== body.shared) await adminAudit(req, f.client_id, 'file', body.shared ? 'File shared with you' : 'File no longer shared', f.name);
    return json(res, 200, { file: f });
  }
  if (mm && m === 'DELETE') {
    const f = await desk.getFileMeta(mm[1]);
    if (f) { await deleteStoredFile(f); if (f.shared) await adminAudit(req, f.client_id, 'file', 'File removed', f.name); }
    return json(res, 200, { ok: true });
  }

  // Digital Health: fetch a page for a scan (the browser runs the checks), Claude review, fixes to to-dos, import
  if (p === '/health/fetch' && m === 'POST') return healthFetch(req, res);
  if (p === '/health/import' && m === 'POST') return healthImport(req, res);
  mm = p.match(/^\/assets\/(ass_[A-Za-z0-9_-]+)\/(review|fix|client)$/);
  if (mm && m === 'POST') return mm[2] === 'review' ? healthReview(req, res, mm[1]) : mm[2] === 'fix' ? healthFix(req, res, mm[1]) : healthRelink(req, res, mm[1]);

  // generic records: /clients, /projects, /tasks, /approvals, /reports, /assets (+ /:id)
  mm = p.match(/^\/(clients|projects|tasks|approvals|reports|suggestions|leads|assets)(?:\/([a-z]{3}_[A-Za-z0-9_-]+))?$/);
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
    if (type === 'client') {
      v.data.status = v.data.status || 'lead';
      const bad = reportingLib.normalizeConnections(v.data); if (bad) return json(res, 400, { error: bad });
    }
    else if (type === 'lead') { v.data.status = v.data.status || 'new'; }
    else if (type === 'asset' && !v.data.client_id) { v.data.status = v.data.status || 'live'; }
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
    if (type === 'task' && v.data.done && !v.data.done_at) v.data.done_at = deskLib.localDate();
    if (type === 'asset') {
      v.data.status = v.data.status || 'live';
      const item = await desk.create(type, v.data, links);
      await syncHealthReports(item.client_id);
      return json(res, 200, { item: item });
    }
    if (type === 'report') {
      v.data.status = v.data.status || 'draft'; v.data.created_by = 'manual';
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
    // Record when a task was finished (reports use it); clear it when reopened.
    if (type === 'task' && 'done' in v.data && !('done_at' in v.data)) v.data.done_at = v.data.done ? deskLib.localDate() : null;
    if (type === 'report' && v.data.status === 'sent' && !v.data.sent_at) v.data.sent_at = deskLib.localDate();
    if (type === 'report' && v.data.status && v.data.status !== 'sent' && !('sent_at' in v.data)) v.data.sent_at = null;
    if (type === 'client') { const bad = reportingLib.normalizeConnections(v.data); if (bad) return json(res, 400, { error: bad }); }
    // A number changed by hand is no longer marked as pulled from Google, so the next pull leaves it alone.
    if (type === 'report' && v.data.metrics) {
      const before = await desk.get('report', id);
      if (before && before.sources) v.data.sources = reportingLib.sourcesAfterEdit(before, v.data.metrics);
    }
    const item = await desk.update(type, id, v.data);
    if (item && type === 'asset' && ('history' in v.data || 'status' in v.data)) await syncHealthReports(item.client_id);
    return item ? json(res, 200, { item: item }) : json(res, 404, { error: 'Not found.' });
  }
  if (id && m === 'DELETE') {
    if (type === 'client' && (await desk.list('quote', { client_id: id })).some(function (q) { return q.status === 'accepted'; })) {
      return json(res, 409, { error: 'This client has signed quotes, which are kept as records. Set their status to Past instead.' });
    }
    const before = type === 'asset' ? await desk.get('asset', id) : null;
    if (type === 'client' && r2.enabled) {
      for (const key of await desk.r2KeysFor(id)) { try { await r2.remove(key); } catch (e) { console.error('r2_delete_failed', key, e.message); } }
    }
    if (type === 'client') await portal.endAllSessions(id).catch(function () {});
    await desk.remove(type, id);
    if (before) await syncHealthReports(before.client_id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
}

// ---------- Quotes ----------
// Quotes are written in the Desk, sent to the client as a private link (/quote/?t=…), and signed there with a drawn
// signature. Signing records who, when, from where and exactly what (a fingerprint of the quote, the chosen add-ons
// and the terms version), then bills the quote's payment schedule:
//   "on signing" payments (and dated ones whose date has passed) are invoiced and emailed straight away,
//   dated payments are invoiced on their date by the scheduler below, milestone payments wait for "Bill Now",
//   monthly lines start a Stripe subscription (send-invoice, on the quote's monthly start date).
const quotesLib = require('./lib/quotes');
const quotePdf = require('./lib/quote-pdf');
const QUOTE_TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;
const SIGNATURE_MAX = 300 * 1024;
const quoteLocks = new Set();

function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function longDate(s) { return s ? new Date(String(s).length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: String(s).length === 10 ? 'UTC' : 'America/New_York' }) : ''; }
function stamp(iso) { return new Date(iso).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }); }
function withEvent(q, what, extra) { return (q.events || []).concat([Object.assign({ at: new Date().toISOString(), what: what }, extra || {})]).slice(-100); }
function quoteUrl(origin, q) { return origin + '/quote/?t=' + q.token; }
function publicOrigin() { return SITE_URL || 'https://' + PUBLIC_DOMAIN; }
function quoteState(q) {
  if ((q.status === 'sent' || q.status === 'viewed') && q.valid_until && q.valid_until < deskLib.localDate()) return 'expired';
  return q.status || 'draft';
}
function clientName(c) { return c ? (c.company || c.name || '') : ''; }
function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

async function currentTerms() {
  const all = await desk.allOf('terms');
  if (!all.length) return desk.create('terms', { version: 1, body: quotesLib.DEFAULT_TERMS, note: 'Starting draft' }, {});
  return all.sort(function (a, b) { return b.version - a.version; })[0];
}
async function termsVersion(v) {
  return (await desk.allOf('terms')).find(function (t) { return t.version === v; }) || null;
}
async function findQuoteByToken(token) {
  if (!QUOTE_TOKEN_RE.test(token || '')) return null;
  return (await desk.allOf('quote')).find(function (q) { return q.token && safeEqual(q.token, token); }) || null;
}

// Email through the Apps Script (same web app as invoice emails). Returns its reply (which may carry a PDF).
async function quoteEmail(fields) {
  if (!NOTIFY_URL) return null;
  const r = await fetch(NOTIFY_URL, {
    method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ kind: 'quote_email', token: NOTIFY_TOKEN, livemode: String(LIVE) }, fields)),
    signal: AbortSignal.timeout(30000)
  });
  const out = await r.json().catch(function () { return {}; });
  if (!r.ok || out.ok !== true) throw new Error('quote email failed: ' + r.status + ' ' + (out.error || ''));
  return out;
}

// ---------- what the client sees ----------
function publicQuote(q, client, terms) {
  const t = quotesLib.totals(q, q.acceptance ? q.acceptance.selected : []);
  const state = quoteState(q);
  const out = {
    number: q.number, title: q.title, summary: q.summary || '', issued: q.issued, valid_until: q.valid_until, state: state,
    prepared_by: q.prepared_by || '', client: { name: client ? client.name || '' : '', company: client ? client.company || '' : '', email: client ? client.email || '' : '' },
    standard_rate: q.standard_rate, rate: q.rate, startup_discount_pct: q.startup_discount_pct || 0, days_until_due: q.days_until_due || 7,
    items: (q.items || []).map(function (it) { return { id: it.id, name: it.name, description: it.description, timeline: it.timeline, pricing: it.pricing, hours: it.hours, amount: it.amount, billing: it.billing, optional: it.optional }; }),
    schedule: q.schedule || [], monthly_start: q.monthly_start || null, key_dates: q.key_dates || [],
    included: q.included || '', not_included: q.not_included || '', notes: q.notes || '',
    terms: terms ? { version: terms.version, body: terms.body } : null,
    totals: t, installments: quotesLib.installments(q, t.total),
    trail: (q.events || []).filter(function (e) { return ['sent', 'viewed', 'accepted', 'declined'].indexOf(e.what) >= 0; }).map(function (e) { return { at: e.at, what: e.what, ip: e.what === 'accepted' ? e.ip : undefined }; })
  };
  if (q.acceptance) {
    const a = q.acceptance;
    out.acceptance = { name: a.name, title: a.title, email: a.email, at: a.at, ip: a.ip, user_agent: a.user_agent, signature: a.signature, selected: a.selected, fingerprint: a.fingerprint, terms_version: a.terms_version };
    out.invoices = (q.billing || []).map(function (b) { return { label: b.label, amount: b.amount, status: b.status, date: b.date, pay_url: b.status === 'invoiced' ? b.pay_url : null }; });
    out.monthly_billing = q.monthly_billing ? { status: q.monthly_billing.status, start: q.monthly_billing.start, amount: q.monthly_billing.amount } : null;
  }
  if (q.declined) out.declined = { at: q.declined.at, reason: q.declined.reason };
  return out;
}

// The branded signed PDF, for whoever holds the quote's private link (the client, from the page or their portal).
async function quotePdfGet(req, res, url) {
  if (limited(req, 20, 'quote-pdf')) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });
  await deskInit();
  const q = await findQuoteByToken(url.searchParams.get('t'));
  if (!q || q.status !== 'accepted' || !q.acceptance) return json(res, 404, { error: 'We couldn’t find a signed quote at that link.' });
  const client = await desk.get('client', q.client_id);
  return sendPdf(res, signedPdf(q, client, await termsVersion(q.acceptance.terms_version)), signedPdfName(q));
}
async function quotePublicGet(req, res, url) {
  if (limited(req, 60, 'quote')) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });
  await deskInit();
  const q = await findQuoteByToken(url.searchParams.get('t'));
  if (!q || q.status === 'draft' || q.status === 'void') return json(res, 404, { error: 'We couldn’t find that quote. The link may be incomplete or the quote was withdrawn.' });
  let quote = q;
  if (q.status === 'sent' && url.searchParams.get('preview') !== '1') {
    quote = await desk.update('quote', q.id, { status: 'viewed', viewed_at: new Date().toISOString(), events: withEvent(q, 'viewed', { ip: ipOf(req) }) }) || q;
  }
  const client = await desk.get('client', q.client_id);
  const terms = quote.acceptance ? await termsVersion(quote.acceptance.terms_version) : await currentTerms();
  return json(res, 200, { quote: publicQuote(quote, client, terms), testMode: !LIVE && Boolean(SECRET) });
}

function validSignature(s) {
  if (typeof s !== 'string' || s.length > SIGNATURE_MAX || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return false;
  const buf = Buffer.from(s.slice(22), 'base64');
  return buf.length > 200 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function quoteAccept(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 10, 'quote-accept')) return json(res, 429, { error: 'Too many attempts. Please wait a minute.' });
  const body = await readJson(req, SIGNATURE_MAX + 16384);
  if (!body) return json(res, 400, { error: 'Invalid request.' });
  await deskInit();
  const q = await findQuoteByToken(body.t);
  if (!q || q.status === 'draft' || q.status === 'void') return json(res, 404, { error: 'We couldn’t find that quote.' });
  if (q.status === 'accepted') return json(res, 409, { error: 'This quote has already been signed.' });
  if (q.status === 'declined') return json(res, 409, { error: 'This quote was declined. Email hello@aetheradigital.com and we’ll send a new one.' });
  if (quoteState(q) === 'expired') return json(res, 409, { error: 'This quote expired on ' + longDate(q.valid_until) + '. Email hello@aetheradigital.com and we’ll send an updated one.' });
  const name = clip(body.name, 120); const title = clip(body.title, 120); const email = clip(body.email, 200).toLowerCase();
  if (!name || name.length < 2) return json(res, 400, { error: 'Type your full name.', field: 'name' });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter your email address so we can send your signed copy.', field: 'email' });
  if (!validSignature(body.signature)) return json(res, 400, { error: 'Draw your signature in the box.', field: 'signature' });
  if (body.agree_terms !== true) return json(res, 400, { error: 'Please confirm you agree to the Terms of Service.', field: 'agree_terms' });
  if (body.agree_esign !== true) return json(res, 400, { error: 'Please confirm you agree to sign electronically.', field: 'agree_esign' });
  const optional = (q.items || []).filter(function (it) { return it.optional; }).map(function (it) { return it.id; });
  const selected = Array.isArray(body.selected) ? body.selected.filter(function (id) { return optional.indexOf(id) >= 0; }) : [];
  const terms = await currentTerms();
  if (Number(body.terms_version) !== terms.version) return json(res, 409, { error: 'Our Terms of Service were just updated. Please reload the page, review them and sign again.', reload: true });
  const t = quotesLib.totals(q, selected);
  if (Number(body.total_seen) !== t.total || Number(body.monthly_seen || 0) !== t.monthly) return json(res, 409, { error: 'This quote was just updated. Please reload the page and review it before signing.', reload: true });
  if (t.total <= 0 && t.monthly <= 0) return json(res, 400, { error: 'This quote has no priced items yet. Email hello@aetheradigital.com.' });
  if (quoteLocks.has(q.id)) return json(res, 409, { error: 'Already signing. Please wait a moment.' });
  quoteLocks.add(q.id);
  try {
    const now = new Date().toISOString();
    const acceptance = { name: name, title: title, email: email, signature: body.signature, selected: selected, at: now, ip: ipOf(req),
      user_agent: clip(req.headers['user-agent'], 300), terms_version: terms.version, fingerprint: quotesLib.fingerprint(q, selected, t, terms),
      total: t.total, monthly: t.monthly };
    // Record the signature first, so it's kept even if billing below has trouble.
    let quote = await desk.update('quote', q.id, { status: 'accepted', acceptance: acceptance, events: withEvent(q, 'accepted', { ip: acceptance.ip, by: name }) });
    await audit(req, { client_id: q.client_id, actor_type: 'client', actor: name, category: 'quote', event: 'Signed quote', detail: (q.number || '') + ' · ' + (q.title || '') + ' · signed by ' + name });
    const client = await desk.get('client', q.client_id);
    const changes = {};
    if (client && ['lead', 'prospect', 'proposal'].indexOf(client.status) >= 0) changes.status = 'active';
    if (client && !client.email) changes.email = email;
    if (client && t.monthly && !client.monthly_value) changes.monthly_value = t.monthly / 100;
    if (client && Object.keys(changes).length) await desk.update('client', client.id, changes);
    const fresh = client ? Object.assign({}, client, changes) : null;
    quote = await billAcceptedQuote(quote, fresh, t);
    sendSignedCopy(quote, fresh, terms).catch(function (e) { console.error('quote_signed_email_failed', q.id, e.message); });
    console.log('quote_accepted ' + JSON.stringify({ id: q.id, number: q.number, total: t.total, monthly: t.monthly }));
    return json(res, 200, { quote: publicQuote(quote, fresh, terms) });
  } finally { quoteLocks.delete(q.id); }
}

async function quoteDecline(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 10, 'quote-accept')) return json(res, 429, { error: 'Too many attempts. Please wait a minute.' });
  const body = await readJson(req, 8192);
  if (!body) return json(res, 400, { error: 'Invalid request.' });
  await deskInit();
  const q = await findQuoteByToken(body.t);
  if (!q || q.status === 'draft' || q.status === 'void') return json(res, 404, { error: 'We couldn’t find that quote.' });
  if (q.status === 'accepted' || q.status === 'declined') return json(res, 409, { error: 'This quote has already been ' + q.status + '.' });
  const declined = { at: new Date().toISOString(), reason: clip(body.reason, 1000), ip: ipOf(req) };
  const quote = await desk.update('quote', q.id, { status: 'declined', declined: declined, events: withEvent(q, 'declined', { ip: declined.ip }) });
  await audit(req, { client_id: q.client_id, actor_type: 'client', category: 'quote', event: 'Declined quote', detail: (q.number || '') + ' · ' + (q.title || '') });
  const client = await desk.get('client', q.client_id);
  quoteEmail({ to: 'hello@aetheradigital.com', subject: 'Quote declined: ' + q.number + ' (' + clientName(client) + ')', heading: 'Quote declined',
    intro: clientName(client) + ' declined quote ' + q.number + ' (' + q.title + ').' + (declined.reason ? ' Their note: “' + declined.reason + '”' : ''), url: publicOrigin() + '/quote/?t=' + q.token + '&preview=1', button: 'View Quote' })
    .catch(function (e) { console.error('quote_decline_email_failed', e.message); });
  return json(res, 200, { quote: publicQuote(quote, client, await currentTerms()) });
}

// ---------- billing ----------
function billingEmail(q, client) { return (client && client.email) || (q.acceptance && q.acceptance.email) || ''; }
async function issueInstallment(q, client, b) {
  if (!SECRET) return Object.assign({}, b, { status: 'failed', error: 'Stripe isn’t set up on the server, so this invoice wasn’t created.' });
  const t = quotesLib.totals(q, q.acceptance.selected);
  try {
    const inv = await createInvoice({
      email: billingEmail(q, client), name: (client && client.name) || q.acceptance.name, company: (client && client.company) || '',
      memo: q.title + ' · Quote ' + q.number, days: q.days_until_due || 7, source: 'aethera_quote',
      items: [{ description: q.title + ': ' + b.label + (b.percent < 100 ? ' (' + b.percent + '% of ' + money(t.total, 'usd') + ')' : ''), quantity: 1, cents: b.amount }],
      metadata: { quote_id: q.id, quote_number: q.number, installment: String(b.index) }
    });
    const out = Object.assign({}, b, { status: 'invoiced', invoice_id: inv.id, invoice_number: inv.number, pay_url: publicOrigin() + invoicePath(inv.id), invoiced_at: new Date().toISOString(), error: null });
    try { out.emailed_via = await sendInvoiceEmail(inv, publicOrigin()); } catch (e) { out.email_error = 'Invoice created but the email didn’t send. Resend it from Invoices.'; console.error('quote_invoice_email_failed', e.message); }
    return out;
  } catch (e) {
    return Object.assign({}, b, { status: 'failed', error: e.stripe ? 'Stripe: ' + e.message : e.message });
  }
}

async function startMonthly(q, client, t) {
  const items = quotesLib.includedItems(q, q.acceptance.selected).filter(function (it) { return it.billing === 'monthly'; });
  const today = deskLib.localDate();
  const start = q.monthly_start && q.monthly_start > today ? q.monthly_start : today;
  const base = { amount: t.monthly, start: start };
  if (!SECRET) return Object.assign(base, { status: 'failed', error: 'Stripe isn’t set up on the server, so the monthly billing wasn’t started.' });
  try {
    const customer = await findOrCreateCustomer(billingEmail(q, client), (client && client.name) || q.acceptance.name, (client && client.company) || '', 'aethera_quote');
    const lines = [];
    for (const it of items) {
      const product = await stripe('POST', '/v1/products', { name: it.name, description: it.description || undefined, metadata: { quote_id: q.id, quote_number: q.number } });
      lines.push({ price_data: { currency: 'usd', product: product.id, unit_amount: t.lines[it.id].amount, recurring: { interval: 'month' } }, quantity: 1 });
    }
    const startSec = start === today ? 'now' : Math.floor(Date.parse(start + 'T14:00:00Z') / 1000); // 9–10am Eastern on the start date
    const sched = await stripe('POST', '/v1/subscription_schedules', {
      customer: customer.id, start_date: startSec, end_behavior: 'release',
      default_settings: { collection_method: 'send_invoice', invoice_settings: { days_until_due: q.days_until_due || 7 }, description: q.title + ' · Quote ' + q.number },
      phases: [{ items: lines, metadata: { quote_id: q.id, quote_number: q.number, plan: 'quote_monthly' }, automatic_tax: AUTOMATIC_TAX ? { enabled: true } : undefined }],
      metadata: { quote_id: q.id, quote_number: q.number }
    });
    return Object.assign(base, { status: start === today ? 'active' : 'scheduled', schedule_id: sched.id, subscription_id: sched.subscription || null, error: null });
  } catch (e) {
    return Object.assign(base, { status: 'failed', error: e.stripe ? 'Stripe: ' + e.message : e.message });
  }
}

async function billAcceptedQuote(q, client, t) {
  const today = deskLib.localDate();
  const billing = [];
  for (const p of quotesLib.installments(q, t.total)) {
    let b = Object.assign({}, p, { status: p.when === 'milestone' ? 'milestone' : p.when === 'date' && p.date > today ? 'scheduled' : 'due' });
    if (b.status === 'due') b = await issueInstallment(q, client, b);
    billing.push(b);
  }
  const monthly = t.monthly > 0 ? await startMonthly(q, client, t) : null;
  const events = withEvent(q, 'billed', { invoices: billing.filter(function (b) { return b.status === 'invoiced'; }).length, failed: billing.filter(function (b) { return b.status === 'failed'; }).length + (monthly && monthly.status === 'failed' ? 1 : 0) });
  return desk.update('quote', q.id, { billing: billing, monthly_billing: monthly, events: events });
}

// Dated payments: invoice them on (or after) their date. Runs with the other schedules.
async function runQuoteBilling() {
  const today = deskLib.localDate();
  for (const q of await desk.allOf('quote')) {
    if (q.status !== 'accepted' || !Array.isArray(q.billing) || quoteLocks.has(q.id)) continue;
    const due = q.billing.filter(function (b) { return b.status === 'scheduled' && b.date && b.date <= today; });
    if (!due.length) continue;
    quoteLocks.add(q.id);
    try {
      const client = await desk.get('client', q.client_id);
      const billing = [];
      for (const b of q.billing) billing.push(due.indexOf(b) >= 0 ? await issueInstallment(q, client, b) : b);
      await desk.update('quote', q.id, { billing: billing, events: withEvent(q, 'billed', { scheduled: due.length }) });
      console.log('quote_scheduled_billing ' + JSON.stringify({ id: q.id, issued: due.length }));
    } finally { quoteLocks.delete(q.id); }
  }
}
function scheduleQuoteBilling() {
  if (process.env.QUOTE_BILLING === 'off') return;
  const run = function () { deskInit().then(runQuoteBilling).catch(function (e) { console.error('quote_billing_failed', e.message); }); };
  setTimeout(run, 8000).unref();
  setInterval(run, 3600 * 1000).unref();
}

// ---------- signed copy ----------
// The branded signed-quote PDF (lib/quote-pdf.js): what's downloaded, emailed and filed.
function signedPdf(q, client, terms) {
  return quotePdf.signedQuotePdf(q, client, terms, quotesLib, { money: function (c) { return money(c, 'usd'); }, longDate: longDate, stamp: stamp });
}
function signedPdfName(q) { return (q.number || 'Quote') + ' signed.pdf'; }
function sendPdf(res, buf, name) {
  return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="' + name.replace(/[^A-Za-z0-9 ._-]/g, '_') + '"', 'Cache-Control': 'no-store' });
}
// Files the signed PDF with the client (shared, so it shows in their portal) unless it's already there.
async function fileSignedPdf(q, client, terms, buf) {
  if (!client) return null;
  if (q.signed_file_id && await desk.getFileMeta(q.signed_file_id)) return q.signed_file_id;
  buf = buf || signedPdf(q, client, terms);
  if (!buf.length || buf.length >= MAX_FILE_BYTES) return null;
  const f = await storeFile({ client_id: client.id, name: signedPdfName(q), mime: 'application/pdf', category: 'contract', content: buf, shared: true, uploaded_by: 'aethera' });
  await desk.update('quote', q.id, { signed_file_id: f.id });
  return f.id;
}

// Files the branded PDF first (so the client has it even if email fails), then emails it to the signer.
async function sendSignedCopy(q, client, terms) {
  const buf = signedPdf(q, client, terms);
  try { await fileSignedPdf(q, client, terms, buf); } catch (e) { console.error('quote_signed_file_failed', q.id, e.message); }
  if (!NOTIFY_URL) return;
  const a = q.acceptance; const t = quotesLib.totals(q, a.selected);
  const to = [a.email]; if (client && client.email && client.email.toLowerCase() !== a.email) to.push(client.email);
  const first = (q.billing || []).find(function (b) { return b.status === 'invoiced'; });
  await quoteEmail({
    to: to.join(','), cc: 'hello@aetheradigital.com', name: a.name,
    subject: 'Signed: ' + q.title + ' (Quote ' + q.number + ')', heading: 'Thank you. Your quote is signed.',
    intro: 'Here’s your signed copy of quote ' + q.number + ' for ' + q.title + ', attached as a PDF.' + (first ? ' Your first invoice (' + money(first.amount, 'usd') + ') is on its way in a separate email.' : ''),
    amount_label: t.total ? 'Project Total' : 'Monthly', amount: t.total ? money(t.total, 'usd') : money(t.monthly, 'usd') + '/mo',
    url: quoteUrl(publicOrigin(), q), button: 'View Signed Quote', pdf_b64: buf.toString('base64'), pdf_name: signedPdfName(q)
  });
}

// Signed quotes from before the branded PDF existed (or whose filing failed) get theirs filed once at startup.
async function backfillSignedPdfs() {
  for (const q of await desk.allOf('quote')) {
    if (q.status !== 'accepted' || !q.acceptance || q.signed_file_id) continue;
    try {
      const client = await desk.get('client', q.client_id);
      const id = await fileSignedPdf(q, client, await termsVersion(q.acceptance.terms_version));
      if (id) console.log('quote_signed_pdf_backfilled ' + JSON.stringify({ id: q.id, number: q.number, file: id }));
    } catch (e) { console.error('quote_signed_pdf_backfill_failed', q.id, e.message); }
  }
}

// ---------- Desk (admin) ----------
function quoteSummary(q, clientsById) {
  const sel = q.acceptance ? q.acceptance.selected : [];
  const t = quotesLib.totals(q, sel);
  return { id: q.id, number: q.number, title: q.title, client_id: q.client_id, client: clientName(clientsById[q.client_id]), state: quoteState(q), status: q.status,
    total: t.total, monthly: t.monthly, issued: q.issued, valid_until: q.valid_until, sent_at: q.sent_at || null, viewed_at: q.viewed_at || null,
    accepted_at: q.acceptance ? q.acceptance.at : null, created_at: q.created_at, updated_at: q.updated_at,
    needs_billing: (q.billing || []).some(function (b) { return b.status === 'milestone' || b.status === 'failed'; }) || Boolean(q.monthly_billing && q.monthly_billing.status === 'failed') };
}

async function quotesApi(req, res, p, m, url) {
  let mm;
  if (p === '/quotes' && m === 'GET') {
    const clients = {}; (await desk.allOf('client')).forEach(function (c) { clients[c.id] = c; });
    const cid = url.searchParams.get('client_id');
    const list = (await desk.allOf('quote')).filter(function (q) { return !cid || q.client_id === cid; })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).map(function (q) { return quoteSummary(q, clients); });
    return json(res, 200, { items: list });
  }
  if (p === '/quotes' && m === 'POST') {
    const body = await readJson(req, 131072);
    const v = quotesLib.validateQuote(body, false);
    if (v.error) return json(res, 400, { error: v.error });
    const client = await desk.get('client', v.data.client_id);
    if (!client) return json(res, 400, { error: 'Client not found.' });
    const today = deskLib.localDate();
    const all = await desk.allOf('quote');
    const d = Object.assign({
      number: quotesLib.nextNumber(client, all, today.slice(0, 4)), issued: today, valid_until: addDays(today, 30),
      standard_rate: 50, startup_discount_pct: 0, days_until_due: 7, items: [], key_dates: [], prepared_by: 'Nicholas P. Stevens',
      schedule: [{ label: 'Deposit', percent: 30, when: 'signing', date: null }, { label: 'Midpoint milestone', percent: 30, when: 'milestone', date: null }, { label: 'Launch', percent: 40, when: 'milestone', date: null }],
      included: '', not_included: 'Third-party platform fees (software, domains, hosting, ad spend), which the client pays directly.\nOngoing maintenance after handoff.'
    }, v.data);
    if (!v.data.number) d.number = quotesLib.nextNumber(client, all, today.slice(0, 4));
    if (d.rate === undefined || d.rate === null) d.rate = d.standard_rate;
    d.status = 'draft'; d.events = [{ at: new Date().toISOString(), what: 'created' }];
    return json(res, 200, { item: await desk.create('quote', d, { client_id: client.id }) });
  }
  mm = p.match(/^\/quotes\/(quo_[A-Za-z0-9_-]+)(?:\/([a-z-]+)(?:\/(\d+))?)?$/);
  if (mm) {
    const q = await desk.get('quote', mm[1]);
    if (!q) return json(res, 404, { error: 'Quote not found.' });
    const action = mm[2] || '';
    const client = await desk.get('client', q.client_id);
    if (!action && m === 'GET') {
      const terms = q.acceptance ? await termsVersion(q.acceptance.terms_version) : await currentTerms();
      const allSel = (q.items || []).filter(function (it) { return it.optional; }).map(function (it) { return it.id; });
      return json(res, 200, { item: q, state: quoteState(q), client: client, terms: terms ? { version: terms.version } : null,
        totals: quotesLib.totals(q, q.acceptance ? q.acceptance.selected : []), totals_all: quotesLib.totals(q, allSel),
        url: q.token ? quoteUrl(publicOrigin(), q) : null, email: Boolean(NOTIFY_URL), payments: Boolean(SECRET) });
    }
    if (!action && m === 'PATCH') {
      if (['accepted', 'declined', 'void'].indexOf(q.status) >= 0) return json(res, 409, { error: 'A ' + q.status + ' quote can’t be edited. Duplicate it to make a new version.' });
      const body = await readJson(req, 131072);
      if (body && q.status !== 'draft') delete body.client_id;
      const v = quotesLib.validateQuote(body, true);
      if (v.error) return json(res, 400, { error: v.error });
      if (v.data.client_id && !(await desk.get('client', v.data.client_id))) return json(res, 400, { error: 'Client not found.' });
      if (q.status !== 'draft') v.data.events = withEvent(q, 'edited');
      return json(res, 200, { item: await desk.update('quote', q.id, v.data) });
    }
    if (!action && m === 'DELETE') {
      if (q.status === 'accepted') return json(res, 409, { error: 'Signed quotes are kept as a record and can’t be deleted.' });
      await desk.remove('quote', q.id); return json(res, 200, { ok: true });
    }
    if (action === 'pdf' && m === 'GET') {
      if (q.status !== 'accepted' || !q.acceptance) return json(res, 409, { error: 'This quote hasn’t been signed.' });
      return sendPdf(res, signedPdf(q, client, await termsVersion(q.acceptance.terms_version)), signedPdfName(q));
    }
    if (m !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    // Removing a signed quote (for tests and mistakes): voids the open invoices it created, stops its monthly billing,
    // deletes its signed PDF, then the quote. Refused if anything was paid. The audit log keeps a record.
    if (action === 'delete-signed') {
      if (q.status !== 'accepted') return json(res, 409, { error: 'Only signed quotes use this. Delete other quotes normally.' });
      const body = (await readJson(req, 1024)) || {};
      if (clip(body.confirm, 40).toUpperCase() !== String(q.number || '').toUpperCase()) return json(res, 400, { error: 'Type the quote number exactly to confirm.' });
      const done = [];
      const invoices = (q.billing || []).filter(function (b) { return b.invoice_id; });
      if (invoices.length || (q.monthly_billing && (q.monthly_billing.schedule_id || q.monthly_billing.subscription_id))) {
        if (!SECRET) return json(res, 503, { error: 'Stripe isn’t set up on the server, so its invoices can’t be voided.' });
      }
      const fetched = [];
      for (const b of invoices) {
        try { fetched.push(await stripe('GET', '/v1/invoices/' + encodeURIComponent(b.invoice_id))); }
        catch (e) { if (e.status !== 404) return json(res, 502, { error: 'Couldn’t check invoice ' + (b.invoice_number || b.invoice_id) + ' in Stripe. Nothing was deleted.' }); }
      }
      const paid = fetched.filter(function (inv) { return inv.status === 'paid' || inv.amount_paid > 0; });
      if (paid.length) return json(res, 409, { error: 'Invoice ' + (paid[0].number || paid[0].id) + ' from this quote has been paid. Refund it in Stripe first, then void it, and try again. Nothing was deleted.' });
      try {
        for (const inv of fetched) {
          if (inv.status === 'open') { await stripe('POST', '/v1/invoices/' + inv.id + '/void'); done.push('voided ' + (inv.number || inv.id)); }
          else if (inv.status === 'draft') { await stripe('DELETE', '/v1/invoices/' + inv.id); done.push('deleted draft invoice'); }
        }
        const mb = q.monthly_billing || {};
        if (mb.schedule_id) {
          try { await stripe('POST', '/v1/subscription_schedules/' + mb.schedule_id + '/cancel'); done.push('canceled monthly billing'); }
          catch (e) { if (!/released|canceled|completed/i.test(e.message)) throw e; }
        }
        if (mb.subscription_id) {
          try { await stripe('DELETE', '/v1/subscriptions/' + mb.subscription_id); if (done.indexOf('canceled monthly billing') < 0) done.push('canceled monthly billing'); }
          catch (e) { if (e.status !== 404 && !/canceled/i.test(e.message)) throw e; }
        }
      } catch (e) {
        console.error('quote_delete_signed_stripe_failed', q.id, e.message);
        return json(res, 502, { error: 'Stripe: ' + e.message + ' The quote was kept; check its invoices in Stripe and try again.' });
      }
      if (q.signed_file_id) { const f = await desk.getFileMeta(q.signed_file_id); if (f) { await deleteStoredFile(f); done.push('deleted signed PDF'); } }
      await desk.remove('quote', q.id);
      await adminAudit(req, q.client_id, 'quote', 'Signed quote deleted', (q.number || '') + ' · ' + (q.title || '') + (done.length ? ' · ' + done.join(', ') : ''));
      return json(res, 200, { ok: true, done: done });
    }
    if (action === 'send') {
      if (['draft', 'sent', 'viewed'].indexOf(q.status) < 0) return json(res, 409, { error: 'Only draft or open quotes can be sent.' });
      const t = quotesLib.totals(q, (q.items || []).filter(function (it) { return it.optional; }).map(function (it) { return it.id; }));
      if (t.total <= 0 && t.monthly <= 0) return json(res, 400, { error: 'Add at least one priced line before sending.' });
      if (q.valid_until && q.valid_until < deskLib.localDate()) return json(res, 400, { error: 'The valid-through date has passed. Change it before sending.' });
      const body = (await readJson(req, 4096)) || {};
      const to = clip(body.to || (client && client.email), 200).toLowerCase();
      const emailIt = body.email !== false;
      if (emailIt && !EMAIL_RE.test(to)) return json(res, 400, { error: 'Add the client’s email address (on their client record) to email the quote.' });
      const token = q.token || crypto.randomBytes(24).toString('base64url');
      const link = publicOrigin() + '/quote/?t=' + token;
      let emailed = false; let emailError = null;
      if (emailIt) {
        if (!NOTIFY_URL) emailError = 'Email isn’t set up on the server (PAYMENTS_NOTIFY_URL). Copy the link and send it yourself.';
        else {
          const t0 = quotesLib.totals(q, []);
          try {
            await quoteEmail({ to: to, name: client ? client.name || '' : '', subject: 'Quote ' + q.number + ' from Aethera Digital: ' + q.title, heading: 'Your quote is ready',
              intro: 'Here’s your quote for ' + q.title + '. You can review the scope, choose any add-ons, read the terms and sign online.' + (q.valid_until ? ' This quote is valid through ' + longDate(q.valid_until) + '.' : ''),
              amount_label: t0.total ? 'Project Total' : 'Monthly', amount: t0.total ? money(t0.total, 'usd') : money(t0.monthly, 'usd') + '/mo', url: link, button: 'Review & Sign' });
            emailed = true;
          } catch (e) { emailError = 'The email didn’t send. Copy the link and send it yourself.'; console.error('quote_send_email_failed', e.message); }
        }
      }
      const upd = { token: token, status: q.status === 'draft' ? 'sent' : q.status, sent_at: q.sent_at || new Date().toISOString(), events: withEvent(q, 'sent', { to: emailed ? to : null }) };
      const item = await desk.update('quote', q.id, upd);
      await adminAudit(req, q.client_id, 'quote', q.sent_at ? 'Quote re-sent' : 'Quote sent', (q.number || '') + ' · ' + (q.title || '') + (emailed ? ' · emailed to ' + to : ''));
      if (client && ['lead', 'prospect'].indexOf(client.status) >= 0) await desk.update('client', client.id, { status: 'proposal' });
      return json(res, 200, { item: item, url: link, emailed: emailed, email_error: emailError });
    }
    if (action === 'void') {
      if (q.status === 'accepted') return json(res, 409, { error: 'Signed quotes can’t be withdrawn. Void their invoices from Invoices instead.' });
      const item = await desk.update('quote', q.id, { status: 'void', events: withEvent(q, 'withdrawn') });
      if (q.status !== 'draft') await adminAudit(req, q.client_id, 'quote', 'Quote withdrawn', (q.number || '') + ' · ' + (q.title || ''));
      return json(res, 200, { item: item });
    }
    if (action === 'duplicate') {
      const today = deskLib.localDate();
      const copyFields = ['title', 'summary', 'standard_rate', 'rate', 'startup_discount_pct', 'days_until_due', 'items', 'schedule', 'key_dates', 'included', 'not_included', 'notes', 'prepared_by', 'monthly_start'];
      const d = { number: quotesLib.nextNumber(client, await desk.allOf('quote'), today.slice(0, 4)), issued: today, valid_until: addDays(today, 30), status: 'draft', events: [{ at: new Date().toISOString(), what: 'created', from: q.number }] };
      copyFields.forEach(function (k) { if (q[k] !== undefined) d[k] = q[k]; });
      return json(res, 200, { item: await desk.create('quote', d, { client_id: q.client_id }) });
    }
    if (action === 'bill') {
      if (q.status !== 'accepted') return json(res, 409, { error: 'Only signed quotes can be billed.' });
      const i = Number(mm[3]);
      const b = (q.billing || [])[i];
      if (!b) return json(res, 404, { error: 'Payment not found.' });
      if (b.status === 'invoiced') return json(res, 409, { error: 'That payment has already been invoiced.' });
      if (quoteLocks.has(q.id)) return json(res, 409, { error: 'Billing is already running for this quote.' });
      quoteLocks.add(q.id);
      try {
        const nb = await issueInstallment(q, client, b);
        const billing = q.billing.slice(); billing[i] = nb;
        const item = await desk.update('quote', q.id, { billing: billing, events: withEvent(q, 'billed', { installment: i }) });
        if (nb.status === 'failed') return json(res, 502, { error: nb.error, item: item });
        return json(res, 200, { item: item });
      } finally { quoteLocks.delete(q.id); }
    }
    if (action === 'start-monthly') {
      if (q.status !== 'accepted' || !q.monthly_billing || q.monthly_billing.status !== 'failed') return json(res, 409, { error: 'There’s no monthly billing to retry.' });
      const mb = await startMonthly(q, client, quotesLib.totals(q, q.acceptance.selected));
      const item = await desk.update('quote', q.id, { monthly_billing: mb });
      return mb.status === 'failed' ? json(res, 502, { error: mb.error, item: item }) : json(res, 200, { item: item });
    }
    if (action === 'resend-signed') {
      if (q.status !== 'accepted') return json(res, 409, { error: 'This quote hasn’t been signed.' });
      if (!NOTIFY_URL) return json(res, 503, { error: 'Email isn’t set up on the server.' });
      try { await sendSignedCopy(q, client, await termsVersion(q.acceptance.terms_version)); } catch (e) { return json(res, 502, { error: 'The email didn’t send: ' + e.message }); }
      return json(res, 200, { item: await desk.get('quote', q.id) });
    }
    return json(res, 404, { error: 'Not found' });
  }
  if (p === '/terms' && m === 'GET') {
    const cur = await currentTerms();
    const all = (await desk.allOf('terms')).sort(function (a, b) { return b.version - a.version; });
    return json(res, 200, { current: cur, versions: all });
  }
  if (p === '/terms' && m === 'POST') {
    const body = await readJson(req, 65536);
    const text = clip(body && body.body, 30000);
    if (text.length < 20) return json(res, 400, { error: 'Write out the terms.' });
    const cur = await currentTerms();
    if (text === cur.body) return json(res, 400, { error: 'No changes to save.' });
    const item = await desk.create('terms', { version: cur.version + 1, body: text, note: clip(body.note, 200) }, {});
    return json(res, 200, { current: item });
  }
  if (p === '/catalog' && m === 'GET') {
    let items = await desk.allOf('catalog');
    if (!items.length && !(await desk.seen('catalog-seeded'))) {
      for (const it of quotesLib.DEFAULT_CATALOG) await desk.create('catalog', quotesLib.validateCatalogItem(it).data, {});
      await desk.markSeen('catalog-seeded');
      items = await desk.allOf('catalog');
    }
    return json(res, 200, { items: items.sort(function (a, b) { return a.name.localeCompare(b.name); }) });
  }
  if (p === '/catalog' && m === 'POST') {
    const v = quotesLib.validateCatalogItem(await readJson(req, 16384));
    if (v.error) return json(res, 400, { error: v.error });
    return json(res, 200, { item: await desk.create('catalog', v.data, {}) });
  }
  mm = p.match(/^\/catalog\/(cat_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'PATCH') {
    const v = quotesLib.validateCatalogItem(await readJson(req, 16384));
    if (v.error) return json(res, 400, { error: v.error });
    const item = await desk.update('catalog', mm[1], v.data);
    return item ? json(res, 200, { item: item }) : json(res, 404, { error: 'Not found.' });
  }
  if (mm && m === 'DELETE') { await desk.remove('catalog', mm[1]); return json(res, 200, { ok: true }); }
  return null;
}

// ---------- Monthly report drafts ----------
// A draft report for every active client, once per month. A draft that was deleted on purpose isn't recreated
// by the schedule (each client/month is remembered), but "Create Drafts" on the Reports page (force) brings it back.
const reportsLib = require('./lib/reports');
const reportingLib = require('./lib/reporting');
async function ensureReportDrafts(period, force) {
  const clients = (await desk.allOf('client')).filter(function (c) { return c.status === 'active'; });
  const reports = await desk.allOf('report');
  let created = 0;
  for (const c of clients) {
    if (reports.some(function (r) { return r.client_id === c.id && r.period === period; })) continue;
    const key = 'report-draft:' + c.id + ':' + period;
    if (!force && await desk.seen(key)) continue;
    const draft = { client_id: c.id, period: period, metrics: {}, status: 'draft', created_by: 'auto' };
    const hm = healthLib.metricsFor(await desk.list('asset', { client_id: c.id }), period);
    if (hm) Object.assign(draft, reportingLib.mergeMetrics(draft, 'health', hm));
    delete draft.written; delete draft.kept;
    await desk.create('report', draft, { client_id: c.id });
    await desk.markSeen(key);
    created++;
  }
  if (created) console.log('report_drafts_created ' + JSON.stringify({ period: period, created: created }));
  return created;
}
function scheduleReportDrafts() {
  if (process.env.REPORT_DRAFTS === 'off') return;
  const run = function () {
    deskInit().then(function () { return ensureReportDrafts(deskLib.lastFullMonth(), false); })
      .catch(function (e) { console.error('report_drafts_failed', e.message); });
  };
  setTimeout(run, 5000).unref();
  setInterval(run, 6 * 3600 * 1000).unref();
}

async function reportCommentary(req, res, id) {
  if (!ANTHROPIC_KEY) return json(res, 503, { error: 'Set ANTHROPIC_API_KEY on the server to draft with Claude.' });
  const report = await desk.get('report', id);
  if (!report) return json(res, 404, { error: 'Report not found.' });
  const client = await desk.get('client', report.client_id);
  if (!client) return json(res, 404, { error: 'Client not found.' });
  // Use the numbers on screen (they may not be saved yet).
  const body = (await readJson(req, 16384)) || {};
  if (body.metrics) {
    const v = deskLib.validate('report', { metrics: body.metrics }, true);
    if (v.error) return json(res, 400, { error: v.error });
    report.metrics = v.data.metrics;
  }
  const where = { client_id: client.id };
  const [reports, projects, tasks, approvals, suggestions] = await Promise.all([desk.list('report', where), desk.list('project', where),
    desk.list('task', where), desk.list('approval', where), desk.list('suggestion', where)]);
  const context = reportsLib.buildContext(client, report, { reports: reports, projects: projects, tasks: tasks, approvals: approvals, suggestions: suggestions }, deskLib.prevMonth);
  try {
    const draft = await reportsLib.draftCommentary(context, { model: REPORT_MODEL, apiKey: ANTHROPIC_KEY, apiBase: ANTHROPIC_BASE });
    return json(res, 200, { draft: draft, used: { metrics: Object.keys(context.metrics_this_month).length, work: context.work_completed.length,
      decisions: context.decisions_made.length, follow_ups: context.follow_ups_from_email_and_meetings.length } });
  } catch (e) {
    console.error('report_commentary_failed', id, e.message);
    return json(res, 502, { error: 'Claude couldn’t draft this right now. Please try again.' });
  }
}

// ---------- Digital Health ----------
const healthLib = require('./lib/health');
const HEALTH_ALLOW_PRIVATE = process.env.HEALTH_FETCH_ALLOW_PRIVATE === '1'; // tests only: lets scans reach 127.0.0.1

// Draft reports carry the client's Digital Health numbers (average of its live assets' latest scans in that month).
// Numbers typed by hand are kept; reports marked Ready or Sent are left alone.
async function syncHealthReports(clientId) {
  if (!clientId) return;
  const [assets, reports] = await Promise.all([desk.list('asset', { client_id: clientId }), desk.list('report', { client_id: clientId })]);
  for (const r of reports) {
    if ((r.status || 'draft') !== 'draft') continue;
    const hm = healthLib.metricsFor(assets, r.period);
    if (!hm) continue;
    const merged = reportingLib.mergeMetrics(r, 'health', hm);
    if (merged.written.length) await desk.update('report', r.id, { metrics: merged.metrics, sources: merged.sources });
  }
}

async function healthFetch(req, res) {
  const body = (await readJson(req, 4096)) || {};
  try {
    return json(res, 200, await healthLib.fetchPage(body.url, { allowPrivate: HEALTH_ALLOW_PRIVATE }));
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

async function healthReview(req, res, id) {
  if (!ANTHROPIC_KEY) return json(res, 503, { error: 'Set ANTHROPIC_API_KEY on the server to review with Claude.' });
  const a = await desk.get('asset', id);
  if (!a) return json(res, 404, { error: 'Asset not found.' });
  if (!a.scan || !a.scan.text) return json(res, 400, { error: 'Scan the page first.' });
  const c = a.client_id ? await desk.get('client', a.client_id) : null;
  try {
    const review = await healthLib.draftReview(healthLib.reviewContext(a, c && (c.company || c.name)), { model: REPORT_MODEL, apiKey: ANTHROPIC_KEY, apiBase: ANTHROPIC_BASE });
    return json(res, 200, { item: await desk.update('asset', a.id, { review: review }) });
  } catch (e) {
    console.error('health_review_failed', id, e.message);
    return json(res, 502, { error: 'Claude couldn’t review this right now. Please try again.' });
  }
}

// A failed check or a Claude recommendation becomes a to-do in the client's General To-Dos.
async function generalTodos(clientId) {
  const projects = await desk.list('project', { client_id: clientId });
  let project = projects.find(function (p) { return String(p.name || '').toLowerCase() === 'general to-dos'; });
  return project || desk.create('project', { client_id: clientId, name: 'General To-Dos', status: 'in_progress', description: 'Follow-ups from email and meetings.' }, { client_id: clientId });
}
async function healthFix(req, res, id) {
  const a = await desk.get('asset', id);
  if (!a) return json(res, 404, { error: 'Asset not found.' });
  if (!a.client_id) return json(res, 400, { error: 'Assign this asset to a client to add to-dos.' });
  const body = (await readJson(req, 4096)) || {};
  const check = body.check_id && healthLib.fields.checks({ [body.check_id]: {} }).value[body.check_id] ? body.check_id : null;
  const title = clip(body.title || '', 300);
  if (!check && !title) return json(res, 400, { error: 'Choose a fix.' });
  const project = await generalTodos(a.client_id);
  const existing = await desk.list('task', { project_id: project.id });
  const H = require('./public/assets/health.js');
  const text = check ? H.CHECK_BY_ID[check].name + ' — ' + a.name : title + ' — ' + a.name;
  const task = await desk.create('task', { project_id: project.id, title: clip(text, 300), done: false, position: existing.length }, { client_id: a.client_id, project_id: project.id });
  let item = a;
  if (check) {
    const checks = Object.assign({}, a.checks || {}); checks[check] = Object.assign({}, checks[check] || {}, { task_id: task.id });
    item = await desk.update('asset', a.id, { checks: checks });
  }
  return json(res, 200, { item: item, task: task, project: { id: project.id, name: project.name } });
}
async function healthRelink(req, res, id) {
  const a = await desk.get('asset', id);
  if (!a) return json(res, 404, { error: 'Asset not found.' });
  const body = (await readJson(req, 1024)) || {};
  const cid = body.client_id ? String(body.client_id) : null;
  if (cid && !(await desk.get('client', cid))) return json(res, 400, { error: 'Client not found.' });
  const item = await desk.relink('asset', id, cid);
  await syncHealthReports(a.client_id); await syncHealthReports(cid);
  return json(res, 200, { item: item });
}

// Import assets exported from the standalone Digital Health tool. Each asset is matched to a client by name,
// business name or "Also match" names; anything unmatched comes in as an internal (Aethera) asset.
async function healthImport(req, res) {
  const body = await readJson(req, 2 * 1024 * 1024);
  const list = body && Array.isArray(body.assets) ? body.assets.slice(0, 500) : null;
  if (!list) return json(res, 400, { error: 'Choose an export file.' });
  const clients = await desk.allOf('client');
  const norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  const match = function (name) {
    const n = norm(name); if (!n) return null;
    return clients.find(function (c) {
      return [c.name, c.company].concat(String(c.aliases || '').split(/[,;\n]/)).some(function (x) { return norm(x) && norm(x) === n; });
    }) || null;
  };
  const existing = await desk.allOf('asset');
  const out = { created: 0, skipped: 0, internal: 0, errors: [] };
  const touched = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const c = match(raw.client);
    const input = Object.assign({}, raw); delete input.client; delete input.id; delete input.client_id;
    if (c) input.client_id = c.id;
    if (input.status === 'In progress') input.status = 'in_progress';
    input.status = ['live', 'in_progress', 'planned', 'archived'].indexOf(input.status) >= 0 ? input.status : String(input.status || '').toLowerCase() === 'live' ? 'live' : 'in_progress';
    const v = deskLib.validate('asset', input, false);
    if (v.error) { out.errors.push((raw.name || 'Untitled') + ': ' + v.error); continue; }
    if (existing.some(function (e) { return e.name === v.data.name && (e.client_id || null) === (c ? c.id : null); })) { out.skipped++; continue; }
    await desk.create('asset', v.data, c ? { client_id: c.id } : {});
    out.created++; if (!c) out.internal++; else touched.add(c.id);
  }
  for (const cid of touched) await syncHealthReports(cid);
  return json(res, 200, out);
}

// ---------- Suggested to-dos: Apps Script collector -> Claude -> Desk ----------
const collectorLib = require('./lib/collector');
const COLLECTOR_TOKEN = process.env.DESK_COLLECTOR_TOKEN || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const ANTHROPIC_BASE = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
const REPORT_MODEL = process.env.ANTHROPIC_REPORT_MODEL || ANTHROPIC_MODEL;
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
  // Reporting Apps Script: which clients to pull for, and the numbers it pulled.
  if (p === '/api/collector/reporting' && req.method === 'GET') {
    const q = url.searchParams.get('period');
    const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(q || '') ? q : deskLib.lastFullMonth();
    return json(res, 200, { period: period, clients: reportingLib.reportingClients(await desk.allOf('client')) });
  }
  if (p === '/api/collector/metrics' && req.method === 'POST') return receiveMetrics(req, res);
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

// One client's numbers from one source for one month. Errors are recorded too, so the client page can say
// what's wrong (e.g. no access to the property). Reviewed (ready/sent) reports are never changed.
async function receiveMetrics(req, res) {
  const body = await readJson(req, 16384);
  if (!body || !reportingLib.SOURCES[body.source] || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(body.period || ''))) return json(res, 400, { error: 'Invalid request.' });
  const client = await desk.get('client', String(body.client_id || ''));
  if (!client) return json(res, 404, { error: 'Client not found.' });
  const source = body.source; const period = body.period;
  const sync = Object.assign({}, client.report_sync || {});
  const record = async function (ok, message) {
    sync[source] = { at: new Date().toISOString(), period: period, ok: ok, message: clip(message, 300) };
    await desk.update('client', client.id, { report_sync: sync });
  };
  if (body.error) {
    await record(false, body.error);
    console.warn('reporting_pull_failed ' + JSON.stringify({ client: client.id, source: source, error: clip(body.error, 200) }));
    return json(res, 200, { ok: true, recorded: 'error' });
  }
  const v = deskLib.validate('report', { metrics: body.metrics || {} }, true);
  if (v.error) { await record(false, v.error); return json(res, 400, { error: v.error }); }
  let report = (await desk.list('report', { client_id: client.id })).find(function (r) { return r.period === period; });
  if (report && report.status && report.status !== 'draft') {
    await record(true, 'Report already marked ' + (report.status === 'sent' ? 'sent' : 'ready') + '; numbers left as they are.');
    return json(res, 200, { ok: true, written: [], kept: [], reviewed: true });
  }
  if (!report) report = await desk.create('report', { client_id: client.id, period: period, metrics: {}, status: 'draft', created_by: 'auto' }, { client_id: client.id });
  const merged = reportingLib.mergeMetrics(report, source, v.data.metrics);
  if (merged.written.length) await desk.update('report', report.id, { metrics: merged.metrics, sources: merged.sources });
  await record(true, merged.written.length + ' number' + (merged.written.length === 1 ? '' : 's') + ' updated' + (merged.kept.length ? ', ' + merged.kept.length + ' kept as entered by hand' : ''));
  return json(res, 200, { ok: true, report_id: report.id, written: merged.written, kept: merged.kept });
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

// ---------- Client portal (client.aetheradigital.com) ----------
// One login per client: the client's email in the Desk, once "Portal access" is turned on there. Clients sign in with a
// one-time link (15 minutes) emailed through the Apps Script, get a 30-day session cookie scoped to the portal host, and see
// only their own sent reports, projects, shared files, approvals, Stripe invoices and activity. Every sign-in, view,
// download, approval and payment is written to the append-only audit log (lib/portal.js), which the Desk shows in full.
const r2 = require('./lib/r2').create();
const portalLib = require('./lib/portal');
const portal = portalLib.createPortalStore(desk);
const CLIENT_COOKIE = 'aethera_client';
const R2_MAX_FILE_BYTES = 50 * 1024 * 1024;
let portalReady = null;
function portalInit() {
  if (!portalReady) portalReady = deskInit().then(function () { return portal.init(); }).catch(function (e) { portalReady = null; throw e; });
  return portalReady;
}
function fileLimit() { return r2.enabled ? R2_MAX_FILE_BYTES : MAX_FILE_BYTES; }
function fileLimitText() { return r2.enabled ? '50 MB' : '15 MB'; }

// Saves an uploaded file: to Cloudflare R2 when it's configured, otherwise in Postgres.
async function storeFile(f) {
  const id = deskLib.newFileId();
  const rec = Object.assign({}, f, { id: id, size: f.content.length });
  if (r2.enabled) {
    rec.r2_key = 'clients/' + f.client_id + '/' + id;
    await r2.put(rec.r2_key, f.content, f.mime);
  }
  return desk.putFile(rec);
}
// Sends a stored file: a 10-minute R2 download link, or the bytes from the database.
async function sendStoredFile(res, meta) {
  if (meta.r2_key) {
    if (!r2.enabled) return json(res, 503, { error: 'File storage isn’t configured on the server.' });
    return send(res, 302, '', { Location: r2.downloadUrl(meta.r2_key, meta.name, 600), 'Cache-Control': 'no-store' });
  }
  const f = await desk.getFile(meta.id);
  if (!f || !f.content) return json(res, 404, { error: 'File not found.' });
  return send(res, 200, f.content, {
    'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="' + String(f.name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.name)
  });
}
async function deleteStoredFile(meta) {
  if (meta && meta.r2_key && r2.enabled) { try { await r2.remove(meta.r2_key); } catch (e) { console.error('r2_delete_failed', meta.r2_key, e.message); } }
  if (meta) await desk.removeFile(meta.id);
}

function reqMeta(req) { return { ip: ipOf(req), device: portalLib.deviceOf(req.headers['user-agent']) }; }
// Writes an audit entry. Never throws: a logging hiccup must not break the action itself.
async function audit(req, e) {
  try { await portalInit(); await portal.log(Object.assign(req ? reqMeta(req) : {}, e)); }
  catch (x) { console.error('audit_failed', e.event, x.message); }
}
function adminAudit(req, clientId, category, event, detail) {
  return audit(req, { client_id: clientId, actor_type: 'admin', actor: 'Aethera team', category: category, event: event, detail: detail });
}

function portalBase(req) {
  const s = siteOf(req);
  if (s === 'client' || s === 'admin' || s === 'public') return 'https://' + CLIENT_HOST + '/';
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host + '/client/';
}
function clientCookie(req, value, maxAge) {
  const secure = /https/.test(String(req.headers['x-forwarded-proto'] || '')) || siteOf(req) === 'client';
  return CLIENT_COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}
function portalEmailOf(c) { return String((c && c.email) || '').trim().toLowerCase(); }
function portalOpen(c) { return Boolean(c && c.portal_access && c.status !== 'past' && EMAIL_RE.test(portalEmailOf(c))); }

async function sendPortalLink(req, c, welcome) {
  if (!NOTIFY_URL) throw Object.assign(new Error('Email isn’t set up on the server (PAYMENTS_NOTIFY_URL).'), { status: 503 });
  const t = portalLib.token();
  await portal.addToken({ hash: portalLib.hash(t), client_id: c.id, email: portalEmailOf(c), expires_at: Date.now() + portalLib.LINK_TTL_MS, ip: ipOf(req) });
  await quoteEmail({
    to: c.email, name: c.name || '',
    subject: welcome ? 'Your Aethera client portal is ready' : 'Your sign-in link for the Aethera client portal',
    heading: welcome ? 'Your client portal is ready' : 'Sign in to your client portal',
    intro: (welcome ? 'You now have a private portal for your reports, projects, files, approvals and billing with Aethera Digital. ' : '') +
      'Use the button below to sign in. The link expires in 15 minutes and works once. If you didn’t ask for this, you can ignore this email.',
    button: 'Sign in to my portal', url: portalBase(req) + '?t=' + t
  });
}

async function portalLogin(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 5, 'portal-login')) return json(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
  const body = await readJson(req, 1024);
  const email = clip(body && body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter the email address on file for your account.' });
  // Same answer whether or not the email has access, so the form can't be used to find client emails.
  const done = { ok: true };
  await portalInit();
  const matches = (await desk.allOf('client')).filter(function (c) { return portalOpen(c) && portalEmailOf(c) === email; });
  if (matches.length !== 1) { if (matches.length > 1) console.error('portal_duplicate_email'); return json(res, 200, done); }
  const c = matches[0];
  if (await portal.recentTokens(c.id, portalLib.LINK_TTL_MS) >= 3) {
    await audit(req, { client_id: c.id, actor_type: 'client', actor: clientName(c), category: 'security', event: 'Too many sign-in links requested', detail: 'No link sent', flagged: true });
    return json(res, 200, done);
  }
  try { await sendPortalLink(req, c, false); } catch (e) {
    console.error('portal_link_email_failed', e.message);
    return json(res, 502, { error: 'We couldn’t send the email right now. Please try again in a few minutes.' });
  }
  await audit(req, { client_id: c.id, actor_type: 'client', actor: clientName(c), category: 'signin', event: 'Sign-in link requested', detail: 'Emailed to ' + email });
  return json(res, 200, done);
}

async function portalVerify(req, res) {
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 10, 'portal-verify')) return json(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
  const body = await readJson(req, 1024);
  const t = clip(body && body.token, 100);
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(t)) return json(res, 400, { error: 'This sign-in link isn’t valid. Request a new one below.' });
  await portalInit();
  const r = await portal.useToken(portalLib.hash(t));
  if (!r.ok) {
    if (r.row) await audit(req, { client_id: r.row.client_id, actor_type: 'client', category: 'security', event: r.reason === 'used' ? 'Used sign-in link opened again' : 'Expired sign-in link used', detail: 'Sign-in refused', flagged: true });
    return json(res, 400, { error: r.reason === 'used' ? 'This link has already been used. Request a new one below.' : 'This link has expired. Request a new one below.' });
  }
  const c = await desk.get('client', r.row.client_id);
  if (!portalOpen(c) || portalEmailOf(c) !== r.row.email) return json(res, 403, { error: 'Portal access for this account is turned off. Contact hello@aetheradigital.com.' });
  const meta = reqMeta(req);
  const known = await portal.knownDevice(c.id, meta.device);
  const sid = portalLib.token();
  await portal.addSession({ hash: portalLib.hash(sid), client_id: c.id, device: meta.device, ip: meta.ip, expires_at: Date.now() + portalLib.SESSION_TTL_MS });
  await audit(req, { client_id: c.id, actor_type: 'client', actor: clientName(c), category: 'signin', event: 'Signed in', detail: 'One-time link sent to the email on file' });
  if (known.total > 0 && known.same === 0) await audit(req, { client_id: c.id, actor_type: 'client', actor: clientName(c), category: 'security', event: 'Sign-in from a new device', detail: 'First sign-in from ' + meta.device, flagged: true });
  return json(res, 200, { ok: true }, { 'Set-Cookie': clientCookie(req, sid, Math.floor(portalLib.SESSION_TTL_MS / 1000)) });
}

async function portalSession(req) {
  const sid = parseCookies(req)[CLIENT_COOKIE] || '';
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(sid)) return null;
  await portalInit();
  const h = portalLib.hash(sid);
  const s = await portal.getSession(h);
  if (!s) return null;
  const c = await desk.get('client', s.client_id);
  if (!portalOpen(c)) return null;
  if (Date.now() - Date.parse(s.last_seen) > 5 * 60000) portal.touchSession(h).catch(function () {});
  return { hash: h, client: c };
}
function clientAudit(req, s, category, event, detail) {
  return audit(req, { client_id: s.client.id, actor_type: 'client', actor: clientName(s.client), category: category, event: event, detail: detail });
}

function monthLabel(period) {
  const a = String(period).split('-');
  return new Date(Date.UTC(Number(a[0]), Number(a[1]) - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function activityRow(e, name) {
  return { at: e.at, category: e.category, event: e.event, detail: e.detail || '',
    by: e.actor_type === 'client' ? name : e.actor_type === 'admin' ? 'Aethera team' : (e.actor || 'Aethera'), device: e.actor_type === 'client' ? (e.device || '') : '' };
}

async function portalData(req, res, s) {
  const c = s.client; const name = clientName(c);
  const [projects, tasks, approvals, reports, files, activity, quotes] = await Promise.all([
    desk.list('project', { client_id: c.id }), desk.list('task', { client_id: c.id }), desk.list('approval', { client_id: c.id }),
    desk.list('report', { client_id: c.id }), desk.listFiles(c.id), portal.audit({ client_id: c.id, limit: 300 }), desk.list('quote', { client_id: c.id })]);
  const shared = files.filter(function (f) { return f.shared; });
  const fileById = {}; shared.forEach(function (f) { fileById[f.id] = f; });
  const sent = reports.filter(function (r) { return r.status === 'sent'; }).sort(function (a, b) { return a.period < b.period ? 1 : -1; });
  const groups = deskLib.reportGroupsFor(c.services);
  const visibleProjects = projects.filter(function (p) { return String(p.name || '').trim().toLowerCase() !== 'general to-dos'; })
    .sort(function (a, b) { return (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.created_at < b.created_at ? -1 : 1); });
  const latestHealth = sent.find(function (r) { return r.metrics && typeof r.metrics.health_score === 'number'; });
  const prevHealth = latestHealth && sent.find(function (r) { return r.period < latestHealth.period && r.metrics && typeof r.metrics.health_score === 'number'; });
  return json(res, 200, {
    client: { name: name, contact: c.name || '', email: c.email || '' },
    files_limit: fileLimitText(),
    metric_groups: deskLib.METRIC_GROUPS.filter(function (g) { return groups.indexOf(g.key) >= 0; }).map(function (g) { return { key: g.key, label: g.label, metrics: g.metrics }; }),
    reports: sent.map(function (r) {
      return { id: r.id, period: r.period, label: monthLabel(r.period), metrics: r.metrics || {}, summary: r.summary || '', wins: r.wins || '', next_actions: r.next_actions || '', sent_at: r.sent_at || '' };
    }),
    projects: visibleProjects.map(function (p) {
      return { id: p.id, name: p.name, status: p.status || 'planned', due: p.due || '', start: p.start || '', description: p.description || '',
        tasks: tasks.filter(function (t) { return t.project_id === p.id; }).sort(function (a, b) { return (a.position || 0) - (b.position || 0) || (a.created_at < b.created_at ? -1 : 1); })
          .map(function (t) { return { title: t.title, done: Boolean(t.done), due: t.due || '' }; }) };
    }),
    files: shared.map(function (f) { return { id: f.id, name: f.name, mime: f.mime || '', size: f.size || 0, category: f.category || 'other', created_at: f.created_at, uploaded_by: f.uploaded_by === 'client' ? 'client' : 'aethera' }; }),
    approvals: approvals.sort(function (a, b) { return (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (a.created_at < b.created_at ? 1 : -1); }).map(function (a) {
      const f = a.file_id && fileById[a.file_id];
      return { id: a.id, title: a.title, kind: a.kind || 'approval', status: a.status || 'pending', requested: a.requested || '', decided: a.decided || '',
        comment: a.client_comment || '', file: f ? { id: f.id, name: f.name, size: f.size || 0 } : null };
    }),
    quotes: quotes.filter(function (q) { return q.token && q.status !== 'draft' && q.status !== 'void'; })
      .sort(function (a, b) { return (b.sent_at || b.created_at) < (a.sent_at || a.created_at) ? -1 : 1; }).map(portalQuote),
    health: latestHealth ? { score: latestHealth.metrics.health_score, period: latestHealth.period, change: prevHealth ? latestHealth.metrics.health_score - prevHealth.metrics.health_score : null } : null,
    activity: activity.map(function (e) { return activityRow(e, name); })
  });
}

// Quotes the client has been sent (drafts and withdrawn quotes stay hidden). Opening one goes through /api/portal/quotes/:id,
// which logs it and forwards to the quote's signing page.
function portalQuote(q) {
  const t = quotesLib.totals(q, q.acceptance ? q.acceptance.selected : []);
  const state = quoteState(q);
  return { id: q.id, number: q.number || '', title: q.title || 'Quote', state: state,
    total_text: t.total ? money(t.total, 'usd') : '', monthly_text: t.monthly ? money(t.monthly, 'usd') + '/mo' : '',
    sent_at: q.sent_at || '', valid_until: q.valid_until || '', signed_at: q.acceptance ? q.acceptance.at : '', signed_by: q.acceptance ? q.acceptance.name : '',
    declined_at: q.declined ? q.declined.at : '' };
}

// ----- billing: the client's own Stripe invoices, matched by the email on file -----
async function clientCustomers(c) {
  if (!SECRET || !portalEmailOf(c)) return [];
  const r = await stripe('GET', '/v1/customers', { email: portalEmailOf(c), limit: 10 });
  return r.data || [];
}
async function ownedInvoice(c, id, expand) {
  if (!INVOICE_ID_RE.test(id)) return null;
  const ids = (await clientCustomers(c)).map(function (x) { return x.id; });
  let inv;
  try { inv = await stripe('GET', '/v1/invoices/' + encodeURIComponent(id), expand ? { expand: expand } : null); } catch (e) { if (e.status === 404) return null; throw e; }
  return inv && ids.indexOf(inv.customer) >= 0 && inv.status !== 'draft' ? inv : null;
}
function portalInvoice(inv) {
  const now = Date.now() / 1000;
  const lines = (inv.lines && inv.lines.data) || [];
  const status = inv.status === 'open' && inv.due_date && inv.due_date < now ? 'overdue' : inv.status;
  return { id: inv.id, number: inv.number || '', description: inv.description || (lines[0] && lines[0].description) || 'Invoice', status: status,
    issued: dateText(inv.effective_at || inv.created), due: dateText(inv.due_date), created: inv.created,
    total: inv.total, remaining: inv.amount_remaining, currency: inv.currency, total_text: money(inv.total, inv.currency), remaining_text: money(inv.amount_remaining, inv.currency),
    paid_on: inv.status_transitions && inv.status_transitions.paid_at ? dateText(inv.status_transitions.paid_at) : '',
    payable: inv.status === 'open' && inv.amount_remaining > 0, pdf: Boolean(inv.invoice_pdf) };
}
function methodOf(pm) {
  if (!pm || typeof pm !== 'object') return null;
  if (pm.card) return { type: 'card', brand: pm.card.brand || 'card', last4: pm.card.last4 || '', exp: pm.card.exp_month ? String(pm.card.exp_month).padStart(2, '0') + '/' + String(pm.card.exp_year).slice(-2) : '' };
  if (pm.us_bank_account) return { type: 'bank', brand: pm.us_bank_account.bank_name || 'Bank account', last4: pm.us_bank_account.last4 || '', exp: '' };
  return { type: pm.type || 'other', brand: pm.type || 'Payment method', last4: '', exp: '' };
}
async function portalBilling(req, res, s) {
  if (!SECRET) return json(res, 200, { enabled: false, invoices: [], method: null });
  try {
    const customers = await clientCustomers(s.client);
    const invoices = [];
    for (const cu of customers) {
      const list = await stripe('GET', '/v1/invoices', { customer: cu.id, limit: 50 });
      (list.data || []).forEach(function (inv) { if (inv.status !== 'draft') invoices.push(portalInvoice(inv)); });
    }
    invoices.sort(function (a, b) { return b.created - a.created; });
    let method = null;
    if (customers[0]) {
      const full = await stripe('GET', '/v1/customers/' + encodeURIComponent(customers[0].id), { expand: ['invoice_settings.default_payment_method'] });
      method = methodOf(full.invoice_settings && full.invoice_settings.default_payment_method);
    }
    const open = invoices.filter(function (i) { return i.payable; });
    return json(res, 200, { enabled: Boolean(PUBLISHABLE), test_mode: !LIVE, invoices: invoices, method: method,
      balance_text: money(open.reduce(function (t, i) { return t + i.remaining; }, 0), 'usd'), open_count: open.length });
  } catch (e) {
    console.error('portal_billing_failed', e.status, e.message);
    return json(res, 502, { error: 'We couldn’t load your invoices right now. Please try again.' });
  }
}
async function portalPay(req, res, s, id) {
  const inv = await ownedInvoice(s.client, id, ['confirmation_secret']);
  if (!inv) return json(res, 404, { error: 'We couldn’t find that invoice.' });
  if (!(inv.status === 'open' && inv.amount_remaining > 0 && inv.confirmation_secret && inv.confirmation_secret.client_secret)) return json(res, 409, { error: 'This invoice can’t be paid online. It may already be paid.' });
  return json(res, 200, { clientSecret: inv.confirmation_secret.client_secret, number: inv.number || '', amount_text: money(inv.amount_remaining, inv.currency), email: inv.customer_email || '' });
}
async function portalPaid(req, res, s, id) {
  const inv = await ownedInvoice(s.client, id);
  if (!inv) return json(res, 404, { error: 'We couldn’t find that invoice.' });
  await clientAudit(req, s, 'billing', inv.status === 'paid' ? 'Paid invoice' : 'Payment submitted', (inv.number || inv.id) + ' · ' + money(inv.status === 'paid' ? inv.amount_paid : inv.amount_remaining, inv.currency) + (inv.status === 'paid' ? '' : ' · processing'));
  return json(res, 200, { invoice: portalInvoice(inv) });
}
async function portalInvoicePdf(req, res, s, id) {
  const inv = await ownedInvoice(s.client, id);
  if (!inv || !inv.invoice_pdf) return json(res, 404, { error: 'We couldn’t find that invoice.' });
  await clientAudit(req, s, 'billing', inv.status === 'paid' ? 'Downloaded receipt' : 'Downloaded invoice', (inv.number || inv.id) + ' · ' + money(inv.total, inv.currency));
  return send(res, 302, '', { Location: inv.invoice_pdf, 'Cache-Control': 'no-store' });
}
async function portalSetupMethod(req, res, s) {
  let cu = (await clientCustomers(s.client))[0];
  if (!cu) cu = await findOrCreateCustomer(portalEmailOf(s.client), s.client.name || '', s.client.company || '', 'client_portal');
  const si = await stripe('POST', '/v1/setup_intents', { customer: cu.id, payment_method_types: PAYMENT_METHOD_TYPES, usage: 'off_session', metadata: { source: 'client_portal', desk_client: s.client.id } });
  return json(res, 200, { clientSecret: si.client_secret });
}
async function portalConfirmMethod(req, res, s) {
  const body = await readJson(req, 1024);
  const id = clip(body && body.setup_intent, 80);
  if (!/^seti_[A-Za-z0-9]+$/.test(id)) return json(res, 400, { error: 'Invalid request.' });
  const si = await stripe('GET', '/v1/setup_intents/' + encodeURIComponent(id), { expand: ['payment_method'] });
  const ids = (await clientCustomers(s.client)).map(function (x) { return x.id; });
  if (ids.indexOf(si.customer) < 0) return json(res, 404, { error: 'Not found.' });
  if (si.status !== 'succeeded' || !si.payment_method) return json(res, 409, { error: si.status === 'processing' ? 'Your bank account is still being verified. We’ll use it once that finishes.' : 'That payment method wasn’t saved. Please try again.' });
  await stripe('POST', '/v1/customers/' + encodeURIComponent(si.customer), { invoice_settings: { default_payment_method: si.payment_method.id } });
  const m = methodOf(si.payment_method);
  await clientAudit(req, s, 'billing', 'Updated payment method', m ? (m.brand + (m.last4 ? ' •••• ' + m.last4 : '')) : '');
  return json(res, 200, { method: m });
}

async function portalApi(req, res, url) {
  const p = url.pathname.replace(/^\/api\/portal/, '') || '/';
  const m = req.method;
  try { await portalInit(); } catch (e) {
    console.error('portal_db_unavailable', e.message);
    return json(res, 503, { error: 'The portal is unavailable right now. Please try again shortly.' });
  }
  if (p === '/login' && m === 'POST') return portalLogin(req, res);
  if (p === '/verify' && m === 'POST') return portalVerify(req, res);
  const s = await portalSession(req);
  if (p === '/session' && m === 'GET') return json(res, 200, { signed_in: Boolean(s), name: s ? clientName(s.client) : null });
  if (!s) return json(res, 401, { error: 'Please sign in.' }, { 'Set-Cookie': clientCookie(req, '', 0) });
  if (m !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 240, 'portal')) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });

  if (p === '/logout' && m === 'POST') {
    await portal.endSession(s.hash);
    await clientAudit(req, s, 'signin', 'Signed out', 'Session ended');
    return json(res, 200, { ok: true }, { 'Set-Cookie': clientCookie(req, '', 0) });
  }
  if (p === '/data' && m === 'GET') return portalData(req, res, s);
  if (p === '/event' && m === 'POST') {
    const body = await readJson(req, 1024);
    if (body && body.type === 'report_view' && /^rep_/.test(String(body.id || ''))) {
      const r = await desk.get('report', body.id);
      if (r && r.client_id === s.client.id && r.status === 'sent') await clientAudit(req, s, 'report', 'Viewed report', monthLabel(r.period) + ' monthly report');
    }
    return json(res, 200, { ok: true });
  }

  // quotes: log the open, then go to the quote's own review & sign page
  let mm = p.match(/^\/quotes\/(quo_[A-Za-z0-9_-]+)\/pdf$/);
  if (mm && m === 'GET') {
    const q = await desk.get('quote', mm[1]);
    if (!q || q.client_id !== s.client.id || q.status !== 'accepted' || !q.acceptance) return json(res, 404, { error: 'Signed quote not found.' });
    await clientAudit(req, s, 'quote', 'Downloaded signed quote', (q.number || '') + ' · ' + (q.title || ''));
    return sendPdf(res, signedPdf(q, s.client, await termsVersion(q.acceptance.terms_version)), signedPdfName(q));
  }
  mm = p.match(/^\/quotes\/(quo_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'GET') {
    const q = await desk.get('quote', mm[1]);
    if (!q || q.client_id !== s.client.id || !q.token || q.status === 'draft' || q.status === 'void') return json(res, 404, { error: 'Quote not found.' });
    await clientAudit(req, s, 'quote', q.status === 'accepted' ? 'Opened signed quote' : 'Opened quote', (q.number || '') + ' · ' + (q.title || ''));
    return send(res, 302, '', { Location: quoteUrl(publicOrigin(), q), 'Cache-Control': 'no-store' });
  }

  // files: download a shared file, upload a new one (shared back to Aethera)
  mm = p.match(/^\/files\/(fil_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'GET') {
    const f = await desk.getFileMeta(mm[1]);
    if (!f || f.client_id !== s.client.id || !f.shared) return json(res, 404, { error: 'File not found.' });
    await clientAudit(req, s, 'file', 'Downloaded file', f.name);
    return sendStoredFile(res, f);
  }
  if (p === '/files' && m === 'POST') {
    if (limited(req, 30, 'portal-upload')) return json(res, 429, { error: 'Too many uploads. Please wait a minute.' });
    const name = clip(url.searchParams.get('name') || 'file', 200).replace(/[\\/\0\r\n"]/g, '_');
    let content;
    try { content = await readRaw(req, fileLimit()); } catch (e) { return json(res, 413, { error: 'Files can be up to ' + fileLimitText() + '.' }); }
    if (!content.length) return json(res, 400, { error: 'That file is empty.' });
    const mime = clip(String(req.headers['content-type'] || 'application/octet-stream').split(';')[0], 100);
    const f = await storeFile({ client_id: s.client.id, name: name, mime: mime, category: 'other', content: content, shared: true, uploaded_by: 'client' });
    await clientAudit(req, s, 'file', 'Uploaded file', name);
    return json(res, 200, { file: { id: f.id, name: f.name, mime: f.mime, size: f.size, category: f.category, created_at: f.created_at, uploaded_by: 'client' } });
  }

  // approvals: approve, request changes (with a note), or mark an access request done
  mm = p.match(/^\/approvals\/(app_[A-Za-z0-9_-]+)$/);
  if (mm && m === 'POST') {
    const a = await desk.get('approval', mm[1]);
    if (!a || a.client_id !== s.client.id) return json(res, 404, { error: 'Not found.' });
    if ((a.status || 'pending') !== 'pending') return json(res, 409, { error: 'This item has already been decided.' });
    const body = await readJson(req, 8192) || {};
    const comment = clip(body.comment, 3000);
    const update = { decided: deskLib.localDate(), decided_by: clientName(s.client) + ' (portal)' };
    let event;
    if (body.action === 'approve') { update.status = 'approved'; event = a.kind === 'decision' ? 'Approved decision' : a.kind === 'access' ? 'Completed access request' : 'Approved'; }
    else if (body.action === 'changes') {
      if (!comment) return json(res, 400, { error: 'Tell us what should change.' });
      update.status = 'changes'; event = 'Requested changes';
    } else return json(res, 400, { error: 'Invalid request.' });
    if (comment) update.client_comment = comment;
    const item = await desk.update('approval', a.id, update);
    await clientAudit(req, s, 'approval', event, a.title + (comment ? ' · “' + comment.slice(0, 200) + '”' : ''));
    return json(res, 200, { approval: { id: item.id, status: item.status, decided: item.decided, comment: item.client_comment || '' } });
  }

  // billing
  if (p === '/billing' && m === 'GET') return portalBilling(req, res, s);
  if (!SECRET) return json(res, 503, { error: 'Payments are not configured yet.' });
  try {
    mm = p.match(/^\/invoices\/(in_[A-Za-z0-9]+)\/(pay|paid|pdf)$/);
    if (mm && mm[2] === 'pay' && m === 'POST') return await portalPay(req, res, s, mm[1]);
    if (mm && mm[2] === 'paid' && m === 'POST') return await portalPaid(req, res, s, mm[1]);
    if (mm && mm[2] === 'pdf' && m === 'GET') return await portalInvoicePdf(req, res, s, mm[1]);
    if (p === '/payment-method/setup' && m === 'POST') return await portalSetupMethod(req, res, s);
    if (p === '/payment-method/confirm' && m === 'POST') return await portalConfirmMethod(req, res, s);
  } catch (e) {
    console.error('portal_billing_action_failed', p, e.status, e.message);
    return json(res, 502, { error: 'Something went wrong with that payment request. Please try again.' });
  }
  return json(res, 404, { error: 'Not found' });
}

// ----- Desk side: portal access per client, invites, sign-out, file sharing and the audit log -----
async function portalAdmin(req, res, p, m, url) {
  let mm = p.match(/^\/portal\/(cli_[A-Za-z0-9_-]+)(?:\/(access|invite|signout))?$/);
  if (mm) {
    await portalInit();
    const c = await desk.get('client', mm[1]);
    if (!c) return json(res, 404, { error: 'Client not found.' });
    const status = async function () {
      return { enabled: Boolean(c.portal_access), open: portalOpen(c), email: c.email || '', host: CLIENT_HOST, email_ready: Boolean(NOTIFY_URL), storage: r2.enabled ? 'r2' : 'database',
        last_sign_in: await portal.lastSignIn(c.id), sessions: await portal.sessionInfo(c.id) };
    };
    if (!mm[2] && m === 'GET') return json(res, 200, await status());
    if (mm[2] === 'access' && m === 'POST') {
      const body = await readJson(req, 1024) || {};
      const on = body.enabled === true;
      if (on) {
        if (!EMAIL_RE.test(portalEmailOf(c))) return json(res, 400, { error: 'Add the client’s email first. It’s their portal login.' });
        const clash = (await desk.allOf('client')).find(function (x) { return x.id !== c.id && x.portal_access && portalEmailOf(x) === portalEmailOf(c); });
        if (clash) return json(res, 409, { error: 'Another client (' + clientName(clash) + ') already uses this email for portal access. Each client needs its own login email.' });
      }
      await desk.update('client', c.id, { portal_access: on });
      c.portal_access = on;
      if (!on) await portal.endAllSessions(c.id);
      await adminAudit(req, c.id, 'account', on ? 'Portal access turned on' : 'Portal access turned off', on ? 'Login email ' + portalEmailOf(c) : 'All sessions signed out');
      return json(res, 200, await status());
    }
    if (mm[2] === 'invite' && m === 'POST') {
      if (!portalOpen(c)) return json(res, 400, { error: 'Turn on portal access first.' });
      try { await sendPortalLink(req, c, true); } catch (e) { return json(res, e.status || 502, { error: e.status ? e.message : 'Couldn’t send the email. Please try again.' }); }
      await adminAudit(req, c.id, 'account', 'Portal invite sent', 'Sign-in link emailed to ' + portalEmailOf(c));
      return json(res, 200, await status());
    }
    if (mm[2] === 'signout' && m === 'POST') {
      const n = await portal.endAllSessions(c.id);
      await adminAudit(req, c.id, 'security', 'Signed out everywhere', n + ' session' + (n === 1 ? '' : 's') + ' ended by Aethera');
      return json(res, 200, await status());
    }
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (p === '/audit' && m === 'GET') {
    await portalInit();
    const sp = url.searchParams;
    const cat = portalLib.CATEGORIES.indexOf(sp.get('category')) >= 0 ? sp.get('category') : '';
    const csv = sp.get('format') === 'csv';
    const rows = await portal.audit({ client_id: /^cli_/.test(sp.get('client_id') || '') ? sp.get('client_id') : '', category: cat, flagged: sp.get('flagged') === '1',
      q: clip(sp.get('q'), 100), limit: csv ? 5000 : Number(sp.get('limit')) || 300 });
    const clients = await desk.allOf('client');
    const names = {}; clients.forEach(function (c) { names[c.id] = clientName(c); });
    const out = rows.map(function (e) {
      return { id: e.id, at: e.at, client_id: e.client_id, client: names[e.client_id] || (e.client_id ? 'Deleted client' : ''), category: e.category, event: e.event, detail: e.detail || '',
        actor: e.actor_type === 'client' ? (names[e.client_id] || e.actor || 'Client') : (e.actor || (e.actor_type === 'admin' ? 'Aethera team' : 'System')), actor_type: e.actor_type,
        ip: e.ip || '', device: e.device || '', flagged: Boolean(e.flagged) };
    });
    if (csv) {
      const cell = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      const lines = [['When (UTC)', 'Client', 'Category', 'Event', 'Details', 'Actor', 'IP', 'Device', 'Needs review'].map(cell).join(',')]
        .concat(out.map(function (e) { return [e.at, e.client, e.category, e.event, e.detail, e.actor, e.ip, e.device, e.flagged ? 'yes' : ''].map(cell).join(','); }));
      return send(res, 200, lines.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="aethera-portal-audit-' + deskLib.localDate() + '.csv"' });
    }
    return json(res, 200, { items: out, clients: clients.filter(function (c) { return c.portal_access; }).map(function (c) { return { id: c.id, name: clientName(c) }; }) });
  }
  return null;
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

// Payments that clear (cards right away, bank payments days later) go into the paying client's activity log.
async function auditInvoicePaid(event) {
  const o = (event.data && event.data.object) || {};
  const email = String(o.customer_email || '').trim().toLowerCase();
  if (!email) return;
  try {
    await portalInit();
    const c = (await desk.allOf('client')).find(function (x) { return portalEmailOf(x) === email; });
    if (c) await audit(null, { client_id: c.id, actor_type: 'system', actor: 'Stripe', category: 'billing', event: 'Payment received', detail: (o.number || o.id) + ' · ' + money(o.amount_paid, o.currency) });
  } catch (e) { console.error('audit_invoice_paid_failed', e.message); }
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

  if (event.type === 'invoice.finalized') {
    const o = (event.data && event.data.object) || {};
    const sd = o.parent && o.parent.subscription_details;
    if (sd && sd.metadata && sd.metadata.quote_id && o.collection_method === 'send_invoice' && NOTIFY_URL && o.amount_due > 0) {
      try { await sendInvoiceEmail(o, publicOrigin()); console.log('quote_monthly_invoice_emailed ' + o.id); }
      catch (e) { console.error('quote_monthly_invoice_email_failed', o.id, e.message); return json(res, 500, { error: 'Could not email invoice.' }); }
    }
  }
  const rec = summarizeEvent(event);
  if (event.type === 'invoice.paid') await auditInvoicePaid(event);
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
// Pages refer to their scripts and styles as /assets/name.ext?v=…; the server swaps in a fingerprint of the file's
// contents, so after a deploy browsers fetch any file that changed and keep reusing the ones that didn't.
const assetVersions = new Map();
function assetVersion(name) {
  if (!assetVersions.has(name)) {
    let v = '0';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, 'assets', name))).digest('hex').slice(0, 10); } catch (e) {}
    assetVersions.set(name, v);
  }
  return assetVersions.get(name);
}
function versionAssets(html) {
  return html.toString('utf8').replace(/(["'(])\/assets\/([A-Za-z0-9._-]+\.(?:js|css))\?v=[A-Za-z0-9._-]*/g, function (m, q, name) {
    return q + '/assets/' + name + '?v=' + assetVersion(name);
  });
}

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
      if (ext === '.html') data = versionAssets(data);
      const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Vary': 'Accept-Encoding' };
      // Compress text files (the home page is ~75 KB raw, ~15 KB gzipped).
      if (req.method !== 'HEAD' && /\.(html|css|js|json|svg|txt|xml)$/.test(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        headers['Content-Encoding'] = 'gzip';
        data = zlib.gzipSync(data);
      }
      send(res, 200, req.method === 'HEAD' ? '' : data, headers);
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
    // client.aetheradigital.com: the client portal at "/", its API and shared assets; everything else goes to the public site.
    if (site === 'client') {
      if (p.startsWith('/api/portal/')) return await portalApi(req, res, url);
      if (p === '/api/config') return config(req, res);
      if (p === '/' || p === '/index.html' || p === '/login') return serveStatic(req, res, new URL('/client/', 'http://localhost'));
      if (p === '/client' || p.startsWith('/client/')) return send(res, 301, '', { Location: '/' });
      if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (p.startsWith('/assets/')) return serveStatic(req, res, url);
      return send(res, 302, '', { Location: 'https://' + PUBLIC_DOMAIN + p + (url.search || '') });
    }
    // aetheradigital.com: no admin or portal API here.
    if (site === 'public') {
      if (p === '/admin' || p.startsWith('/admin/')) return send(res, 301, '', { Location: 'https://' + ADMIN_HOST + '/' });
      if (p === '/client' || p.startsWith('/client/')) return send(res, 301, '', { Location: 'https://' + CLIENT_HOST + '/' });
      if (p.startsWith('/api/admin/') || p.startsWith('/api/portal/')) return json(res, 404, { error: 'Not found' });
    }

    if (p === '/api/config' && req.method === 'GET') return config(req, res);
    if (p === '/api/invoice' && req.method === 'GET') return await getInvoice(req, res, url);
    if (p === '/api/invoice-lookup' && req.method === 'POST') return await lookupInvoice(req, res);
    if (p === '/api/subscribe' && req.method === 'POST') return await subscribe(req, res);
    if (p === '/api/quote' && req.method === 'GET') return await quotePublicGet(req, res, url);
    if (p === '/api/quote/pdf' && req.method === 'GET') return await quotePdfGet(req, res, url);
    if (p === '/api/quote/accept' && req.method === 'POST') return await quoteAccept(req, res);
    if (p === '/api/quote/decline' && req.method === 'POST') return await quoteDecline(req, res);
    if (p === '/api/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, res);
    if (p.startsWith('/api/collector/')) return await collectorApi(req, res, url);
    if (p.startsWith('/api/portal/')) return await portalApi(req, res, url);
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
  scheduleReportDrafts();
  scheduleQuoteBilling();
  if (process.env.SIGNED_PDF_BACKFILL !== 'off') setTimeout(function () { deskInit().then(backfillSignedPdfs).catch(function (e) { console.error('quote_signed_pdf_backfill_failed', e.message); }); }, 10000).unref();
  server.listen(PORT, function () {
    console.log('aethera site listening on ' + PORT + (SECRET ? '' : ' (Stripe not configured)') + (ADMIN_PASSWORD ? '' : ' (admin disabled: set ADMIN_PASSWORD)'));
  });
}
module.exports = { server, encodeForm, verifyStripeSignature, summarizeEvent, invoiceSig, parseItems };
