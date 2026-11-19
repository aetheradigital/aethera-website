'use strict';
/**
 * Aethera Desk: clients & prospects, projects & checklists, files & approvals, client reports.
 * Records live in Postgres (DATABASE_URL) or, when no database is configured, in memory (tests/dev only).
 */
const crypto = require('crypto');
const { Client } = require('./pg');

const SERVICES = ['Brand Development & Design', 'Website Development & Refinement', 'SEO & AI Search Visibility', 'Advertising & Funnels',
  'Content, Social & Video', 'CRM & Back Office', 'Portals & Dashboards', 'Reporting & Strategy'];
const CLIENT_STATUS = ['lead', 'prospect', 'proposal', 'active', 'paused', 'past'];
const PROJECT_STATUS = ['planned', 'in_progress', 'review', 'done', 'on_hold'];
const APPROVAL_STATUS = ['pending', 'approved', 'changes', 'declined'];
const APPROVAL_KIND = ['approval', 'decision', 'access'];
const FILE_CATEGORY = ['brand', 'access', 'contract', 'deliverable', 'report', 'other'];
const METRICS = ['seo_clicks', 'seo_impressions', 'seo_avg_position', 'sessions', 'leads', 'ad_spend', 'ad_clicks', 'ad_conversions',
  'social_followers', 'social_engagement', 'revenue'];

const TEMPLATES = {
  onboarding: { label: 'Client onboarding & access', tasks: ['Signed agreement received', 'First invoice paid', 'Kickoff call held', 'Point of contact and approval process confirmed', 'Brand assets received (logo, fonts, colors, photos)', 'Website / domain / hosting access', 'Google Analytics & Search Console access', 'Google Business Profile access', 'Ad account access', 'Social account access', 'CRM / email platform access'] },
  website: { label: 'Website build', tasks: ['Discovery & sitemap', 'Copy collected', 'Wireframes', 'Design approved', 'Build pages', 'Forms & integrations', 'SEO basics (titles, meta, schema)', 'Mobile & speed check', 'Analytics installed', 'Client review', 'Launch & DNS', 'Post-launch check'] },
  seo: { label: 'SEO & AI search', tasks: ['Search Console & GA4 access', 'Technical audit', 'Keyword research', 'Google Business Profile optimized', 'On-page updates', 'AI search visibility (answer-ready pages, schema)', 'Content plan', 'Citations & listings', 'Monthly rankings & traffic report'] },
  ads: { label: 'Advertising & funnels', tasks: ['Ad account access', 'Goals & budget agreed', 'Conversion tracking set up', 'Audiences & keywords', 'Ad copy & creative', 'Landing page ready', 'Campaign launched', 'Week-one optimization', 'Monthly performance report'] },
  branding: { label: 'Brand development', tasks: ['Discovery questionnaire', 'Positioning & messaging', 'Mood board', 'Logo concepts', 'Revisions', 'Color & type system', 'Brand guide delivered', 'Final asset files delivered'] },
  social: { label: 'Content & social', tasks: ['Account access', 'Content pillars', 'Monthly calendar', 'Content created', 'Client approval', 'Posts scheduled', 'Engagement check', 'Monthly social report'] }
};

// Field rules per record type. s=string(max), e=enum, n=number, b=bool, d=date YYYY-MM-DD, m=month YYYY-MM, a=array of enum, o=metrics object
const SCHEMA = {
  client: { parent: null, required: ['name'], fields: {
    name: ['s', 120], company: ['s', 120], email: ['s', 200], phone: ['s', 40], website: ['s', 200], status: ['e', CLIENT_STATUS],
    services: ['a', SERVICES], monthly_value: ['n'], source: ['s', 120], next_step: ['s', 300], next_date: ['d'], notes: ['s', 10000] } },
  project: { parent: 'client', required: ['client_id', 'name'], fields: {
    client_id: ['id'], name: ['s', 160], status: ['e', PROJECT_STATUS], owner: ['s', 80], start: ['d'], due: ['d'], description: ['s', 5000] } },
  task: { parent: 'project', required: ['project_id', 'title'], fields: {
    project_id: ['id'], title: ['s', 300], done: ['b'], owner: ['s', 80], due: ['d'], position: ['n'] } },
  approval: { parent: 'client', required: ['client_id', 'title'], fields: {
    client_id: ['id'], title: ['s', 200], kind: ['e', APPROVAL_KIND], status: ['e', APPROVAL_STATUS], requested: ['d'], decided: ['d'], decided_by: ['s', 120], notes: ['s', 3000] } },
  report: { parent: 'client', required: ['client_id', 'period'], fields: {
    client_id: ['id'], period: ['m'], metrics: ['o', METRICS], summary: ['s', 5000], wins: ['s', 3000], next_actions: ['s', 3000] } }
};
const PLURAL = { clients: 'client', projects: 'project', tasks: 'task', approvals: 'approval', reports: 'report' };

