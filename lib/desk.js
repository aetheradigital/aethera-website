'use strict';
/**
 * Aethera Desk: clients & prospects, projects & checklists, files & approvals, client reports.
 * Records live in Postgres (DATABASE_URL) or, when no database is configured, in memory (tests/dev only).
 */
const crypto = require('crypto');
const { Client } = require('./pg');
const health = require('./health');

const SERVICES = ['Brand Development & Design', 'Website Development & Refinement', 'SEO & AI Search Visibility', 'Advertising & Funnels',
  'Content, Social & Video', 'CRM & Back Office', 'Portals & Dashboards', 'Reporting & Strategy'];
const CLIENT_STATUS = ['lead', 'prospect', 'proposal', 'active', 'paused', 'past'];
const PROJECT_STATUS = ['planned', 'in_progress', 'review', 'done', 'on_hold'];
const APPROVAL_STATUS = ['pending', 'approved', 'changes', 'declined'];
const APPROVAL_KIND = ['approval', 'decision', 'access'];
const FILE_CATEGORY = ['brand', 'access', 'contract', 'deliverable', 'report', 'other'];
const SUGGESTION_STATUS = ['new', 'added', 'dismissed'];
const SOURCE_KIND = ['email', 'meeting', 'calendar'];
const TASK_SOURCE = ['health', 'email', 'meeting', 'calendar', 'checklist'];
const METRICS = ['seo_clicks', 'seo_impressions', 'seo_avg_position', 'sessions', 'leads', 'ad_spend', 'ad_clicks', 'ad_conversions',
  'social_followers', 'social_engagement', 'revenue', 'health_score', 'seo_score', 'aiso_score'];
// draft: created (automatically or by hand), still being filled in; ready: reviewed; sent: shared with the client.
const REPORT_STATUS = ['draft', 'ready', 'sent'];

// Report sections and the services that make each one relevant. "Website & Leads" applies to every client.
const METRIC_GROUPS = [
  { key: 'search', label: 'Search', metrics: ['seo_clicks', 'seo_impressions', 'seo_avg_position'], services: ['SEO & AI Search Visibility', 'Website Development & Refinement'] },
  { key: 'site', label: 'Website & Leads', metrics: ['sessions', 'leads', 'revenue'], services: null },
  { key: 'ads', label: 'Advertising', metrics: ['ad_spend', 'ad_clicks', 'ad_conversions'], services: ['Advertising & Funnels'] },
  { key: 'social', label: 'Social', metrics: ['social_followers', 'social_engagement'], services: ['Content, Social & Video'] },
  { key: 'health', label: 'Digital Health', metrics: ['health_score', 'seo_score', 'aiso_score'], services: ['SEO & AI Search Visibility', 'Website Development & Refinement'] }
];
// Clients on Reporting & Strategy (or with no services recorded) see every section.
function reportGroupsFor(services) {
  const s = Array.isArray(services) ? services : [];
  if (!s.length || s.includes('Reporting & Strategy')) return METRIC_GROUPS.map((g) => g.key);
  return METRIC_GROUPS.filter((g) => !g.services || g.services.some((x) => s.includes(x))).map((g) => g.key);
}
// Today's date (YYYY-MM-DD) in the business's time zone, so months roll over at local midnight.
const TIME_ZONE = process.env.DESK_TIMEZONE || 'America/New_York';
function localDate(now) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now ? new Date(now) : new Date()); }
  catch (e) { return (now ? new Date(now) : new Date()).toISOString().slice(0, 10); }
}
// The month a report covers by default: the last full calendar month (YYYY-MM).
function lastFullMonth(now) { return prevMonth(localDate(now).slice(0, 7), 1); }
function prevMonth(period, back) {
  const [y, m] = period.split('-').map(Number); const n = y * 12 + (m - 1) - (back || 1);
  return Math.floor(n / 12) + '-' + String((n % 12) + 1).padStart(2, '0');
}

