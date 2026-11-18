/**
 * Aethera website inquiry handler.
 * Lives in the "Aethera Website Inquiries" sheet: Extensions > Apps Script.
 * Deployed as a web app: Execute as "Me", Who has access "Anyone".
 * The site posts to it from window.AETHERA_FORM_ENDPOINT in index.html.
 */
var NOTIFY_TO = 'hello@aetheradigital.com';

function doPost(e) {
  var p = (e && e.parameter) || {};
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