function newId(type) { return type.slice(0, 3) + '_' + crypto.randomBytes(9).toString('base64url'); }

function validate(type, input, partial) {
  const sch = SCHEMA[type]; const out = {};
  if (!input || typeof input !== 'object') return { error: 'Invalid request.' };
  for (const k of Object.keys(input)) {
    const rule = sch.fields[k]; if (!rule) continue;
    let v = input[k];
    if (v === null || v === '') { out[k] = rule[0] === 'a' ? [] : rule[0] === 'b' ? false : null; continue; }
    switch (rule[0]) {
      case 's': v = String(v).trim().slice(0, rule[1]); break;
      case 'id': if (!/^[a-z]{3}_[A-Za-z0-9_-]{6,40}$/.test(String(v))) return { error: 'Invalid ' + k + '.' }; v = String(v); break;
      case 'e': if (rule[1].indexOf(v) < 0) return { error: 'Invalid ' + k + '.' }; break;
      case 'n': v = Number(String(v).replace(/[$,\s]/g, '')); if (!Number.isFinite(v)) return { error: k + ' must be a number.' }; break;
      case 'b': v = v === true || v === 'true'; break;
      case 'd': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: k + ' must be a date.' }; break;
      case 'm': if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return { error: 'Choose a month.' }; break;
      case 'a': if (!Array.isArray(v) || v.some((x) => rule[1].indexOf(x) < 0)) return { error: 'Invalid ' + k + '.' }; break;
      case 'o': {
        if (typeof v !== 'object' || Array.isArray(v)) return { error: 'Invalid ' + k + '.' };
        const o = {};
        for (const mk of rule[1]) {
          if (v[mk] === undefined || v[mk] === null || v[mk] === '') continue;
          const n = Number(String(v[mk]).replace(/[$,\s]/g, ''));
          if (!Number.isFinite(n)) return { error: mk.replace(/_/g, ' ') + ' must be a number.' };
          o[mk] = n;
        }
        v = o; break;
      }
    }
    out[k] = v;
  }
  if (!partial) for (const r of sch.required) if (out[r] === undefined || out[r] === null || out[r] === '') return { error: 'Enter ' + r.replace('_id', '').replace('_', ' ') + '.' };
  if (partial) for (const r of sch.required) if (r in out && (out[r] === null || out[r] === '')) return { error: 'Enter ' + r.replace('_', ' ') + '.' };
  return { data: out };
}

// ---------- stores ----------
function flatten(row) {
  return Object.assign({}, row.data, { id: row.id, client_id: row.client_id || row.data.client_id || null, project_id: row.project_id || row.data.project_id || null, created_at: row.created_at, updated_at: row.updated_at });
}

