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
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const STRIPE_API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const SECRET = process.env.STRIPE_SECRET_KEY || '';
const PUBLISHABLE = process.env.STRIPE_PUBLISHABLE_KEY || '';
const PRICE_PARTNERSHIP = process.env.PRICE_PARTNERSHIP || 'price_1UdHOkA3W4CrH9UBqqAxdgXg';
const PRODUCT_INVOICE = process.env.PRODUCT_INVOICE || 'prod_VeaZ2Jq6eLp6HW';
const PORTAL_URL = process.env.PORTAL_URL || 'https://billing.stripe.com/p/login/test_5kQ28qfmPgiGgFc9Mg7wA00';
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');

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

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
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
module.exports = { server, encodeForm };
