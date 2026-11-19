'use strict';
/**
 * Minimal PostgreSQL client (no dependencies) for the Aethera Desk.
 * Supports: TLS (sslmode=require / no-verify), SCRAM-SHA-256, MD5 and cleartext auth,
 * parameterized queries via the extended protocol (text format), and automatic reconnects.
 * Queries run one at a time on a single connection, which is plenty for an internal admin tool.
 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function parseUrl(url) {
  const u = new URL(url);
  const ssl = u.searchParams.get('sslmode') || u.searchParams.get('ssl') || '';
  return {
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
    ssl: ssl === 'require' || ssl === 'true' || ssl === 'no-verify' || ssl === 'verify-full' ? ssl : (ssl === 'disable' ? '' : 'prefer')
  };
}

function cstr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function msg(type, body) {
  const t = type ? Buffer.from(type) : Buffer.alloc(0);
  return Buffer.concat([t, i32(body.length + 4), body]);
}

function toParam(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return Buffer.from('\\x' + v.toString('hex'));
  if (v instanceof Date) return Buffer.from(v.toISOString());
  if (typeof v === 'object') return Buffer.from(JSON.stringify(v));
  if (typeof v === 'boolean') return Buffer.from(v ? 'true' : 'false');
  return Buffer.from(String(v), 'utf8');
}

function fromText(buf, oid) {
  if (buf === null) return null;
  const s = buf.toString('utf8');
  switch (oid) {
    case 16: return s === 't';
    case 20: case 21: case 23: case 26: return Number(s);
    case 700: case 701: case 1700: return Number(s);
    case 114: case 3802: return JSON.parse(s);
    case 17: return s.startsWith('\\x') ? Buffer.from(s.slice(2), 'hex') : Buffer.from(s, 'binary');
    case 1114: case 1184: return new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
    default: return s;
  }
}

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Postgres error');
    this.code = fields.C; this.detail = fields.D; this.severity = fields.S;
  }
}

class Connection {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.closed = false; }

  async open() {
    const c = this.cfg;
    let sock = net.connect({ host: c.host, port: c.port });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (c.ssl) {
      sock.write(Buffer.concat([i32(8), i32(80877103)]));
      const answer = await new Promise((res, rej) => { sock.once('data', (d) => res(d[0])); sock.once('error', rej); });
      if (answer === 0x53) { // 'S'
        const opts = { socket: sock, servername: net.isIP(c.host) ? undefined : c.host };
        if (c.ssl !== 'verify-full') opts.rejectUnauthorized = false;
        sock = tls.connect(opts);
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      } else if (c.ssl === 'require' || c.ssl === 'verify-full' || c.ssl === 'no-verify') {
        sock.destroy(); throw new Error('Server does not support SSL');
      }
    }
    this.sock = sock;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    const fail = (e) => {
      this.closed = true;
      const err = e || new Error('Connection closed');
      this.waiters.splice(0).forEach((w) => w.reject(err));
    };
    sock.on('error', fail); sock.on('close', () => fail());
    sock.write(msg(null, Buffer.concat([i32(196608), cstr('user'), cstr(c.user), cstr('database'), cstr(c.database), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])])));
    await this.auth();
  }

  // Message reader: resolves the next backend message.
  next() {
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.waiters.length && this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      this.waiters.shift().resolve(m);
    }
  }
  static errorFields(body) {
    const f = {}; let i = 0;
    while (i < body.length && body[i] !== 0) { const code = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[code] = body.toString('utf8', i + 1, end); i = end + 1; }
    return f;
  }

  async auth() {
    const c = this.cfg; let scram = null;
    for (;;) {
      const m = await this.next();
      if (m.type === 'E') throw new PgError(Connection.errorFields(m.body));
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) { this.sock.write(msg('p', cstr(c.password))); continue; }
        if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const inner = crypto.createHash('md5').update(c.password + c.user).digest('hex');
          const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this.sock.write(msg('p', cstr(outer))); continue;
        }
        if (code === 10) {
          const mechs = m.body.toString('utf8', 4).split('\0');
          if (mechs.indexOf('SCRAM-SHA-256') < 0) throw new Error('Unsupported SASL mechanisms: ' + mechs.join(','));
          const nonce = crypto.randomBytes(18).toString('base64');
          scram = { nonce: nonce, bare: 'n=*,r=' + nonce };
          const first = Buffer.from('n,,' + scram.bare);
          this.sock.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), i32(first.length), first])));
          continue;
        }
        if (code === 11) {
          const server = m.body.toString('utf8', 4);
          const a = {}; server.split(',').forEach((kv) => { a[kv[0]] = kv.slice(2); });
          if (!a.r || !a.r.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
          const salted = crypto.pbkdf2Sync(c.password.normalize('NFKC'), Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
          const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const without = 'c=biws,r=' + a.r;
          const authMessage = scram.bare + ',' + server + ',' + without;
          const sig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
          const proof = Buffer.alloc(32); for (let i = 0; i < 32; i++) proof[i] = clientKey[i] ^ sig[i];
          const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
          scram.expected = crypto.createHmac('sha256', serverKey).update(authMessage).digest('base64');
          this.sock.write(msg('p', Buffer.from(without + ',p=' + proof.toString('base64'))));
          continue;
        }
        if (code === 12) {
          const v = m.body.toString('utf8', 4).replace(/^v=/, '');
          if (!scram || v !== scram.expected) throw new Error('SCRAM server signature mismatch');
          continue;
        }
        throw new Error('Unsupported auth method ' + code);
      }
      if (m.type === 'Z') return;
      // 'S' ParameterStatus, 'K' BackendKeyData, 'N' notices: ignore
    }
  }

  async query(sql, params) {
    params = params || [];
    const parts = [msg('P', Buffer.concat([cstr(''), cstr(sql), i16(0)]))];
    const vals = [i16(0), i16(params.length)];
    params.forEach((p) => { const b = toParam(p); if (b === null) vals.push(i32(-1)); else { vals.push(i32(b.length)); vals.push(b); } });
    vals.push(i16(0));
    parts.push(msg('B', Buffer.concat([cstr(''), cstr('')].concat(vals))));
    parts.push(msg('D', Buffer.concat([Buffer.from('P'), cstr('')])));
    parts.push(msg('E', Buffer.concat([cstr(''), i32(0)])));
    parts.push(msg('S', Buffer.alloc(0)));
    this.sock.write(Buffer.concat(parts));
    let fields = []; const rows = []; let error = null; let command = '';
    for (;;) {
      const m = await this.next();
      if (m.type === 'T') {
        const n = m.body.readInt16BE(0); let o = 2; fields = [];
        for (let i = 0; i < n; i++) {
          const end = m.body.indexOf(0, o); const name = m.body.toString('utf8', o, end); o = end + 1;
          const oid = m.body.readInt32BE(o + 6); o += 18;
          fields.push({ name: name, oid: oid });
        }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0); let o = 2; const row = {};
        for (let i = 0; i < n; i++) {
          const len = m.body.readInt32BE(o); o += 4;
          const v = len < 0 ? null : m.body.subarray(o, o + len); if (len > 0) o += len;
          row[fields[i].name] = fromText(v, fields[i].oid);
        }
        rows.push(row);
      } else if (m.type === 'C') {
        command = m.body.toString('utf8', 0, m.body.length - 1);
      } else if (m.type === 'E') {
        error = new PgError(Connection.errorFields(m.body));
      } else if (m.type === 'Z') {
        if (error) throw error;
        return { rows: rows, command: command, rowCount: rows.length };
      }
    }
  }

  end() { try { this.sock.write(msg('X', Buffer.alloc(0))); this.sock.end(); } catch (e) { /* ignore */ } }
}

class Client {
  constructor(url) { this.cfg = parseUrl(url); this.conn = null; this.queue = Promise.resolve(); }
  async connection() {
    if (this.conn && !this.conn.closed) return this.conn;
    const c = new Connection(this.cfg);
    await c.open();
    this.conn = c;
    return c;
  }
  // Serialize queries; retry once on a dropped connection.
  query(sql, params) {
    const run = async () => {
      try {
        return await (await this.connection()).query(sql, params);
      } catch (e) {
        if (e instanceof PgError) throw e;
        this.conn = null;
        return (await this.connection()).query(sql, params);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  end() { if (this.conn) this.conn.end(); this.conn = null; }
}

module.exports = { Client, PgError, parseUrl };
