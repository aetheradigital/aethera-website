'use strict';
/*
 * The branded signed-quote PDF: the same content as the signed quote page (scope, pricing, schedule, terms,
 * signature and audit trail) in Aethera's styling — black pages, the plain æthera wordmark, pastel accents.
 * This one file is what the Desk and portal download, what's emailed to the signer and what's filed to the client.
 */
const fs = require('fs');
const path = require('path');
const pdf = require('./pdf');

const C = { bg: '#000000', panel: '#121217', panel2: '#1A1726', line: '#26262C', white: '#FFFFFF', body: '#D6D6DC', mute: '#A3A3AD', lav: '#C8B6FF', sage: '#CFE8B4', peach: '#FFC4A8' };
const PAGE_W = 612, PAGE_H = 792, M = 54, W = PAGE_W - M * 2, TOP = 92, BOTTOM = PAGE_H - 64;

let WORDMARK = null;
try { WORDMARK = pdf.decodePng(fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'wordmark.png'))); } catch (e) { WORDMARK = null; }

function signaturePng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  return m ? pdf.decodePng(Buffer.from(m[1], 'base64')) : null;
}

// fmt: { money(cents), longDate(yyyy-mm-dd|iso), stamp(iso) }; quotes: lib/quotes.js
function signedQuotePdf(q, client, terms, quotes, fmt) {
  const a = q.acceptance || {};
  const t = quotes.totals(q, a.selected || []);
  const items = quotes.includedItems(q, a.selected || []);
  const oneTime = items.filter(function (it) { return it.billing !== 'monthly'; });
  const monthly = items.filter(function (it) { return it.billing === 'monthly'; });
  const sched = quotes.installments(q, t.total);
  const m = fmt.money;

  const doc = new pdf.Doc({ width: PAGE_W, height: PAGE_H, info: { Title: 'Signed Quote ' + (q.number || '') + ' - ' + (q.title || ''), Author: 'Aethera Digital', Subject: 'Signed quote' } });
  const mark = doc.addImage(WORDMARK);
  const sigImg = doc.addImage(signaturePng(a.signature));
  let y = 0;

  function newPage() {
    doc.addPage();
    doc.rect(0, 0, PAGE_W, PAGE_H, C.bg);
    if (mark) doc.image(mark, M, 34, 52, 52 * mark.png.height / mark.png.width);
    doc.text('SIGNED QUOTE  ·  ' + (q.number || ''), PAGE_W - M, 40, { size: 7.5, color: C.mute, align: 'right', font: 'bold' });
    y = TOP;
  }
  function ensure(h) { if (y + h > BOTTOM) newPage(); }
  function eyebrow(str, color, x) { doc.text(String(str).toUpperCase(), x == null ? M : x, y, { size: 7.5, font: 'bold', color: color || C.mute, tracking: 1.6 }); }
  function para(str, opts) {
    opts = opts || {};
    const size = opts.size || 10.5, lh = size * (opts.lh || 1.5), font = opts.font || 'regular', width = opts.width || W, x = opts.x == null ? M : opts.x;
    for (const ln of pdf.wrap(str, font, size, width)) { ensure(lh); doc.text(ln, x, y + (lh - size) / 2, { size: size, font: font, color: opts.color || C.body }); y += lh; }
  }
  // keep: room the first block after the heading needs, so a heading never sits alone at the bottom of a page.
  function heading(str, keep) {
    ensure(52 + (keep || 40));
    y += 22;
    doc.text(str, M, y, { size: 17, color: C.white });
    y += 30;
  }
  // Rows of cells: [{ lines: [{ text, font, size, color }], w, align }]. Rows never split across pages.
  function table(cols, rows, opts) {
    opts = opts || {};
    if (opts.head) {
      ensure(40);
      let x = M;
      cols.forEach(function (c, i) { doc.text(opts.head[i].toUpperCase(), c.align === 'right' ? x + c.w : x, y, { size: 7, font: 'bold', color: C.mute, align: c.align === 'right' ? 'right' : 'left', tracking: 1.2 }); x += c.w; });
      y += 14; doc.line(M, y, M + W, y, C.line, 0.75);
    }
    for (const row of rows) {
      const laid = row.cells.map(function (cell, i) {
        const c = cols[i], out = [];
        for (const part of cell) {
          const size = part.size || 10;
          for (const ln of pdf.wrap(part.text, part.font || 'regular', size, c.w - (i < cols.length - 1 ? 14 : 0))) out.push({ text: ln, size: size, font: part.font || 'regular', color: part.color || C.white, lh: size * 1.45 });
        }
        return out;
      });
      const pad = opts.pad == null ? 9 : opts.pad;
      const h = Math.max.apply(null, laid.map(function (ls) { return ls.reduce(function (s, l) { return s + l.lh; }, 0); })) + pad * 2;
      ensure(h);
      if (row.fill) doc.roundRect(M - 10, y + 2, W + 20, h - 4, 8, row.fill);
      let x = M;
      laid.forEach(function (ls, i) {
        const c = cols[i]; let ly = y + pad;
        for (const l of ls) { doc.text(l.text, c.align === 'right' ? x + c.w : x, ly + (l.lh - l.size) / 2, { size: l.size, font: l.font, color: l.color, align: c.align === 'right' ? 'right' : 'left' }); ly += l.lh; }
        x += c.w;
      });
      y += h;
      if (!row.noLine) doc.line(M, y, M + W, y, C.line, 0.75);
    }
  }

  // ---------- page 1: hero ----------
  newPage();
  y = 118;
  eyebrow('Signed quote', C.lav);
  y += 20;
  for (const ln of pdf.wrap(q.title || 'Quote', 'regular', 30, W)) { doc.text(ln, M, y, { size: 30, color: C.white }); y += 36; }
  y += 4;
  doc.text('Quote ' + (q.number || '') + '   ·   Issued ' + fmt.longDate(q.issued) + '   ·   Signed ' + fmt.longDate(a.at), M, y, { size: 9.5, color: C.mute });
  y += 26;
  if (q.summary) { para(q.summary, { size: 11.5, color: C.body }); y += 6; }

  // parties
  y += 8; doc.line(M, y, M + W, y, C.line, 0.75); y += 18;
  const half = W / 2;
  eyebrow('Prepared for'); eyebrow('Prepared by', null, M + half);
  y += 16;
  const forLines = [client && client.name, client && client.company].filter(Boolean);
  const byLines = [q.prepared_by || 'Aethera Digital', 'Aethera Digital', 'hello@aetheradigital.com'];
  const startY = y;
  forLines.forEach(function (s, i) { doc.text(s, M, startY + i * 16, { size: 11, font: i ? 'regular' : 'bold', color: i ? C.body : C.white }); });
  byLines.forEach(function (s, i) { doc.text(s, M + half, startY + i * 16, { size: 11, font: i ? 'regular' : 'bold', color: i ? C.body : C.white }); });
  y = startY + Math.max(forLines.length, byLines.length) * 16 + 18;

  // price card
  const cells = [];
  if (t.total) cells.push(['Project total', m(t.total), t.rate_discount || t.startup_discount ? 'Saves ' + m((t.rate_discount || 0) + (t.startup_discount || 0)) : '']);
  if (t.monthly) cells.push(['Monthly', m(t.monthly) + '/mo', 'Month-to-month']);
  if (cells.length) {
    ensure(86);
    const cw = W / cells.length;
    doc.roundRect(M, y, W, 76, 14, C.panel);
    cells.forEach(function (c, i) {
      const x = M + i * cw + 20;
      if (i) doc.line(M + i * cw, y + 14, M + i * cw, y + 62, C.line, 0.75);
      const save = y; y = save + 16; eyebrow(c[0], C.mute, x); y = save;
      doc.text(c[1], x, save + 31, { size: 22, color: C.white });
      if (c[2]) doc.text(c[2], x, save + 57, { size: 8.5, color: i === 0 && /^Saves/.test(c[2]) ? C.sage : C.mute });
    });
    y += 76;
  }

  // ---------- scope and pricing ----------
  const row = function (it) {
    const l = t.lines[it.id] || { amount: 0 };
    const left = [{ text: it.name + (it.optional ? '   (Add-on)' : ''), font: 'bold', size: 10.5 }];
    if (it.description) left.push({ text: it.description, size: 9, color: C.mute });
    if (it.timeline) left.push({ text: it.timeline, size: 9, color: C.lav });
    return { cells: [left, [{ text: it.pricing === 'hours' ? it.hours + ' h' : '-', size: 10, color: C.body }], [{ text: m(l.amount) + (it.billing === 'monthly' ? '/mo' : ''), size: 10.5 }]] };
  };
  const cols3 = [{ w: W - 160 }, { w: 60, align: 'right' }, { w: 100, align: 'right' }];
  if (oneTime.length) {
    heading('Project Scope');
    table(cols3, oneTime.map(row), { head: ['Phase', 'Hours', 'Amount'] });
    y += 10;
    const sums = [];
    if (t.rate_discount) {
      sums.push({ cells: [[{ text: 'Standard price (' + t.hours + ' h x $' + q.standard_rate + '/hr)', color: C.body }], [{ text: '' }], [{ text: m(t.standard), color: C.body }]] });
      sums.push({ cells: [[{ text: 'Rate discount ($' + q.standard_rate + ' to $' + q.rate + '/hr)', color: C.sage }], [{ text: '' }], [{ text: '-' + m(t.rate_discount), color: C.sage }]] });
    } else sums.push({ cells: [[{ text: 'Subtotal', color: C.body }], [{ text: '' }], [{ text: m(t.subtotal), color: C.body }]] });
    if (t.startup_discount) sums.push({ cells: [[{ text: 'Startup discount (' + t.startup_pct + '%, -' + t.startup_hours + ' h)', color: C.sage }], [{ text: '' }], [{ text: '-' + m(t.startup_discount), color: C.sage }]] });
    sums.push({ fill: C.panel2, noLine: true, cells: [[{ text: 'Project total', font: 'bold', size: 12 }], [{ text: '' }], [{ text: m(t.total), font: 'bold', size: 12 }]] });
    ensure(sums.length * 30 + 6);
    table(cols3, sums, { pad: 7 });
  }
  if (monthly.length) {
    heading('Monthly Services');
    const start = q.monthly_start && a.at && q.monthly_start > a.at.slice(0, 10) ? q.monthly_start : (a.at || '').slice(0, 10);
    table(cols3, monthly.map(row).concat([{ fill: C.panel2, noLine: true, cells: [[{ text: 'Monthly total', font: 'bold', size: 12 }, { text: 'Starts ' + fmt.longDate(start) + ', month-to-month', size: 9, color: C.mute }], [{ text: '' }], [{ text: m(t.monthly) + '/mo', font: 'bold', size: 12 }]] }]), { head: ['Service', '', 'Monthly'] });
  }
  if (sched.length) {
    heading('Payment Schedule');
    const whenText = function (s) { return s.when === 'signing' ? 'On signing' : s.when === 'date' ? fmt.longDate(s.date) : 'At milestone'; };
    table([{ w: W - 290 }, { w: 60, align: 'right' }, { w: 130, align: 'right' }, { w: 100, align: 'right' }],
      sched.map(function (s) { return { cells: [[{ text: s.label, size: 10.5 }], [{ text: s.percent + '%', color: C.body }], [{ text: whenText(s), color: C.body }], [{ text: m(s.amount), size: 10.5 }]] }; }),
      { head: ['Installment', 'Share', 'Due', 'Amount'] });
  }
  if (q.included) { heading('Included'); para(q.included); }
  if (q.not_included) { heading('Not Included'); para(q.not_included); }
  if (q.notes) { heading('Notes'); para(q.notes); }
  if (terms) { heading('Terms of Service (Version ' + terms.version + ')'); para(terms.body, { size: 8.5, lh: 1.5 }); }

  // ---------- acceptance ----------
  heading('Acceptance', 160);
  const boxW = W / 2 - 14;
  doc.roundRect(M, y, boxW, 92, 12, C.white);
  if (sigImg) {
    const p = sigImg.png, s = Math.min((boxW - 24) / p.width, 72 / p.height);
    doc.image(sigImg, M + (boxW - p.width * s) / 2, y + (92 - p.height * s) / 2, p.width * s, p.height * s);
  }
  const rx = M + W / 2 + 14;
  const right = [['Prepared by', ''], [q.prepared_by || 'Aethera Digital', 'bold'], ['Aethera Digital', ''], ['Issued ' + fmt.longDate(q.issued), '']];
  let ry = y + 4;
  right.forEach(function (r, i) { if (!i) { const save = y; y = ry; eyebrow(r[0], C.mute, rx); y = save; ry += 18; return; } doc.text(r[0], rx, ry, { size: 10.5, font: r[1] || 'regular', color: r[1] ? C.white : C.body }); ry += 16; });
  y += 104;
  const left = [[a.name + (a.title ? ', ' + a.title : ''), 'bold'], [a.email || '', ''], ['Signed ' + (a.at ? fmt.stamp(a.at) : ''), '']];
  left.forEach(function (r) { doc.text(r[0], M, y, { size: 10.5, font: r[1] || 'regular', color: r[1] ? C.white : C.body }); y += 16; });

  // ---------- audit trail ----------
  const trail = (q.events || []).filter(function (e) { return ['sent', 'viewed', 'accepted'].indexOf(e.what) >= 0; });
  heading('Audit Trail');
  table([{ w: 190 }, { w: W - 190 }], trail.map(function (e) {
    return { cells: [[{ text: fmt.stamp(e.at), size: 8.5, color: C.body }], [{ text: ({ sent: 'Sent to client', viewed: 'Opened by client', accepted: 'Signed by ' + a.name }[e.what]) + (e.ip ? '  ·  IP ' + e.ip : ''), size: 8.5, color: C.body }]] };
  }), { pad: 6 });
  y += 10;
  para('Browser: ' + (a.user_agent || ''), { size: 7.5, color: C.mute, lh: 1.45 });
  para('Document fingerprint (SHA-256): ' + (a.fingerprint || ''), { size: 7.5, color: C.mute, lh: 1.45 });

  // footers, now that the page count is known
  const n = doc.pages.length;
  doc.pages.forEach(function (pg, i) {
    doc.page = pg;
    doc.line(M, PAGE_H - 46, M + W, PAGE_H - 46, C.line, 0.75);
    doc.text('Aethera Digital  ·  aetheradigital.com  ·  hello@aetheradigital.com', M, PAGE_H - 36, { size: 7.5, color: C.mute, link: 'https://aetheradigital.com' });
    doc.text('Page ' + (i + 1) + ' of ' + n, PAGE_W - M, PAGE_H - 36, { size: 7.5, color: C.mute, align: 'right' });
  });
  return doc.toBuffer();
}

module.exports = { signedQuotePdf };
