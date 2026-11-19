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
  if (p.kind === 'invoice_email') return invoiceEmail_(p);
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

/**
 * Branded invoice email, sent when an invoice is created or resent from aetheradigital.com/admin.
 * Uses the same PAYMENTS_TOKEN script property. Sends from the account that owns this script;
 * replies go to hello@aetheradigital.com.
 */
function invoiceEmail_(p) {
  var expected = PropertiesService.getScriptProperties().getProperty('PAYMENTS_TOKEN');
  if (!expected || p.token !== expected) return json_({ ok: false, error: 'unauthorized' });
  var to = String(p.to || '').trim();
  var url = String(p.url || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !/^https:\/\//.test(url)) return json_({ ok: false, error: 'invalid' });

  var test = p.livemode !== 'true';
  var number = esc_(p.number), amount = esc_(p.amount), due = esc_(p.due), memo = esc_(p.memo);
  var first = esc_(String(p.name || '').split(' ')[0]);
  var subject = (test ? '[TEST] ' : '') + 'Invoice ' + p.number + ' from Aethera Digital: ' + p.amount + (p.due ? ' due ' + p.due : '');

  var html =
    '<div style="background:#000;padding:40px 16px;font-family:Avenir Next,Avenir,Helvetica,Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#0B0B0E;border:1px solid #26262c;border-radius:24px">' +
    '<tr><td style="padding:40px 40px 8px">' +
    '<p style="margin:0;font-size:12px;letter-spacing:4px;text-transform:uppercase;color:#A3A3AD;font-weight:600">Aethera Digital' + (test ? ' &middot; test' : '') + '</p>' +
    '<p style="margin:24px 0 0;font-size:17px;line-height:1.6;color:#D6D6DC">' + (first ? 'Hi ' + first + ',' : 'Hello,') + '</p>' +
    '<p style="margin:12px 0 0;font-size:17px;line-height:1.6;color:#D6D6DC">Here&rsquo;s invoice <strong style="color:#fff">' + number + '</strong>. You can review it and pay securely online by bank account or card.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 40px 8px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#121217;border-radius:16px"><tr><td style="padding:24px">' +
    '<p style="margin:0;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#A3A3AD;font-weight:600">Amount due</p>' +
    '<p style="margin:6px 0 0;font-size:40px;font-weight:300;color:#fff;letter-spacing:-1px">' + amount + '</p>' +
    (due ? '<p style="margin:6px 0 0;font-size:15px;color:#C8B6FF">Due ' + due + '</p>' : '') +
    (memo ? '<p style="margin:16px 0 0;font-size:15px;line-height:1.5;color:#D6D6DC">' + memo + '</p>' : '') +
    '</td></tr></table></td></tr>' +
    '<tr><td style="padding:24px 40px 8px"><a href="' + url + '" style="display:inline-block;background:#fff;color:#000;text-decoration:none;font-weight:700;font-size:16px;padding:16px 32px;border-radius:999px">View &amp; pay invoice</a></td></tr>' +
    '<tr><td style="padding:24px 40px 40px"><p style="margin:0;font-size:13px;line-height:1.6;color:#A3A3AD">Paying by US bank account (ACH) is preferred. Questions? Just reply to this email.<br>Aethera Digital &middot; aetheradigital.com</p></td></tr>' +
    '</table></div>';
  var text = (first ? 'Hi ' + p.name.split(' ')[0] + ',' : 'Hello,') + '\n\nHere is invoice ' + p.number + ' for ' + p.amount +
    (p.due ? ', due ' + p.due : '') + '.\n' + (p.memo ? '\n' + p.memo + '\n' : '') +
    '\nView and pay online: ' + url + '\n\nQuestions? Just reply to this email.\nAethera Digital';

  MailApp.sendEmail({ to: to, replyTo: NOTIFY_TO, name: 'Aethera Digital', subject: subject, body: text, htmlBody: html });
  return json_({ ok: true });
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
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
