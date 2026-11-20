'use strict';
/**
 * Client portal (client.aetheradigital.com): one-time sign-in links, sessions and the audit log.
 * Tokens and session ids are random; only their SHA-256 hashes are stored.
 * The audit log is append-only: the code never updates or deletes it, and Postgres rules ignore UPDATE/DELETE.
 */
const crypto = require('crypto');

const LINK_TTL_MS = 15 * 60 * 1000;            // sign-in links: 15 minutes, single use
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;  // sessions: 30 days
const CATEGORIES = ['signin', 'security', 'file', 'approval', 'report', 'quote', 'billing', 'account'];

function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('base64url'); }

// "Chrome · macOS" from a user agent: coarse on purpose (enough to spot a new device, nothing more).
function deviceOf(ua) {
  ua = String(ua || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  return browser + ' · ' + os;
}

class PgPortal {
  constructor(db) { this.db = db; }
  async init() {
    const q = (s) => this.db.query(s);
    await q(`create table if not exists portal_tokens (hash text primary key, client_id text not null, email text not null,
      created_at timestamptz not null default now(), expires_at timestamptz not null, used_at timestamptz, ip text)`);
    await q(`create table if not exists portal_sessions (hash text primary key, client_id text not null, device text, ip text,
      created_at timestamptz not null default now(), expires_at timestamptz not null, last_seen timestamptz not null default now(), revoked_at timestamptz)`);
    await q('create index if not exists portal_sessions_client on portal_sessions (client_id)');
    await q(`create table if not exists portal_audit (id bigserial primary key, at timestamptz not null default now(), client_id text,
      actor_type text not null, actor text, category text not null, event text not null, detail text, ip text, device text,
      flagged boolean not null default false)`);
    await q('create index if not exists portal_audit_client_at on portal_audit (client_id, at desc)');
    await q('create or replace rule portal_audit_no_update as on update to portal_audit do instead nothing');
    await q('create or replace rule portal_audit_no_delete as on delete to portal_audit do instead nothing');
    await q("delete from portal_tokens where expires_at < now() - interval '7 days'");
  }
  async addToken(t) {
    await this.db.query('insert into portal_tokens (hash, client_id, email, expires_at, ip) values ($1,$2,$3,$4,$5)',
      [t.hash, t.client_id, t.email, new Date(t.expires_at), t.ip || null]);
  }
  async recentTokens(clientId, sinceMs) {
    const r = await this.db.query('select count(*)::int as n from portal_tokens where client_id = $1 and created_at > $2', [clientId, new Date(Date.now() - sinceMs)]);
    return r.rows[0].n;
  }
  // Marks the token used and returns it, or returns the row with a reason when it can't be used.
  async useToken(h) {
    const r = await this.db.query('update portal_tokens set used_at = now() where hash = $1 and used_at is null and expires_at > now() returning *', [h]);
    if (r.rows[0]) return { ok: true, row: r.rows[0] };
    const old = (await this.db.query('select * from portal_tokens where hash = $1', [h])).rows[0];
    return { ok: false, row: old || null, reason: !old ? 'unknown' : old.used_at ? 'used' : 'expired' };
  }
  async addSession(s) {
    await this.db.query('insert into portal_sessions (hash, client_id, device, ip, expires_at) values ($1,$2,$3,$4,$5)',
      [s.hash, s.client_id, s.device, s.ip || null, new Date(s.expires_at)]);
  }
  async getSession(h) {
    return (await this.db.query('select * from portal_sessions where hash = $1 and revoked_at is null and expires_at > now()', [h])).rows[0] || null;
  }
  async touchSession(h) { await this.db.query('update portal_sessions set last_seen = now() where hash = $1', [h]); }
  async endSession(h) { await this.db.query('update portal_sessions set revoked_at = now() where hash = $1', [h]); }
  async endAllSessions(clientId) {
    const r = await this.db.query('update portal_sessions set revoked_at = now() where client_id = $1 and revoked_at is null and expires_at > now() returning hash', [clientId]);
    return r.rows.length;
  }
  async sessionInfo(clientId) {
    const r = await this.db.query('select device, created_at, last_seen from portal_sessions where client_id = $1 and revoked_at is null and expires_at > now() order by last_seen desc', [clientId]);
    return r.rows;
  }
  async knownDevice(clientId, device) {
    const r = await this.db.query('select (count(*) filter (where device = $2))::int as same, count(*)::int as total from portal_sessions where client_id = $1', [clientId, device]);
    return { same: r.rows[0].same, total: r.rows[0].total };
  }
  async log(e) {
    await this.db.query('insert into portal_audit (client_id, actor_type, actor, category, event, detail, ip, device, flagged) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.client_id || null, e.actor_type, e.actor || null, e.category, e.event, e.detail || null, e.ip || null, e.device || null, Boolean(e.flagged)]);
  }
  async audit(f) {
    const cond = []; const p = [];
    if (f.client_id) { p.push(f.client_id); cond.push('client_id = $' + p.length); }
    if (f.category) { p.push(f.category); cond.push('category = $' + p.length); }
    if (f.flagged) cond.push('flagged');
    if (f.q) { p.push('%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'); cond.push("(event || ' ' || coalesce(detail, '')) ilike $" + p.length); }
    p.push(Math.min(Number(f.limit) || 200, 5000));
    const r = await this.db.query('select * from portal_audit' + (cond.length ? ' where ' + cond.join(' and ') : '') + ' order by at desc, id desc limit $' + p.length, p);
    return r.rows;
  }
  async lastSignIn(clientId) {
    const r = await this.db.query("select at, device from portal_audit where client_id = $1 and category = 'signin' and event = 'Signed in' order by at desc limit 1", [clientId]);
    return r.rows[0] || null;
  }
}

class MemoryPortal {
  constructor() { this.tokens = new Map(); this.sessions = new Map(); this.events = []; this.seq = 0; }
  async init() {}
  async addToken(t) { this.tokens.set(t.hash, Object.assign({ created_at: new Date().toISOString(), used_at: null }, t)); }
  async recentTokens(clientId, sinceMs) {
    const since = Date.now() - sinceMs; let n = 0;
    for (const t of this.tokens.values()) if (t.client_id === clientId && Date.parse(t.created_at) > since) n++;
    return n;
  }
  async useToken(h) {
    const t = this.tokens.get(h);
    if (!t) return { ok: false, row: null, reason: 'unknown' };
    if (t.used_at) return { ok: false, row: t, reason: 'used' };
    if (t.expires_at <= Date.now()) return { ok: false, row: t, reason: 'expired' };
    t.used_at = new Date().toISOString(); return { ok: true, row: t };
  }
  async addSession(s) { this.sessions.set(s.hash, Object.assign({ created_at: new Date().toISOString(), last_seen: new Date().toISOString(), revoked_at: null }, s)); }
  async getSession(h) { const s = this.sessions.get(h); return s && !s.revoked_at && s.expires_at > Date.now() ? s : null; }
  async touchSession(h) { const s = this.sessions.get(h); if (s) s.last_seen = new Date().toISOString(); }
  async endSession(h) { const s = this.sessions.get(h); if (s) s.revoked_at = new Date().toISOString(); }
  async endAllSessions(clientId) {
    let n = 0; for (const s of this.sessions.values()) if (s.client_id === clientId && !s.revoked_at && s.expires_at > Date.now()) { s.revoked_at = new Date().toISOString(); n++; }
    return n;
  }
  async sessionInfo(clientId) {
    return [...this.sessions.values()].filter((s) => s.client_id === clientId && !s.revoked_at && s.expires_at > Date.now())
      .map((s) => ({ device: s.device, created_at: s.created_at, last_seen: s.last_seen }));
  }
  async knownDevice(clientId, device) {
    const all = [...this.sessions.values()].filter((s) => s.client_id === clientId);
    return { same: all.filter((s) => s.device === device).length, total: all.length };
  }
  async log(e) {
    this.events.push(Object.assign({ id: ++this.seq, at: new Date(Date.now() + this.seq).toISOString(), flagged: false }, e, { flagged: Boolean(e.flagged) }));
  }
  async audit(f) {
    const q = (f.q || '').toLowerCase();
    return this.events.filter((e) => (!f.client_id || e.client_id === f.client_id) && (!f.category || e.category === f.category) && (!f.flagged || e.flagged) &&
      (!q || (e.event + ' ' + (e.detail || '')).toLowerCase().includes(q))).slice().reverse().slice(0, Math.min(Number(f.limit) || 200, 5000));
  }
  async lastSignIn(clientId) {
    const e = this.events.slice().reverse().find((x) => x.client_id === clientId && x.category === 'signin' && x.event === 'Signed in');
    return e ? { at: e.at, device: e.device } : null;
  }
}

function createPortalStore(desk) { return desk.kind === 'postgres' ? new PgPortal(desk.db) : new MemoryPortal(); }

module.exports = { createPortalStore, deviceOf, hash, token, LINK_TTL_MS, SESSION_TTL_MS, CATEGORIES };
