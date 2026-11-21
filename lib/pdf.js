'use strict';
/*
 * A small, dependency-free PDF writer: pages, filled shapes, text in Helvetica (regular and bold, with real widths
 * for wrapping and right-aligning) and PNG images (alpha kept as a soft mask). Coordinates are in points from the
 * top-left of the page; the writer flips them to PDF's bottom-left origin.
 */
const zlib = require('zlib');

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for WinAnsi codes 32–255, from Adobe's core-font AFMs.
const WIDTHS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 278, 556, 278, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 278, 611, 278, 278, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 278, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 278, 278, 333, 556, 537, 278, 333, 278, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 278, 556, 278, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 278, 611, 278, 278, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 278, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 278, 278, 333, 611, 556, 278, 333, 278, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556]
};
const FONTS = { regular: 'F1', bold: 'F2' };

// Unicode -> WinAnsi (cp1252). Anything outside it becomes "?"; common punctuation is folded first.
const WIN = new Map();
(function () {
  const dec = new TextDecoder('windows-1252');
  for (let b = 32; b < 256; b++) { const ch = dec.decode(Uint8Array.of(b)); if (ch !== '�') WIN.set(ch, b); }
})();
const FOLD = { '−': '-', '‐': '-', '‑': '-', '→': '->', '←': '<-', '✓': 'v', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '\t': '    ' };
function toWin(s) {
  const out = [];
  for (const ch of String(s == null ? '' : s)) {
    const f = FOLD[ch];
    if (f !== undefined) { for (const c of f) out.push(WIN.get(c) || 63); continue; }
    out.push(WIN.has(ch) ? WIN.get(ch) : 63);
  }
  return out;
}
function widthOf(s, font, size) {
  const w = WIDTHS[FONTS[font] || font];
  let t = 0;
  for (const b of toWin(s)) t += w[b - 32] || 556;
  return t * size / 1000;
}
// Word-wraps text (respecting newlines) to a width; very long words are broken.
function wrap(text, font, size, width) {
  const lines = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      const tryLine = line ? line + ' ' + word : word;
      if (widthOf(tryLine, font, size) <= width) { line = tryLine; continue; }
      if (line) { lines.push(line); line = ''; }
      while (widthOf(word, font, size) > width && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && widthOf(word.slice(0, n), font, size) > width) n--;
        lines.push(word.slice(0, n)); word = word.slice(n);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

// ---------- PNG ----------
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
// Decodes an 8-bit, non-interlaced PNG into separate RGB and alpha planes. Returns null for anything else.
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!w || !h || depth !== 8 || interlace || !chans || w * h > 25e6) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  const stride = w * chans;
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chans ? px[dst + x - chans] : 0, b = y ? px[dst - stride + x] : 0, c = x >= chans && y ? px[dst - stride + x - chans] : 0;
      const v = raw[src + x];
      px[dst + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  let alpha = (type === 4 || type === 6 || (type === 3 && trns)) ? Buffer.alloc(w * h) : null;
  for (let i = 0; i < w * h; i++) {
    if (type === 2 || type === 6) { rgb[i * 3] = px[i * chans]; rgb[i * 3 + 1] = px[i * chans + 1]; rgb[i * 3 + 2] = px[i * chans + 2]; if (type === 6) alpha[i] = px[i * 4 + 3]; }
    else if (type === 0 || type === 4) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = px[i * chans]; if (type === 4) alpha[i] = px[i * 2 + 1]; }
    else { const k = px[i]; if (!palette || k * 3 + 2 >= palette.length) return null; rgb[i * 3] = palette[k * 3]; rgb[i * 3 + 1] = palette[k * 3 + 1]; rgb[i * 3 + 2] = palette[k * 3 + 2]; if (alpha) alpha[i] = k < trns.length ? trns[k] : 255; }
  }
  if (alpha && alpha.every(function (v) { return v === 255; })) alpha = null;
  return { width: w, height: h, rgb: rgb, alpha: alpha };
}

// ---------- document ----------
function hex(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || '#000000'); const n = parseInt(m ? m[1] : '000000', 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(function (v) { return v.toFixed(3); }).join(' '); }
function num(v) { return (Math.round(v * 100) / 100).toString(); }
function pdfString(s) {
  const bytes = toWin(s);
  let out = '(';
  for (const b of bytes) out += b === 40 || b === 41 || b === 92 ? '\\' + String.fromCharCode(b) : String.fromCharCode(b);
  return out + ')';
}

