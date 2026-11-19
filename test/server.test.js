'use strict';
// Runs the site server against a fake Stripe API and checks the payment, admin and webhook endpoints.
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const WHSEC = 'whsec_test_secret';
const ADMIN_PW = 'correct horse battery';
const calls = [];
const notes = [];
let failNotify = false;
let invoiceStatus = 'open';

const INV = () => ({
  id: 'in_test1234567890', object: 'invoice', number: 'AETH-0007', status: invoiceStatus, currency: 'usd', livemode: false,
  customer: 'cus_secret_should_not_leak', customer_email: 'pat@baconroofing.com', customer_name: 'Bacon Roofing',
  subtotal: 125050, total: 125050, total_excluding_tax: 125050, amount_paid: 0, amount_remaining: 125050,
  created: 1795000000, effective_at: 1795000000, due_date: 1796200000, description: 'November website work',
  invoice_pdf: 'https://pay.stripe.com/invoice/x/pdf', metadata: { internal: 'should_not_leak' },
  lines: { data: [{ description: 'Website refinements', quantity: 1, amount: 100000 }, { description: 'SEO audit', quantity: 2, amount: 25050 }], has_more: false },
  confirmation_secret: { client_secret: 'pi_123_secret_abc', type: 'payment_intent' }
});

const fakeStripe = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/notify') {
      if (failNotify) { res.statusCode = 500; return res.end('{"ok":false}'); }
      notes.push(new URLSearchParams(body));
      return res.end('{"ok":true}');
    }
    const u = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: u.pathname, query: u.searchParams, auth: req.headers.authorization, body: new URLSearchParams(body) });
    const send = (o) => res.end(JSON.stringify(o));
    const p = u.pathname; const m = req.method;
    if (m === 'GET' && p === '/v1/invoices/search') {
      return send({ data: u.searchParams.get('query') === 'number:"AETH-0007"' ? [INV()] : [] });
    }
    if (m === 'GET' && p === '/v1/invoices') return send({ data: [INV()] });
    if (m === 'GET' && p.startsWith('/v1/invoices/in_')) return send(INV());
    if (m === 'GET' && p === '/v1/customers') return send({ data: u.searchParams.get('email') === 'old@client.co' ? [{ id: 'cus_old', name: 'Test customer', metadata: {} }] : [] });
    if (m === 'POST' && p === '/v1/customers/cus_old') return send({ id: 'cus_old', name: new URLSearchParams(body).get('name') });
    if (m === 'POST' && p === '/v1/customers') return send({ id: 'cus_new1' });
    if (m === 'POST' && p === '/v1/subscriptions') return send({ id: 'sub_1', latest_invoice: { confirmation_secret: { client_secret: 'pi_sub_secret_xyz' } } });
    if (m === 'POST' && p === '/v1/invoices') return send(Object.assign(INV(), { status: 'draft', number: null }));
    if (m === 'POST' && p === '/v1/invoiceitems') return send({ id: 'ii_1' });
    if (m === 'POST' && /\/finalize$/.test(p)) return send(INV());
    if (m === 'POST' && /\/void$/.test(p)) return send(Object.assign(INV(), { status: 'void' }));
    if (m === 'POST' && /\/send$/.test(p)) return send(INV());
    if (m === 'POST' && p.startsWith('/v1/invoices/in_')) return send(INV());
    res.statusCode = 404; res.end('{"error":{"message":"nope"}}');
  });
});