const TEMPLATES = {
  onboarding: { label: 'Client Onboarding & Access', tasks: ['Signed agreement received', 'First invoice paid', 'Kickoff call held', 'Point of contact and approval process confirmed', 'Brand assets received (logo, fonts, colors, photos)', 'Website / domain / hosting access', 'Google Analytics & Search Console access', 'Google Business Profile access', 'Ad account access', 'Social account access', 'CRM / email platform access'] },
  website: { label: 'Website Build', tasks: ['Discovery & sitemap', 'Copy collected', 'Wireframes', 'Design approved', 'Build pages', 'Forms & integrations', 'SEO basics (titles, meta, schema)', 'Mobile & speed check', 'Analytics installed', 'Client review', 'Launch & DNS', 'Post-launch check'] },
  seo: { label: 'SEO & AI Search', tasks: ['Search Console & GA4 access', 'Technical audit', 'Keyword research', 'Google Business Profile optimized', 'On-page updates', 'AI search visibility (answer-ready pages, schema)', 'Content plan', 'Citations & listings', 'Monthly rankings & traffic report'] },
  ads: { label: 'Advertising & Funnels', tasks: ['Ad account access', 'Goals & budget agreed', 'Conversion tracking set up', 'Audiences & keywords', 'Ad copy & creative', 'Landing page ready', 'Campaign launched', 'Week-one optimization', 'Monthly performance report'] },
  branding: { label: 'Brand Development', tasks: ['Discovery questionnaire', 'Positioning & messaging', 'Mood board', 'Logo concepts', 'Revisions', 'Color & type system', 'Brand guide delivered', 'Final asset files delivered'] },
  social: { label: 'Content & Social', tasks: ['Account access', 'Content pillars', 'Monthly calendar', 'Content created', 'Client approval', 'Posts scheduled', 'Engagement check', 'Monthly social report'] }
};

// Field rules per record type. s=string(max), e=enum, n=number, b=bool, d=date YYYY-MM-DD, m=month YYYY-MM, a=array of enum, o=metrics object,
// f=cleaned by a function (returns { value } or { error })
const SCHEMA = {
  client: { parent: null, required: ['name'], fields: {
    name: ['s', 120], company: ['s', 120], email: ['s', 200], phone: ['s', 40], website: ['s', 200], status: ['e', CLIENT_STATUS],
    services: ['a', SERVICES], monthly_value: ['n'], source: ['s', 120], next_step: ['s', 300], next_date: ['d'], notes: ['s', 10000],
    aliases: ['s', 500], gsc_site: ['s', 200], ga4_property: ['s', 40] } },
  project: { parent: 'client', required: ['client_id', 'name'], fields: {
    client_id: ['id'], name: ['s', 160], status: ['e', PROJECT_STATUS], owner: ['s', 80], start: ['d'], due: ['d'], description: ['s', 5000], hidden: ['b'] } },
  task: { parent: 'project', required: ['project_id', 'title'], fields: {
    project_id: ['id'], title: ['s', 300], done: ['b'], done_at: ['d'], owner: ['s', 80], due: ['d'], position: ['n'], source: ['e', TASK_SOURCE] } },
  approval: { parent: 'client', required: ['client_id', 'title'], fields: {
    client_id: ['id'], title: ['s', 200], kind: ['e', APPROVAL_KIND], status: ['e', APPROVAL_STATUS], requested: ['d'], decided: ['d'], decided_by: ['s', 120], notes: ['s', 3000],
    file_id: ['s', 60], client_comment: ['s', 3000] } },
  suggestion: { parent: 'client', required: ['client_id', 'title'], fields: {
    client_id: ['id'], title: ['s', 300], due: ['d'], owner: ['s', 80], status: ['e', SUGGESTION_STATUS], source: ['e', SOURCE_KIND],
    source_url: ['s', 500], source_title: ['s', 300], source_date: ['s', 40], source_key: ['s', 300], evidence: ['s', 400], collected_by: ['s', 200], task_id: ['s', 60] } },
  lead: { parent: null, required: ['name'], fields: {
    name: ['s', 120], company: ['s', 120], email: ['s', 200], phone: ['s', 40], website: ['s', 200], services: ['a', SERVICES],
    summary: ['s', 2000], next_step: ['s', 300], status: ['e', SUGGESTION_STATUS], source: ['e', SOURCE_KIND], source_url: ['s', 500],
    source_title: ['s', 300], source_date: ['s', 40], source_key: ['s', 300], evidence: ['s', 400], collected_by: ['s', 200], client_id: ['s', 60] } },
  report: { parent: 'client', required: ['client_id', 'period'], fields: {
    client_id: ['id'], period: ['m'], metrics: ['o', METRICS], summary: ['s', 5000], wins: ['s', 3000], next_actions: ['s', 3000],
    status: ['e', REPORT_STATUS], created_by: ['e', ['auto', 'manual']], sent_at: ['d'] } },
  // Digital Health asset: a page or profile scored for SEO and AI search. client_id is optional (Aethera's own assets).
  // checks/prompts/tasks/scan/history/score/review are cleaned by lib/health.js; score is computed in the browser.
  asset: { parent: 'client', optional_parent: true, required: ['name', 'type'], fields: {
    client_id: ['id'], name: ['s', 160], url: ['s', 500], type: ['e', health.TYPES], status: ['e', health.ASSET_STATUS], notes: ['s', 2000],
    checks: ['f', health.fields.checks], prompts: ['f', health.fields.prompts], tasks: ['f', health.fields.tasks], scan: ['f', health.fields.scan],
    history: ['f', health.fields.history], score: ['f', health.fields.score], review: ['f', health.fields.review] } }
  // Server-only fields (never accepted from forms): client.portal_access (set from the Client Portal panel); report.sources = { metric: 'gsc' | 'ga4' } for numbers pulled
  // automatically; client.report_sync = { gsc|ga4: { at, period, ok, message } } for the last pull.
};
const PLURAL = { clients: 'client', projects: 'project', tasks: 'task', approvals: 'approval', reports: 'report', suggestions: 'suggestion', leads: 'lead', assets: 'asset' };

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
      case 'f': { const r = rule[1](v); if (r.error) return { error: r.error }; v = r.value; break; }
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

