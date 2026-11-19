'use strict';
// Runs the site server against a fake Stripe API and checks requests, validation and static serving.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const crypto = require('crypto');

const WHSEC = 'whsec_test_secret';
const calls = [];
const notes = [];
let failNotify = false;
const fakeStripe = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/notify') {
      res.setHeader('Content-Type', 'application/json');
      if (failNotify) { res.statusCode = 500; return res.end('{"ok":false}'); }
      notes.push(new URLSearchParams(body));
      return res.end('{"ok":true}');
    }
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: new URLSearchParams(body) });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_test_abc123456789', client_secret: 'cs_test_abc123456789_secret_xyz' }));
    if (req.method === 'GET' && req.url.startsWith('/v1/checkout/sessions/cs_test_')) {
      return res.end(JSON.stringify({ status: 'complete', payment_status: 'paid', mode: 'payment', amount_total: 125000, currency: 'usd', customer_details: { email: 'client@example.com' }, metadata: { invoice_number: 'AD-1042' }, client_secret: 'should_not_leak' }));
    }
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
    env: Object.assign({}, process.env, { PORT: String(port), STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake', STRIPE_API_BASE: 'http://127.0.0.1:' + stripePort, SITE_URL: 'https://aetheradigital.com', STRIPE_WEBHOOK_SECRET: WHSEC, PAYMENTS_NOTIFY_URL: 'http://127.0.0.1:' + stripePort + '/notify', PAYMENTS_NOTIFY_TOKEN: 'tok123' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((r) => child.stdout.once('data', r));
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓ ' + name); };
  try {
    // config
    let r = await request(port, 'GET', '/api/config');
    let j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.enabled, true); assert.strictEqual(j.testMode, true); assert.strictEqual(j.publishableKey, 'pk_test_fake');
    assert.ok(!r.body.includes('sk_test'));
    ok('config exposes publishable key only');

    // partnership checkout
    r = await request(port, 'POST', '/api/checkout', { plan: 'partnership' });
    assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).clientSecret, 'cs_test_abc123456789_secret_xyz');
    let c = calls.pop();
    assert.strictEqual(c.auth, 'Bearer sk_test_fake');
    assert.strictEqual(c.body.get('ui_mode'), 'embedded_page');
    assert.strictEqual(c.body.get('mode'), 'subscription');
    assert.strictEqual(c.body.get('line_items[0][price]'), 'price_1UdHOkA3W4CrH9UBqqAxdgXg');
    assert.strictEqual(c.body.get('payment_method_types[0]'), null);
    assert.strictEqual(c.body.get('excluded_payment_method_types[0]'), 'klarna');
    assert.strictEqual(c.body.get('return_url'), 'https://aetheradigital.com/pay/complete/?session_id={CHECKOUT_SESSION_ID}');
    assert.strictEqual(c.body.get('name_collection[business][enabled]'), 'true');
    ok('partnership session: embedded_page, subscription, dashboard payment methods minus pay-later, return URL');

    // invoice checkout
    r = await request(port, 'POST', '/api/checkout', { plan: 'invoice', amount: 1250.5, invoice_number: 'AD-1042' });
    assert.strictEqual(r.status, 200);
    c = calls.pop();
    assert.strictEqual(c.body.get('mode'), 'payment');
    assert.strictEqual(c.body.get('line_items[0][price_data][unit_amount]'), '125050');
    assert.strictEqual(c.body.get('line_items[0][price_data][product]'), 'prod_VeaZ2Jq6eLp6HW');
    assert.strictEqual(c.body.get('invoice_creation[enabled]'), 'true');
    assert.strictEqual(c.body.get('metadata[invoice_number]'), 'AD-1042');
    ok('invoice session: amount in cents, invoice number recorded, receipt invoice on');

    // validation
    const before = calls.length;
    r = await request(port, 'POST', '/api/checkout', { plan: 'invoice', amount: 10, invoice_number: 'AD-1' });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/checkout', { plan: 'invoice', amount: 999999, invoice_number: 'AD-1' });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/checkout', { plan: 'invoice', amount: 500, invoice_number: '<script>' });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/checkout', { plan: 'free-money' });
    assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/checkout', '{bad json');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, before, 'invalid requests must not reach Stripe');
    ok('rejects bad amounts, invoice numbers, plans and JSON without calling Stripe');

    // cross-origin blocked
    r = await request(port, 'POST', '/api/checkout', { plan: 'partnership' }, { Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);
    ok('blocks cross-origin checkout requests');

    // session status
    r = await request(port, 'GET', '/api/session-status?session_id=cs_test_abc123456789');
    j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.status, 'complete'); assert.strictEqual(j.invoice_number, 'AD-1042'); assert.strictEqual(j.customer_email, 'client@example.com');
    assert.ok(!r.body.includes('should_not_leak'));
    r = await request(port, 'GET', '/api/session-status?session_id=../../v1/customers');
    assert.strictEqual(r.status, 400);
    ok('session status returns only safe fields and validates the id');

    // webhook
    const sign = (payload, t, secret) => {
      t = t || Math.floor(Date.now() / 1000);
      return 't=' + t + ',v1=' + crypto.createHmac('sha256', secret || WHSEC).update(t + '.' + payload).digest('hex');
    };
    const hook = (evt, sig) => {
      const payload = JSON.stringify(evt);
      return request(port, 'POST', '/api/stripe/webhook', payload, { 'Stripe-Signature': sig === undefined ? sign(payload) : sig(payload) });
    };
    const paidSession = {
      id: 'evt_1', type: 'checkout.session.completed', livemode: false,
      data: { object: { id: 'cs_test_1', mode: 'payment', payment_status: 'paid', amount_total: 125050, currency: 'usd', customer: 'cus_1', payment_intent: 'pi_1',
        customer_details: { email: 'client@example.com', name: 'Pat', business_name: 'Bacon Roofing' }, metadata: { invoice_number: 'AD-1042', source: 'aethera_pay_page' } } }
    };
    r = await hook(paidSession);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(notes.length, 1);
    let n = notes[0];
    assert.strictEqual(n.get('token'), 'tok123'); assert.strictEqual(n.get('kind'), 'payment');
    assert.strictEqual(n.get('status'), 'paid'); assert.strictEqual(n.get('amount'), '$1,250.50');
    assert.strictEqual(n.get('name'), 'Bacon Roofing'); assert.strictEqual(n.get('invoice_number'), 'AD-1042');
    assert.strictEqual(n.get('livemode'), 'false');
    ok('webhook: signed checkout.session.completed is recorded with amount, client and invoice #');

    r = await hook(paidSession);
    assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.body).duplicate); assert.strictEqual(notes.length, 1);
    ok('webhook: retried event is not recorded twice');

    r = await hook(Object.assign({}, paidSession, { id: 'evt_2' }), () => 't=1,v1=deadbeef');
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidSession, { id: 'evt_3' }), (p) => sign(p, null, 'whsec_wrong'));
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidSession, { id: 'evt_4' }), (p) => sign(p, Math.floor(Date.now() / 1000) - 3600));
    assert.strictEqual(r.status, 400);
    r = await hook(Object.assign({}, paidSession, { id: 'evt_5' }), () => '');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(notes.length, 1);
    ok('webhook: rejects forged, wrong-secret, stale and unsigned events');

    r = await hook({ id: 'evt_6', type: 'checkout.session.completed', livemode: false, data: { object: { mode: 'subscription', payment_status: 'unpaid', amount_total: 225000, currency: 'usd', subscription: 'sub_1', customer_details: { email: 'a@b.co' }, metadata: { plan: 'startup_partnership' } } } });
    assert.strictEqual(r.status, 200);
    n = notes.pop(); assert.strictEqual(n.get('status'), 'processing'); assert.strictEqual(n.get('reference'), 'sub_1');
    r = await hook({ id: 'evt_7', type: 'invoice.payment_failed', livemode: false, data: { object: { billing_reason: 'subscription_cycle', amount_due: 225000, currency: 'usd', number: 'L8ZL-0002', customer_email: 'a@b.co', metadata: {} } } });
    n = notes.pop(); assert.strictEqual(n.get('label'), 'Monthly renewal failed'); assert.strictEqual(n.get('status'), 'failed');
    r = await hook({ id: 'evt_8', type: 'invoice.paid', livemode: false, data: { object: { billing_reason: 'manual', amount_paid: 125050, metadata: { source: 'aethera_pay_page' } } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 1);
    r = await hook({ id: 'evt_9', type: 'customer.subscription.updated', livemode: false, data: { object: { id: 'sub_1', status: 'past_due', metadata: {} }, previous_attributes: { status: 'active' } } });
    n = notes.pop(); assert.strictEqual(n.get('label'), 'Subscription status: past_due');
    r = await hook({ id: 'evt_10', type: 'customer.created', livemode: false, data: { object: {} } });
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 1);
    ok('webhook: ACH processing, failed renewal, status change recorded; pay-page receipts and other events skipped');

    failNotify = true;
    r = await hook(Object.assign({}, paidSession, { id: 'evt_11' }));
    assert.strictEqual(r.status, 500);
    failNotify = false;
    r = await hook(Object.assign({}, paidSession, { id: 'evt_11' }));
    assert.strictEqual(r.status, 200); assert.strictEqual(notes.length, 2);
    ok('webhook: returns 500 when the sheet is unreachable so Stripe retries, then records on retry');

    r = await request(port, 'GET', '/api/stripe/webhook');
    assert.strictEqual(r.status, 404);
    ok('webhook: POST only');

    // static + traversal
    r = await request(port, 'GET', '/');
    assert.strictEqual(r.status, 200); assert.ok(r.body.includes('<title>Aethera Digital'));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    r = await request(port, 'GET', '/pay');
    assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.location, '/pay/');
    r = await request(port, 'GET', '/pay/complete/?session_id=x');
    assert.strictEqual(r.status, 200);
    r = await request(port, 'GET', '/../server.js');
    assert.notStrictEqual(r.status, 200);
    r = await request(port, 'GET', '/%2e%2e/server.js');
    assert.notStrictEqual(r.status, 200);
    r = await request(port, 'GET', '/nope');
    assert.strictEqual(r.status, 404); assert.ok(r.body.includes('drifted off'));
    r = await request(port, 'GET', '/assets/icon.png');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'image/png');
    ok('serves pages, assets, 404 and blocks path traversal');

    console.log('\n' + passed + ' passed');
  } catch (e) {
    console.error('\nFAILED:', e.message); process.exitCode = 1;
  } finally {
    child.kill(); fakeStripe.close();
  }
})();