class Doc {
  constructor(opts) {
    opts = opts || {};
    this.width = opts.width || 612; this.height = opts.height || 792;
    this.pages = []; this.images = []; this.info = opts.info || {};
  }
  addPage() { const p = { ops: [] }; this.pages.push(p); this.page = p; return p; }
  y(top) { return this.height - top; }
  rect(x, top, w, h, color) { this.page.ops.push(hex(color) + ' rg ' + num(x) + ' ' + num(this.y(top + h)) + ' ' + num(w) + ' ' + num(h) + ' re f'); }
  // A filled rectangle with rounded corners (Bézier arcs).
  roundRect(x, top, w, h, r, color) {
    r = Math.min(r, w / 2, h / 2); const k = 0.5523 * r, b = this.y(top + h), t = this.y(top);
    this.page.ops.push(hex(color) + ' rg ' + [
      num(x + r) + ' ' + num(b) + ' m', num(x + w - r) + ' ' + num(b) + ' l',
      num(x + w - r + k) + ' ' + num(b) + ' ' + num(x + w) + ' ' + num(b + r - k) + ' ' + num(x + w) + ' ' + num(b + r) + ' c',
      num(x + w) + ' ' + num(t - r) + ' l',
      num(x + w) + ' ' + num(t - r + k) + ' ' + num(x + w - r + k) + ' ' + num(t) + ' ' + num(x + w - r) + ' ' + num(t) + ' c',
      num(x + r) + ' ' + num(t) + ' l',
      num(x + r - k) + ' ' + num(t) + ' ' + num(x) + ' ' + num(t - r + k) + ' ' + num(x) + ' ' + num(t - r) + ' c',
      num(x) + ' ' + num(b + r) + ' l',
      num(x) + ' ' + num(b + r - k) + ' ' + num(x + r - k) + ' ' + num(b) + ' ' + num(x + r) + ' ' + num(b) + ' c'
    ].join(' ') + ' h f');
  }
  line(x1, top1, x2, top2, color, width) { this.page.ops.push(hex(color) + ' RG ' + num(width || 0.75) + ' w ' + num(x1) + ' ' + num(this.y(top1)) + ' m ' + num(x2) + ' ' + num(this.y(top2)) + ' l S'); }
  // Draws one line of text; `top` is the top of the text's line box (baseline sits at top + 0.8 × size).
  text(str, x, top, opts) {
    opts = opts || {};
    const font = opts.font || 'regular', size = opts.size || 10;
    let tx = x;
    const w = widthOf(str, font, size) + (opts.tracking ? opts.tracking * Math.max(0, toWin(str).length - 1) : 0);
    if (opts.align === 'right') tx = x - w;
    else if (opts.align === 'center') tx = x - w / 2;
    const spacing = opts.tracking ? num(opts.tracking) + ' Tc ' : '';
    this.page.ops.push('BT ' + hex(opts.color || '#ffffff') + ' rg /' + FONTS[font] + ' ' + num(size) + ' Tf ' + spacing + num(tx) + ' ' + num(this.y(top + size * 0.8)) + ' Td ' + pdfString(str) + ' Tj' + (opts.tracking ? ' 0 Tc' : '') + ' ET');
    if (opts.link) this.page.links = (this.page.links || []).concat([{ x: tx, top: top, w: w, h: size, url: opts.link }]);
  }
  // Registers a decoded PNG once; returns a handle for image().
  addImage(png) {
    if (!png) return null;
    const img = { name: 'Im' + (this.images.length + 1), png: png };
    this.images.push(img);
    return img;
  }
  image(img, x, top, w, h) { if (img) this.page.ops.push('q ' + num(w) + ' 0 0 ' + num(h) + ' ' + num(x) + ' ' + num(this.y(top + h)) + ' cm /' + img.name + ' Do Q'); }

  toBuffer() {
    const objs = []; // index = object number - 1
    const add = function (body) { objs.push(body); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    const f2 = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
    const stream = function (dict, data) { return Buffer.concat([Buffer.from('<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n'), data, Buffer.from('\nendstream')]); };
    const xobj = [];
    for (const img of this.images) {
      const p = img.png;
      let smask = '';
      if (p.alpha) smask = ' /SMask ' + add(stream('/Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', zlib.deflateSync(p.alpha))) + ' 0 R';
      const id = add(stream('/Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode' + smask, zlib.deflateSync(p.rgb)));
      xobj.push('/' + img.name + ' ' + id + ' 0 R');
    }
    const resources = '<< /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >>' + (xobj.length ? ' /XObject << ' + xobj.join(' ') + ' >>' : '') + ' >>';
    const kids = [];
    for (const pg of this.pages) {
      const content = add(stream('/Filter /FlateDecode', zlib.deflateSync(Buffer.from(pg.ops.join('\n'), 'latin1'))));
      const annots = (pg.links || []).map(function (l) {
        return add(Buffer.from('<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [' + [l.x, this.y(l.top + l.h), l.x + l.w, this.y(l.top)].map(num).join(' ') + '] /A << /S /URI /URI ' + pdfString(l.url) + ' >> >>', 'latin1')) + ' 0 R';
      }, this);
      kids.push(add(Buffer.from('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + this.width + ' ' + this.height + '] /Resources ' + resources + ' /Contents ' + content + ' 0 R' + (annots.length ? ' /Annots [' + annots.join(' ') + ']' : '') + ' >>')));
    }
    objs[pagesObj - 1] = Buffer.from('<< /Type /Pages /Kids [' + kids.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>');
    objs[catalog - 1] = Buffer.from('<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>');
    const infoParts = Object.keys(this.info).map(function (k) { return '/' + k + ' ' + pdfString(this.info[k]); }, this);
    const infoId = add(Buffer.from('<< ' + infoParts.join(' ') + ' /Producer (Aethera Digital) >>', 'latin1'));

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach(function (body, i) {
      const head = Buffer.from((i + 1) + ' 0 obj\n'), tail = Buffer.from('\nendobj\n');
      offsets.push(offset);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    let xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    chunks.push(Buffer.from(xref + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + offset + '\n%%EOF\n'));
    return Buffer.concat(chunks);
  }
}

module.exports = { Doc, decodePng, widthOf, wrap, toWin };