function request(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  await new Promise((r) => fakeStripe.listen(0, r));
  const stripePort = fakeStripe.address().port;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port), STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
      STRIPE_API_BASE: 'http://127.0.0.1:' + stripePort, SITE_URL: 'https://aetheradigital.com',
      STRIPE_WEBHOOK_SECRET: WHSEC, PAYMENTS_NOTIFY_URL: 'http://127.0.0.1:' + stripePort + '/notify', PAYMENTS_NOTIFY_TOKEN: 'tok123',
      ADMIN_PASSWORD: ADMIN_PW
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((r) => child.stdout.once('data', r));
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓ ' + name); };
  const sigFor = (id) => crypto.createHmac('sha256', crypto.createHmac('sha256', 'sk_test_fake').update('aethera-invoice-links').digest()).update('invoice:' + id).digest('base64url').slice(0, 32);
  try {
    // ---------- config ----------
    let r = await request(port, 'GET', '/api/config');
    let j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.enabled, true); assert.strictEqual(j.testMode, true); assert.strictEqual(j.publishableKey, 'pk_test_fake');
    assert.deepStrictEqual(j.paymentMethodTypes, ['card', 'us_bank_account']);
    assert.ok(!r.body.includes('sk_test'));
    ok('config exposes publishable key and payment methods only');

    // ---------- public invoice ----------
    const id = 'in_test1234567890';
    r = await request(port, 'GET', '/api/invoice?i=' + id + '&k=' + sigFor(id));
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.number, 'AETH-0007'); assert.strictEqual(j.amount_remaining, 125050); assert.strictEqual(j.lines.length, 2);
    assert.strictEqual(j.clientSecret, 'pi_123_secret_abc'); assert.strictEqual(j.customer_name, 'Bacon Roofing');
    assert.ok(!r.body.includes('should_not_leak') && !r.body.includes('cus_secret'));
    let c = calls.pop(); assert.strictEqual(c.query.get('expand[0]'), 'confirmation_secret');
    ok('invoice view: signed link returns safe fields and the payment secret');

    let before = calls.length;
    r = await request(port, 'GET', '/api/invoice?i=' + id + '&k=' + sigFor(id).replace(/^./, (x) => (x === 'A' ? 'B' : 'A')));
    assert.strictEqual(r.status, 404);
    r = await request(port, 'GET', '/api/invoice?i=in_other1234567890&k=' + sigFor(id));
    assert.strictEqual(r.status, 404);
    r = await request(port, 'GET', '/api/invoice?i=../v1/customers&k=x');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(calls.length, before, 'bad links must not reach Stripe');
    ok('invoice view: tampered, swapped or malformed links are rejected without calling Stripe');

    invoiceStatus = 'paid';
    r = await request(port, 'GET', '/api/invoice?i=' + id + '&k=' + sigFor(id));
    j = JSON.parse(r.body); assert.strictEqual(j.status, 'paid'); assert.strictEqual(j.clientSecret, null);
    invoiceStatus = 'draft';
    r = await request(port, 'GET', '/api/invoice?i=' + id + '&k=' + sigFor(id));
    assert.strictEqual(r.status, 404);
    invoiceStatus = 'open';
    ok('invoice view: paid invoices have no payment secret; drafts are hidden');

    // ---------- lookup ----------
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'aeth-0007', email: 'PAT@baconroofing.com' });
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.url, '/pay/invoice/?i=' + id + '&k=' + sigFor(id));
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'AETH-0007', email: 'someone@else.com' });
    assert.strictEqual(r.status, 404);
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'AETH-9999', email: 'pat@baconroofing.com' });
    assert.strictEqual(r.status, 404);
    before = calls.length;
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'x"; DROP', email: 'pat@baconroofing.com' });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'AETH-0007', email: 'nope' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, before);
    r = await request(port, 'POST', '/api/invoice-lookup', { number: 'AETH-0007', email: 'pat@baconroofing.com' }, { Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);
    ok('lookup: number + matching email returns a signed link; wrong email, bad input and cross-origin refused');

    // ---------- partnership subscribe ----------
    r = await request(port, 'POST', '/api/subscribe', { email: 'jo@acme.co', name: 'Jo Doe', company: 'Acme' });
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.clientSecret, 'pi_sub_secret_xyz');
    c = calls.pop();
    assert.strictEqual(c.path, '/v1/subscriptions');
    assert.strictEqual(c.body.get('customer'), 'cus_new1');
    assert.strictEqual(c.body.get('items[0][price]'), 'price_1UdHOkA3W4CrH9UBqqAxdgXg');
    assert.strictEqual(c.body.get('payment_behavior'), 'default_incomplete');
    assert.strictEqual(c.body.get('payment_settings[payment_method_types][1]'), 'us_bank_account');
    assert.strictEqual(c.body.get('payment_settings[save_default_payment_method]'), 'on_subscription');
    assert.strictEqual(c.body.get('expand[0]'), 'latest_invoice.confirmation_secret');
    assert.strictEqual(c.body.get('automatic_tax[enabled]'), null);
    c = calls.pop(); assert.strictEqual(c.path, '/v1/customers'); assert.strictEqual(c.body.get('name'), 'Acme'); assert.strictEqual(c.body.get('email'), 'jo@acme.co');
    before = calls.length;
    r = await request(port, 'POST', '/api/subscribe', { email: 'bad', name: 'Jo', company: 'Acme' });
    assert.strictEqual(r.status, 400); assert.strictEqual(JSON.parse(r.body).field, 'email');
    r = await request(port, 'POST', '/api/subscribe', { email: 'jo@acme.co', name: 'Jo', company: '' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, before);
    ok('subscribe: creates customer and incomplete subscription, returns payment secret; validates input');

    // ---------- admin ----------
    r = await request(port, 'GET', '/api/admin/me');
    assert.deepStrictEqual(JSON.parse(r.body), { admin: false, configured: true, payments: true });
    r = await request(port, 'GET', '/api/admin/invoices');
    assert.strictEqual(r.status, 401);
    r = await request(port, 'POST', '/api/admin/invoices', { email: 'a@b.co' });
    assert.strictEqual(r.status, 401);
    r = await request(port, 'POST', '/api/admin/login', { password: 'wrong' });
    assert.strictEqual(r.status, 401); assert.ok(!r.headers['set-cookie']);
    r = await request(port, 'GET', '/api/admin/invoices', null, { Cookie: 'aethera_admin=9999999999.forged' });
    assert.strictEqual(r.status, 401);
    ok('admin: everything is locked without a valid session; wrong password and forged cookie refused');

    r = await request(port, 'POST', '/api/admin/login', { password: ADMIN_PW });
    assert.strictEqual(r.status, 200);
    const setCookie = r.headers['set-cookie'][0];
    assert.ok(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Secure/.test(setCookie));
    const cookie = setCookie.split(';')[0];
    r = await request(port, 'GET', '/api/admin/me', null, { Cookie: cookie });
    assert.strictEqual(JSON.parse(r.body).admin, true);
    r = await request(port, 'GET', '/api/admin/invoices', null, { Cookie: cookie });
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.invoices[0].number, 'AETH-0007'); assert.strictEqual(j.testMode, true);
    assert.strictEqual(j.invoices[0].pay_url, 'https://aetheradigital.com/pay/invoice/?i=' + id + '&k=' + sigFor(id));
    assert.strictEqual(j.invoices[0].stripe_url, 'https://dashboard.stripe.com/test/invoices/' + id);
    ok('admin: login sets a secure HttpOnly cookie; invoice list includes signed pay links');

    calls.length = 0; notes.length = 0;
    r = await request(port, 'POST', '/api/admin/invoices', {
      email: 'Pat@BaconRoofing.com', name: 'Pat', company: 'Bacon Roofing', memo: 'November website work', days_until_due: 14,
      items: [{ description: 'Website refinements', quantity: 1, unit_amount: '1,000.00' }, { description: 'SEO audit', quantity: 2, unit_amount: '125.25' }]
    }, { Cookie: cookie });
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(j.emailed_via, 'aethera'); assert.strictEqual(j.invoice.number, 'AETH-0007');
    const seq = calls.map((x) => x.method + ' ' + x.path);
    assert.deepStrictEqual(seq, ['GET /v1/customers', 'POST /v1/customers', 'POST /v1/invoices', 'POST /v1/invoiceitems', 'POST /v1/invoiceitems', 'POST /v1/invoices/' + id + '/finalize', 'POST /v1/invoices/' + id]);
    const invReq = calls[2].body;
    assert.strictEqual(invReq.get('collection_method'), 'send_invoice'); assert.strictEqual(invReq.get('days_until_due'), '14');
    assert.strictEqual(invReq.get('auto_advance'), 'false'); assert.strictEqual(invReq.get('pending_invoice_items_behavior'), 'exclude');
    assert.strictEqual(invReq.get('payment_settings[payment_method_types][0]'), 'card');
    assert.strictEqual(invReq.get('metadata[source]'), 'aethera_admin'); assert.strictEqual(invReq.get('description'), 'November website work');
    assert.strictEqual(calls[3].body.get('unit_amount_decimal'), '100000'); assert.strictEqual(calls[4].body.get('unit_amount_decimal'), '12525');
    assert.strictEqual(calls[4].body.get('quantity'), '2'); assert.strictEqual(calls[3].body.get('invoice'), id);
    assert.strictEqual(calls[1].body.get('email'), 'pat@baconroofing.com');
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].get('kind'), 'invoice_email'); assert.strictEqual(notes[0].get('to'), 'pat@baconroofing.com');
    assert.strictEqual(notes[0].get('url'), 'https://aetheradigital.com/pay/invoice/?i=' + id + '&k=' + sigFor(id));
    assert.strictEqual(notes[0].get('amount'), '$1,250.50'); assert.strictEqual(notes[0].get('token'), 'tok123');
    assert.strictEqual(calls[6].body.get('metadata[emailed_via]'), 'aethera');
    ok('admin create: customer, invoice, line items in cents, finalize, branded email with signed link');

    calls.length = 0;
    r = await request(port, 'POST', '/api/admin/invoices', { email: 'old@client.co', name: 'Pat Lee', company: 'Bacon Roofing', days_until_due: 14, send: false, items: [{ description: 'Thing', quantity: 1, unit_amount: '50' }] }, { Cookie: cookie });
    assert.strictEqual(r.status, 200);
    const upd = calls.find((x) => x.path === '/v1/customers/cus_old');
    assert.ok(upd, 'existing customer is updated'); assert.strictEqual(upd.body.get('name'), 'Bacon Roofing'); assert.strictEqual(upd.body.get('metadata[contact_name]'), 'Pat Lee');
    assert.strictEqual(calls.find((x) => x.path === '/v1/invoices' && x.method === 'POST').body.get('customer'), 'cus_old');
    assert.strictEqual(calls.find((x) => x.path === '/v1/invoiceitems').body.get('unit_amount_decimal'), '5000');
    ok('admin create: reusing an existing customer updates its name and business; "50" means $50.00');

    calls.length = 0;
    r = await request(port, 'POST', '/api/admin/invoices', { email: 'a@b.co', name: 'A', days_until_due: 14, send: false, items: [{ description: 'Thing', quantity: 1, unit_amount: '10' }] }, { Cookie: cookie });
    j = JSON.parse(r.body); assert.strictEqual(r.status, 200); assert.strictEqual(j.emailed_via, null);
    assert.ok(!calls.some((x) => /\/send$/.test(x.path))); assert.strictEqual(notes.length, 1);
    ok('admin create: "don’t email" creates and finalizes without sending');

    before = calls.length;
    for (const bad of [
      { email: 'nope', name: 'A', days_until_due: 14, items: [{ description: 'X', quantity: 1, unit_amount: '10' }] },
      { email: 'a@b.co', name: 'A', days_until_due: 14, items: [] },
      { email: 'a@b.co', name: 'A', days_until_due: 14, items: [{ description: '', quantity: 1, unit_amount: '10' }] },
      { email: 'a@b.co', name: 'A', days_until_due: 14, items: [{ description: 'X', quantity: 1.5, unit_amount: '10' }] },
      { email: 'a@b.co', name: 'A', days_until_due: 14, items: [{ description: 'X', quantity: 1, unit_amount: '-5' }] },
      { email: 'a@b.co', name: 'A', days_until_due: 0, items: [{ description: 'X', quantity: 1, unit_amount: '10' }] },
      { email: 'a@b.co', name: '', company: '', days_until_due: 14, items: [{ description: 'X', quantity: 1, unit_amount: '10' }] }
    ]) {
      r = await request(port, 'POST', '/api/admin/invoices', bad, { Cookie: cookie });
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
    assert.strictEqual(calls.length, before);
    r = await request(port, 'POST', '/api/admin/invoices', { email: 'a@b.co', name: 'A', days_until_due: 14, items: [{ description: 'X', quantity: 1, unit_amount: '10' }] }, { Cookie: cookie, Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);
    ok('admin create: rejects bad email, lines, quantities, prices, due dates and cross-origin posts');

    calls.length = 0;
    r = await request(port, 'POST', '/api/admin/invoices/' + id + '/void', null, { Cookie: cookie });
    assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).invoice.status, 'void');
    assert.ok(calls.some((x) => x.path === '/v1/invoices/' + id + '/void'));
    r = await request(port, 'POST', '/api/admin/invoices/' + id + '/send', null, { Cookie: cookie });
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 2);
    r = await request(port, 'POST', '/api/admin/invoices/' + id + '/mark-paid', null, { Cookie: cookie });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.filter((x) => x.path === '/v1/invoices/' + id + '/pay')[0].body.get('paid_out_of_band'), 'true');
    r = await request(port, 'POST', '/api/admin/invoices/bogus/void', null, { Cookie: cookie });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/admin/logout', null, { Cookie: cookie });
    assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0]));
    ok('admin actions: void, resend, mark paid outside Stripe; logout clears the cookie');

    // ---------- webhook ----------
    const sign = (payload, t, secret) => {
      t = t || Math.floor(Date.now() / 1000);
      return 't=' + t + ',v1=' + crypto.createHmac('sha256', secret || WHSEC).update(t + '.' + payload).digest('hex');
    };
    const hook = (evt, sig) => {
      const payload = JSON.stringify(evt);
      return request(port, 'POST', '/api/stripe/webhook', payload, { 'Stripe-Signature': sig === undefined ? sign(payload) : sig(payload) });
    };
    notes.length = 0;
    const paidInvoice = {
      id: 'evt_1', type: 'invoice.paid', livemode: false,
      data: { object: { id: id, billing_reason: 'manual', amount_paid: 125050, currency: 'usd', number: 'AETH-0007', customer: 'cus_1', customer_name: 'Bacon Roofing', customer_email: 'pat@baconroofing.com', hosted_invoice_url: 'https://invoice.stripe.com/x', metadata: { source: 'aethera_admin' } } }
    };
    r = await hook(paidInvoice);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(notes.length, 1);
    let n = notes[0];
    assert.strictEqual(n.get('token'), 'tok123'); assert.strictEqual(n.get('kind'), 'payment');
    assert.strictEqual(n.get('label'), 'Invoice paid'); assert.strictEqual(n.get('amount'), '$1,250.50');
    assert.strictEqual(n.get('name'), 'Bacon Roofing'); assert.strictEqual(n.get('invoice_number'), 'AETH-0007');
    ok('webhook: signed invoice.paid for an admin invoice is recorded with amount, client and invoice #');

    r = await hook(paidInvoice);
    assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.body).duplicate); assert.strictEqual(notes.length, 1);
    ok('webhook: retried event is not recorded twice');

    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_2' }), () => 't=1,v1=deadbeef');
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_3' }), (p) => sign(p, null, 'whsec_wrong'));
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_4' }), (p) => sign(p, Math.floor(Date.now() / 1000) - 3600));
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_5' }), () => '');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(notes.length, 1);
    ok('webhook: rejects forged, wrong-secret, stale and unsigned events');

    r = await hook({ id: 'evt_6', type: 'invoice.paid', livemode: false, data: { object: { billing_reason: 'subscription_create', amount_paid: 225000, currency: 'usd', number: 'AETH-0008', customer_email: 'jo@acme.co', metadata: {}, parent: { subscription_details: { metadata: { plan: 'startup_partnership' } } } } } });
    n = notes.pop(); assert.strictEqual(n.get('label'), 'Partnership started (first payment)'); assert.strictEqual(n.get('plan'), 'startup_partnership');
    r = await hook({ id: 'evt_7', type: 'invoice.payment_failed', livemode: false, data: { object: { billing_reason: 'subscription_cycle', amount_due: 225000, currency: 'usd', number: 'L8ZL-0002', customer_email: 'a@b.co', metadata: {} } } });
    n = notes.pop(); assert.strictEqual(n.get('label'), 'Monthly renewal failed'); assert.strictEqual(n.get('status'), 'failed');
    r = await hook({ id: 'evt_8', type: 'checkout.session.completed', livemode: false, data: { object: { mode: 'payment', payment_status: 'unpaid', amount_total: 5000, currency: 'usd', customer_details: { email: 'a@b.co' }, metadata: {} } } });
    n = notes.pop(); assert.strictEqual(n.get('status'), 'processing');
    r = await hook({ id: 'evt_9', type: 'customer.subscription.updated', livemode: false, data: { object: { id: 'sub_1', status: 'past_due', metadata: {} }, previous_attributes: { status: 'active' } } });
    n = notes.pop(); assert.strictEqual(n.get('label'), 'Subscription status: past_due');
    r = await hook({ id: 'evt_10', type: 'customer.created', livemode: false, data: { object: {} } });
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 1);
    ok('webhook: partnership start, failed renewal, ACH processing, status change recorded; other events skipped');

    failNotify = true;
    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_11' }));
    assert.strictEqual(r.status, 500);
    failNotify = false;
    r = await hook(Object.assign({}, paidInvoice, { id: 'evt_11' }));
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 2);
    ok('webhook: returns 500 when the sheet is unreachable so Stripe retries, then records on retry');

    r = await request(port, 'GET', '/api/stripe/webhook');
    assert.strictEqual(r.status, 404);
    r = await request(port, 'POST', '/api/checkout', { plan: 'invoice' });
    assert.strictEqual(r.status, 404);
    ok('old custom-amount checkout endpoint is gone; webhook is POST only');

    // ---------- admin subdomain ----------
    const ADMIN = { Host: 'admin.aetheradigital.com' };
    r = await request(port, 'GET', '/', null, ADMIN);
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('Aethera Admin') && r.body.includes('login-form'));
    r = await request(port, 'GET', '/admin/', null, ADMIN);
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.location, '/');
    r = await request(port, 'GET', '/assets/pay.css', null, ADMIN);
    assert.strictEqual(r.status, 200);
    r = await request(port, 'GET', '/robots.txt', null, ADMIN);
    assert.ok(r.body.includes('Disallow: /'));
    r = await request(port, 'GET', '/pay/invoice/?i=x&k=y', null, ADMIN);
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, 'https://aetheradigital.com/pay/invoice/?i=x&k=y');
    r = await request(port, 'GET', '/api/invoice?i=x&k=y', null, ADMIN);
    assert.strictEqual(r.status, 302);
    r = await request(port, 'POST', '/api/admin/login', { password: ADMIN_PW }, Object.assign({ 'X-Forwarded-Proto': 'https' }, ADMIN));
    assert.strictEqual(r.status, 200);
    const adminCookie = r.headers['set-cookie'][0];
    assert.ok(!/Domain=/i.test(adminCookie), 'cookie stays on the admin host only');
    r = await request(port, 'GET', '/api/admin/invoices', null, Object.assign({ Cookie: adminCookie.split(';')[0] }, ADMIN));
    assert.strictEqual(r.status, 200);
    ok('admin.aetheradigital.com: dashboard at /, admin API works, other paths go to the public site');

    const PUB = { Host: 'aetheradigital.com' };
    r = await request(port, 'GET', '/admin/', null, PUB);
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.location, 'https://admin.aetheradigital.com/');
    r = await request(port, 'GET', '/admin', null, { Host: 'www.aetheradigital.com' });
    assert.strictEqual(r.status, 301);
    r = await request(port, 'POST', '/api/admin/login', { password: ADMIN_PW }, PUB);
    assert.strictEqual(r.status, 404); assert.ok(!r.headers['set-cookie']);
    r = await request(port, 'GET', '/pay/', null, PUB);
    assert.strictEqual(r.status, 200);
    r = await request(port, 'GET', '/admin/', null, { Host: 'aethera-site.onrender.com' });
    assert.strictEqual(r.status, 200);
    ok('aetheradigital.com: /admin redirects to the subdomain and the admin API is off; onrender.com keeps /admin');

    // ---------- static ----------
    r = await request(port, 'GET', '/');
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('<title>Aethera Digital'));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    r = await request(port, 'GET', '/pay');
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.location, '/pay/');
    r = await request(port, 'GET', '/pay/');
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('id="find-form"')); assert.ok(!r.body.includes('buy.stripe.com'));
    r = await request(port, 'GET', '/pay/invoice/?i=x&k=y');
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('payment-element'));
    r = await request(port, 'GET', '/pay/complete/?payment_intent_client_secret=x');
    assert.strictEqual(r.status, 200);
    r = await request(port, 'GET', '/admin/');
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('noindex'));
    r = await request(port, 'GET', '/assets/pay.js');
    assert.strictEqual(r.status, 200); assert.ok(/javascript/.test(r.headers['content-type']));
    r = await request(port, 'GET', '/../server.js');
    assert.notStrictEqual(r.status, 200);
    r = await request(port, 'GET', '/%2e%2e/server.js');
    assert.notStrictEqual(r.status, 200);
    r = await request(port, 'GET', '/nope');
    assert.strictEqual(r.status, 404); assert.ok(r.body.includes('drifted off'));
    ok('serves pay, invoice, complete and admin pages, assets, 404 and blocks path traversal');

    console.log('\n' + passed + ' passed');
  } catch (e) {
    console.error('\nFAILED:', e.message); process.exitCode = 1;
  } finally {
    child.kill(); fakeStripe.close();
  }
})();