class PgStore {
  constructor(url) { this.db = new Client(url); this.kind = 'postgres'; }
  async init() {
    await this.db.query(`create table if not exists desk_records (
      id text primary key, type text not null, client_id text, project_id text,
      data jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    await this.db.query('create index if not exists desk_records_type_client on desk_records (type, client_id)');
    await this.db.query('create index if not exists desk_records_project on desk_records (project_id)');
    await this.db.query(`create table if not exists desk_files (
      id text primary key, client_id text, name text not null, mime text, size integer, category text,
      content bytea not null, created_at timestamptz not null default now())`);
    await this.db.query('create index if not exists desk_files_client on desk_files (client_id)');
  }
  async list(type, where) {
    const cond = ['type = $1']; const p = [type];
    if (where && where.client_id) { p.push(where.client_id); cond.push('client_id = $' + p.length); }
    if (where && where.project_id) { p.push(where.project_id); cond.push('project_id = $' + p.length); }
    const r = await this.db.query('select * from desk_records where ' + cond.join(' and ') + ' order by created_at', p);
    return r.rows.map(flatten);
  }
  async get(type, id) {
    const r = await this.db.query('select * from desk_records where type = $1 and id = $2', [type, id]);
    return r.rows[0] ? flatten(r.rows[0]) : null;
  }
  async create(type, data, links) {
    const id = newId(type);
    const r = await this.db.query('insert into desk_records (id, type, client_id, project_id, data) values ($1,$2,$3,$4,$5) returning *',
      [id, type, links.client_id || null, links.project_id || null, data]);
    return flatten(r.rows[0]);
  }
  async update(type, id, data) {
    const r = await this.db.query('update desk_records set data = data || $3::jsonb, updated_at = now() where type = $1 and id = $2 returning *', [type, id, data]);
    return r.rows[0] ? flatten(r.rows[0]) : null;
  }
  async remove(type, id) {
    if (type === 'client') {
      await this.db.query('delete from desk_files where client_id = $1', [id]);
      await this.db.query('delete from desk_records where client_id = $1 or id = $1', [id]);
    } else if (type === 'project') {
      await this.db.query('delete from desk_records where project_id = $1 or id = $1', [id]);
    } else {
      await this.db.query('delete from desk_records where type = $1 and id = $2', [type, id]);
    }
  }
  async counts() {
    const r = await this.db.query('select type, count(*)::int as n from desk_records group by type');
    const o = {}; r.rows.forEach((x) => { o[x.type] = x.n; }); return o;
  }
  async allOf(type) { return (await this.db.query('select * from desk_records where type = $1', [type])).rows.map(flatten); }
  async putFile(f) {
    const id = newId('file');
    await this.db.query('insert into desk_files (id, client_id, name, mime, size, category, content) values ($1,$2,$3,$4,$5,$6,$7)',
      [id, f.client_id, f.name, f.mime, f.content.length, f.category, f.content]);
    return { id: id, client_id: f.client_id, name: f.name, mime: f.mime, size: f.content.length, category: f.category, created_at: new Date().toISOString() };
  }
  async listFiles(clientId) {
    return (await this.db.query('select id, client_id, name, mime, size, category, created_at from desk_files where client_id = $1 order by created_at desc', [clientId])).rows;
  }
  async getFile(id) { return (await this.db.query('select * from desk_files where id = $1', [id])).rows[0] || null; }
  async removeFile(id) { await this.db.query('delete from desk_files where id = $1', [id]); }
}

class MemoryStore {
  constructor() { this.rows = new Map(); this.files = new Map(); this.kind = 'memory'; }
  async init() {}
  async list(type, where) {
    return [...this.rows.values()].filter((r) => r.type === type && (!where || ((!where.client_id || r.client_id === where.client_id) && (!where.project_id || r.project_id === where.project_id)))).map(flatten);
  }
  async get(type, id) { const r = this.rows.get(id); return r && r.type === type ? flatten(r) : null; }
  async create(type, data, links) {
    const now = new Date().toISOString();
    const r = { id: newId(type), type: type, client_id: links.client_id || null, project_id: links.project_id || null, data: data, created_at: now, updated_at: now };
    this.rows.set(r.id, r); return flatten(r);
  }
  async update(type, id, data) {
    const r = this.rows.get(id); if (!r || r.type !== type) return null;
    r.data = Object.assign({}, r.data, data); r.updated_at = new Date().toISOString(); return flatten(r);
  }
  async remove(type, id) {
    for (const [k, r] of this.rows) if (k === id || (type === 'client' && r.client_id === id) || (type === 'project' && r.project_id === id)) this.rows.delete(k);
    if (type === 'client') for (const [k, f] of this.files) if (f.client_id === id) this.files.delete(k);
  }
  async counts() { const o = {}; for (const r of this.rows.values()) o[r.type] = (o[r.type] || 0) + 1; return o; }
  async allOf(type) { return this.list(type); }
  async putFile(f) {
    const rec = { id: newId('file'), client_id: f.client_id, name: f.name, mime: f.mime, size: f.content.length, category: f.category, content: f.content, created_at: new Date().toISOString() };
    this.files.set(rec.id, rec); const copy = Object.assign({}, rec); delete copy.content; return copy;
  }
  async listFiles(clientId) {
    return [...this.files.values()].filter((f) => f.client_id === clientId).map((f) => { const c = Object.assign({}, f); delete c.content; return c; }).reverse();
  }
  async getFile(id) { return this.files.get(id) || null; }
  async removeFile(id) { this.files.delete(id); }
}

function createStore(url) { return url ? new PgStore(url) : new MemoryStore(); }

module.exports = { createStore, validate, SCHEMA, PLURAL, TEMPLATES, SERVICES, CLIENT_STATUS, PROJECT_STATUS, APPROVAL_STATUS, APPROVAL_KIND, FILE_CATEGORY, METRICS };
