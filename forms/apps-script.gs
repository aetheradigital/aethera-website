/**
 * Aethera website inquiry handler.
 * Lives in the "Aethera Website Inquiries" sheet: Extensions > Apps Script.
 * Deployed as a web app: Execute as "Me", Who has access "Anyone".
 * The site posts to it from window.AETHERA_FORM_ENDPOINT in index.html.
 */
var NOTIFY_TO = 'hello@aetheradigital.com';

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p.kind === 'payment') return payment_(p);
  if (p.company_site) return json_({ ok: true }); // spam trap

  var name = clip_(p.name, 200);
  var email = clip_(p.email, 200);
  var needs = clip_(p.needs, 500);
  var message = clip_(p.message, 5000);
  var page = clip_(p.page, 500);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json_({ ok: false, error: 'invalid' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]
      .appendRow([new Date(), name, email, needs, message, page]);
  } finally {
    lock.releaseLock();
  }

  MailApp.sendEmail({
    to: NOTIFY_TO,
    replyTo: email,
    subject: 'New website inquiry: ' + name,
    body: 'Name: ' + name + '\nEmail: ' + email + '\nNeeds: ' + (needs || '-') +
          '\n\n' + (message || '(no message)') + '\n\nSent from ' + page
  });
  return json_({ ok: true });
}

/**
 * Payment events forwarded by the site's Stripe webhook (/api/stripe/webhook).
 * Set the script property PAYMENTS_TOKEN (Project Settings > Script properties) to the same
 * value as PAYMENTS_NOTIFY_TOKEN in Render. Rows go to a "Payments" tab, created on first use.
 */
var PAYMENT_HEADERS = ['Received', 'Event', 'Status', 'Amount', 'Client', 'Email', 'Plan',
  'Invoice #', 'Stripe customer', 'Reference', 'Mode', 'Stripe event id', 'Event type'];

function payment_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty('PAYMENTS_TOKEN');
  if (!expected || p.token !== expected) return json_({ ok: false, error: 'unauthorized' });

  var mode = p.livemode === 'true' ? 'live' : 'test';
  var row = [new Date(), clip_(p.label, 200), clip_(p.status, 50), clip_(p.amount, 50), clip_(p.name, 200),
    clip_(p.email, 200), clip_(p.plan, 100), clip_(p.invoice_number, 50), clip_(p.customer, 100),
    clip_(p.reference, 500), mode, clip_(p.event_id, 100), clip_(p.event_type, 100)];

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Payments');
    if (!sheet) {
      sheet = ss.insertSheet('Payments');
      sheet.appendRow(PAYMENT_HEADERS);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }

  var who = p.name || p.email || p.customer || 'client';
  MailApp.sendEmail({
    to: NOTIFY_TO,
    subject: (mode === 'test' ? '[TEST] ' : '') + p.label + (p.amount ? ': ' + p.amount : '') + ' (' + who + ')',
    body: 'Event: ' + p.label + '\nStatus: ' + p.status + '\nAmount: ' + (p.amount || '-') +
          '\nClient: ' + (p.name || '-') + '\nEmail: ' + (p.email || '-') + '\nPlan: ' + (p.plan || '-') +
          '\nInvoice #: ' + (p.invoice_number || '-') + '\nReference: ' + (p.reference || '-') +
          '\n\nStripe event ' + p.event_id + ' (' + p.event_type + ', ' + mode + ' mode)'
  });
  return json_({ ok: true });
}

function doGet() {
  return json_({ ok: true, service: 'aethera-inquiries' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clip_(v, n) {
  return String(v == null ? '' : v).replace(/^[=+\-@]/, "'$&").trim().slice(0, n);
}