const FILE_COLS = 'id, client_id, name, mime, size, category, created_at, r2_key, shared, uploaded_by';
function newFileId() { return newId('file'); }

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
    // Client portal: files can live in Cloudflare R2 (r2_key) instead of the database, and are hidden from the client until shared.
    await this.db.query('alter table desk_files add column if not exists r2_key text');
    await this.db.query('alter table desk_files add column if not exists shared boolean not null default false');
    await this.db.query("alter table desk_files add column if not exists uploaded_by text not null default 'aethera'");
    await this.db.query('alter table desk_files alter column content drop not null');
    await this.db.query('create table if not exists desk_seen (key text primary key, seen_at timestamptz not null default now())');
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
  async relink(type, id, clientId) {
    // Removing the client drops the key; jsonb_set with a SQL null would null the whole document.
    const r = await this.db.query('update desk_records set client_id = $3::text, data = case when $3::text is null then data - \'client_id\' ' +
      'else jsonb_set(data, \'{client_id}\', to_jsonb($3::text)) end, updated_at = now() where type = $1 and id = $2 returning *', [type, id, clientId || null]);
    return r.rows[0] ? flatten(r.rows[0]) : null;
  }
  async reparent(type, id, projectId) {
    const r = await this.db.query('update desk_records set project_id = $3::text, data = jsonb_set(data, \'{project_id}\', to_jsonb($3::text)), updated_at = now() ' +
      'where type = $1 and id = $2 returning *', [type, id, projectId]);
    return r.rows[0] ? flatten(r.rows[0]) : null;
  }
  async counts() {
    const r = await this.db.query('select type, count(*)::int as n from desk_records group by type');
    const o = {}; r.rows.forEach((x) => { o[x.type] = x.n; }); return o;
  }
  async allOf(type) { return (await this.db.query('select * from desk_records where type = $1', [type])).rows.map(flatten); }
  async seen(key) { return (await this.db.query('select 1 from desk_seen where key = $1', [key])).rows.length > 0; }
  async markSeen(key) { await this.db.query('insert into desk_seen (key) values ($1) on conflict do nothing', [key]); }
  // f: { id?, client_id, name, mime, category, size, content (Buffer) or r2_key, shared, uploaded_by }
  async putFile(f) {
    const id = f.id || newId('file');
    const r = await this.db.query('insert into desk_files (id, client_id, name, mime, size, category, content, r2_key, shared, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ' + FILE_COLS,
      [id, f.client_id, f.name, f.mime, f.size, f.category, f.r2_key ? null : f.content, f.r2_key || null, Boolean(f.shared), f.uploaded_by || 'aethera']);
    return r.rows[0];
  }
  async listFiles(clientId) {
    return (await this.db.query('select ' + FILE_COLS + ' from desk_files where client_id = $1 order by created_at desc', [clientId])).rows;
  }
  async getFileMeta(id) { return (await this.db.query('select ' + FILE_COLS + ' from desk_files where id = $1', [id])).rows[0] || null; }
  async getFile(id) { return (await this.db.query('select * from desk_files where id = $1', [id])).rows[0] || null; }
  async setFileShared(id, shared) { return (await this.db.query('update desk_files set shared = $2 where id = $1 returning ' + FILE_COLS, [id, Boolean(shared)])).rows[0] || null; }
  async removeFile(id) { await this.db.query('delete from desk_files where id = $1', [id]); }
  async r2KeysFor(clientId) { return (await this.db.query('select r2_key from desk_files where client_id = $1 and r2_key is not null', [clientId])).rows.map((x) => x.r2_key); }
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
  async relink(type, id, clientId) {
    const r = this.rows.get(id); if (!r || r.type !== type) return null;
    r.client_id = clientId; r.data = Object.assign({}, r.data, { client_id: clientId }); r.updated_at = new Date().toISOString(); return flatten(r);
  }
  async reparent(type, id, projectId) {
    const r = this.rows.get(id); if (!r || r.type !== type) return null;
    r.project_id = projectId; r.data = Object.assign({}, r.data, { project_id: projectId }); r.updated_at = new Date().toISOString(); return flatten(r);
  }
  async counts() { const o = {}; for (const r of this.rows.values()) o[r.type] = (o[r.type] || 0) + 1; return o; }
  async allOf(type) { return this.list(type); }
  async seen(key) { return !!(this.seenKeys && this.seenKeys.has(key)); }
  async markSeen(key) { (this.seenKeys = this.seenKeys || new Set()).add(key); }
  async putFile(f) {
    const rec = { id: f.id || newId('file'), client_id: f.client_id, name: f.name, mime: f.mime, size: f.size, category: f.category, content: f.r2_key ? null : f.content,
      r2_key: f.r2_key || null, shared: Boolean(f.shared), uploaded_by: f.uploaded_by || 'aethera', created_at: new Date(Date.now() + this.files.size).toISOString() };
    this.files.set(rec.id, rec); const copy = Object.assign({}, rec); delete copy.content; return copy;
  }
  async listFiles(clientId) {
    return [...this.files.values()].filter((f) => f.client_id === clientId).map((f) => { const c = Object.assign({}, f); delete c.content; return c; }).reverse();
  }
  async getFileMeta(id) { const f = this.files.get(id); if (!f) return null; const c = Object.assign({}, f); delete c.content; return c; }
  async getFile(id) { return this.files.get(id) || null; }
  async setFileShared(id, shared) { const f = this.files.get(id); if (!f) return null; f.shared = Boolean(shared); return this.getFileMeta(id); }
  async removeFile(id) { this.files.delete(id); }
  async r2KeysFor(clientId) { return [...this.files.values()].filter((f) => f.client_id === clientId && f.r2_key).map((f) => f.r2_key); }
}

function createStore(url) { return url ? new PgStore(url) : new MemoryStore(); }

module.exports = { TASK_SOURCE, createStore, newFileId, validate, SCHEMA, PLURAL, TEMPLATES, SERVICES, CLIENT_STATUS, PROJECT_STATUS, APPROVAL_STATUS, APPROVAL_KIND, FILE_CATEGORY, METRICS, SUGGESTION_STATUS,
  REPORT_STATUS, METRIC_GROUPS, reportGroupsFor, lastFullMonth, prevMonth, localDate };
