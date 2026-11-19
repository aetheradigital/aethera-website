'use strict';
/**
 * aetheradigital.com web server.
 * Serves the static site from ./public and a small Stripe API for embedded checkout.
 * No dependencies: Node 20+ (built-in fetch).
 *
 * Environment variables (set in Render, never in code):
 *   STRIPE_SECRET_KEY       sk_test_... / sk_live_... (or a restricted key with Checkout Sessions write)
 *   STRIPE_PUBLISHABLE_KEY  pk_test_... / pk_live_...
 *   SITE_URL                public origin used for return URLs, e.g. https://aetheradigital.com
 *   PRICE_PARTNERSHIP       Stripe Price ID for the $2,250/mo Startup Partnership
 *   PRODUCT_INVOICE         Stripe Product ID used for invoice payments
 *   STRIPE_WEBHOOK_SECRET   whsec_... signing secret of the webhook endpoint (/api/stripe/webhook)
 *   PAYMENTS_NOTIFY_URL     optional: Apps Script web app URL that logs payment events to a sheet and emails
 *   PAYMENTS_NOTIFY_TOKEN   optional: shared token checked by the Apps Script (PAYMENTS_TOKEN script property)
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
const PRICE_PARTNERSHIP = process.env.PRICE_PARTNERSHIP || 'price_1UdHOkA3W4CrH9UBqqAxdgXg';
const PRODUCT_INVOICE = process.env.PRODUCT_INVOICE || 'prod_VeaZ2Jq6eLp6HW';
const PORTAL_URL = process.env.PORTAL_URL || 'https://billing.stripe.com/p/login/test_5kQ28qfmPgiGgFc9Mg7wA00';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const NOTIFY_URL = process.env.PAYMENTS_NOTIFY_URL || '';
const NOTIFY_TOKEN = process.env.PAYMENTS_NOTIFY_TOKEN || '';
const WEBHOOK_TOLERANCE_SEC = 300; // reject signatures older than 5 minutes (replay protection)

const MIN_CENTS = 5000;        // $50
const MAX_CENTS = 5000000;     // $50,000

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
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  if (method === 'GET' && params) url += '?' + encodeForm(params);
  else if (params) opts.body = encodeForm(params);
  const r = await fetch(url, opts);
  const data = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || ('Stripe error ' + r.status));
    err.status = r.status;
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

function originOf(req) {
  if (SITE_URL) return SITE_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return proto + '://' + req.headers.host;
}

// Allow API calls only from our own pages.
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin GETs may omit Origin
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

// Tiny in-memory rate limiter: N requests per minute per IP.
const hits = new Map();
function limited(req, max) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); const windowStart = now - 60000;
  const list = (hits.get(ip) || []).filter(function (t) { return t > windowStart; });
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

// ---------- API ----------
async function createCheckout(req, res) {
  if (!SECRET || !PUBLISHABLE) return json(res, 503, { error: 'Payments are not configured yet.' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'Forbidden' });
  if (limited(req, 20)) return json(res, 429, { error: 'Too many requests. Please wait a minute.' });

  let body;
  try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch (e) { return json(res, 400, { error: 'Invalid request.' }); }

  const returnUrl = originOf(req) + '/pay/complete/?session_id={CHECKOUT_SESSION_ID}';
  const common = {
    ui_mode: 'embedded_page',
    return_url: returnUrl,
    // Payment methods come from the Dashboard (enable ACH Direct Debit there). Consumer pay-later options don't fit B2B retainers.
    excluded_payment_method_types: ['klarna', 'affirm', 'afterpay_clearpay', 'zip', 'cashapp', 'amazon_pay'],
    billing_address_collection: 'required',
    integration_identifier: 'aethera_pay_page'
  };
  let params;

  if (body.plan === 'partnership') {
    params = Object.assign({}, common, {
      mode: 'subscription',
      line_items: [{ price: PRICE_PARTNERSHIP, quantity: 1 }],
      name_collection: { business: { enabled: true, optional: false } },
      tax_id_collection: { enabled: true },
      subscription_data: { description: 'Aethera Digital Startup Partnership (month-to-month)', metadata: { plan: 'startup_partnership' } },
      custom_text: { submit: { message: 'Billed monthly until you cancel. Paying by US bank account (ACH) is preferred. Manage or cancel anytime from the billing portal.' } },
      metadata: { source: 'aethera_pay_page', plan: 'startup_partnership' }
    });
  } else if (body.plan === 'invoice') {
    const cents = Math.round(Number(body.amount) * 100);
    const inv = String(body.invoice_number || '').trim();
    if (!Number.isFinite(cents) || cents < MIN_CENTS || cents > MAX_CENTS) {
      return json(res, 400, { error: 'Enter an amount between $50 and $50,000.' });
    }
    if (!/^[A-Za-z0-9#._\- ]{1,40}$/.test(inv)) {
      return json(res, 400, { error: 'Enter your invoice number (letters, numbers and dashes).' });
    }
    params = Object.assign({}, common, {
      mode: 'payment',
      submit_type: 'pay',
      customer_creation: 'always',
      line_items: [{
        quantity: 1,
        price_data: { currency: 'usd', product: PRODUCT_INVOICE, unit_amount: cents, tax_behavior: 'exclusive' }
      }],
      name_collection: { business: { enabled: true, optional: true } },
      payment_intent_data: { description: 'Aethera Digital invoice ' + inv, metadata: { invoice_number: inv } },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: 'Payment for invoice ' + inv + '. Thank you for working with Aethera Digital.',
          footer: 'Aethera Digital · aetheradigital.com · hello@aetheradigital.com',
          metadata: { invoice_number: inv, source: 'aethera_pay_page' }
        }
      },
      metadata: { source: 'aethera_pay_page', invoice_number: inv }
    });
  } else {
    return json(res, 400, { error: 'Unknown payment option.' });
  }

  try {
    const session = await stripe('POST', '/v1/checkout/sessions', params);
    return json(res, 200, { clientSecret: session.client_secret });
  } catch (e) {
    console.error('checkout_session_failed', e.status, e.message);
    return json(res, 502, { error: 'We could not start checkout. Please try again or email hello@aetheradigital.com.' });
  }
}

async function sessionStatus(req, res, url) {
  if (!SECRET) return json(res, 503, { error: 'Payments are not configured yet.' });
  if (limited(req, 60)) return json(res, 429, { error: 'Too many requests.' });
  const id = url.searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json(res, 400, { error: 'Invalid session.' });
  try {
    const s = await stripe('GET', '/v1/checkout/sessions/' + encodeURIComponent(id));
    return json(res, 200, {
      status: s.status,
      payment_status: s.payment_status,
      mode: s.mode,
      amount_total: s.amount_total,
      currency: s.currency,
      customer_email: (s.customer_details && s.customer_details.email) || null,
      invoice_number: (s.metadata && s.metadata.invoice_number) || null
    });
  } catch (e) {
    console.error('session_status_failed', e.status, e.message);
    return json(res, 502, { error: 'Could not load payment status.' });
  }
}

function config(req, res) {
  json(res, 200, {
    enabled: Boolean(SECRET && PUBLISHABLE),
    publishableKey: PUBLISHABLE || null,
    testMode: /^pk_test_/.test(PUBLISHABLE),
    portalUrl: PORTAL_URL
  });
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

function money(cents, currency) {
  if (typeof cents !== 'number') return '';
  const s = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (String(currency || 'usd').toLowerCase() === 'usd' ? '$' + s : s + ' ' + String(currency).toUpperCase());
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
      return Object.assign(base, {
        label: paid ? (renewal ? 'Monthly renewal paid' : 'Invoice paid') : (renewal ? 'Monthly renewal failed' : 'Invoice payment failed'),
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
    if (url.pathname === '/api/config' && req.method === 'GET') return config(req, res);
    if (url.pathname === '/api/checkout' && req.method === 'POST') return await createCheckout(req, res);
    if (url.pathname === '/api/session-status' && req.method === 'GET') return await sessionStatus(req, res, url);
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') return await stripeWebhook(req, res);
    if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('unhandled', e);
    if (!res.headersSent) json(res, e.status || 500, { error: 'Something went wrong.' });
  }
});

if (require.main === module) {
  server.listen(PORT, function () { console.log('aethera site listening on ' + PORT + (SECRET ? '' : ' (Stripe not configured)')); });
}
module.exports = { server, encodeForm, verifyStripeSignature, summarizeEvent };
