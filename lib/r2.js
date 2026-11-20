'use strict';
/**
 * Cloudflare R2 file storage (S3-compatible API, AWS Signature Version 4). No dependencies.
 * Files are private: the server uploads them, and downloads go through short-lived presigned links.
 *
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   (all four turn R2 on)
 *   R2_ENDPOINT   optional override (tests), e.g. http://127.0.0.1:9000
 */
const crypto = require('crypto');

function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
// RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone).
function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
function encPath(p) { return p.split('/').map(enc).join('/'); }
function amzDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
}
function canonicalQuery(q) {
  return Object.keys(q).sort().map(function (k) { return enc(k) + '=' + enc(String(q[k])); }).join('&');
}

/**
 * Presigned GET URL. o: { protocol, host, path, region, service, accessKeyId, secret, date, expires, query }
 * (exported for the AWS reference test).
 */
function presign(o) {
  const date = o.date || new Date();
  const stamp = amzDate(date); const day = stamp.slice(0, 8);
  const region = o.region || 'auto'; const service = o.service || 's3';
  const scope = day + '/' + region + '/' + service + '/aws4_request';
  const q = Object.assign({}, o.query || {}, {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': o.accessKeyId + '/' + scope,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(o.expires || 600),
    'X-Amz-SignedHeaders': 'host'
  });
  const cq = canonicalQuery(q);
  const canonical = ['GET', encPath(o.path), cq, 'host:' + o.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
  const sig = hmac(signingKey(o.secret, day, region, service), toSign).toString('hex');
  return (o.protocol || 'https') + '://' + o.host + encPath(o.path) + '?' + cq + '&X-Amz-Signature=' + sig;
}

// Authorization header for a request with a body we can hash.
function signHeaders(o) {
  const date = o.date || new Date();
  const stamp = amzDate(date); const day = stamp.slice(0, 8);
  const region = o.region || 'auto'; const service = 's3';
  const scope = day + '/' + region + '/' + service + '/aws4_request';
  const payloadHash = sha256hex(o.body || '');
  const headers = Object.assign({}, o.headers || {}, { host: o.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp });
  const names = Object.keys(headers).map(function (k) { return k.toLowerCase(); }).sort();
  const lower = {}; Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = String(headers[k]).trim(); });
  const canonical = [o.method, encPath(o.path), '', names.map(function (n) { return n + ':' + lower[n] + '\n'; }).join(''), names.join(';'), payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonical)].join('\n');
  const sig = hmac(signingKey(o.secret, day, region, service), toSign).toString('hex');
  const out = Object.assign({}, headers);
  delete out.host;
  out.Authorization = 'AWS4-HMAC-SHA256 Credential=' + o.accessKeyId + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + sig;
  return out;
}

function create(env) {
  env = env || process.env;
  const account = env.R2_ACCOUNT_ID || ''; const keyId = env.R2_ACCESS_KEY_ID || '';
  const secret = env.R2_SECRET_ACCESS_KEY || ''; const bucket = env.R2_BUCKET || '';
  const enabled = Boolean(account && keyId && secret && bucket);
  let protocol = 'https'; let host = account + '.r2.cloudflarestorage.com';
  if (env.R2_ENDPOINT) { const u = new URL(env.R2_ENDPOINT); protocol = u.protocol.replace(':', ''); host = u.host; }
  const objPath = function (key) { return '/' + bucket + '/' + key; };

  async function request(method, key, body, contentType) {
    const headers = contentType ? { 'content-type': contentType } : {};
    const signed = signHeaders({ method: method, host: host, path: objPath(key), body: body || '', headers: headers, accessKeyId: keyId, secret: secret });
    const r = await fetch(protocol + '://' + host + encPath(objPath(key)), { method: method, headers: signed, body: body || undefined, signal: AbortSignal.timeout(60000) });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) {
      const text = await r.text().catch(function () { return ''; });
      throw new Error('R2 ' + method + ' failed: ' + r.status + ' ' + text.slice(0, 200));
    }
    return r;
  }
  return {
    enabled: enabled,
    bucket: bucket,
    put: function (key, buf, contentType) { return request('PUT', key, buf, contentType || 'application/octet-stream'); },
    get: async function (key) { return Buffer.from(await (await request('GET', key)).arrayBuffer()); },
    remove: function (key) { return request('DELETE', key); },
    // A link that downloads the file for the next `expires` seconds (default 10 minutes).
    downloadUrl: function (key, filename, expires) {
      const name = String(filename || 'file');
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return presign({ protocol: protocol, host: host, path: objPath(key), accessKeyId: keyId, secret: secret, expires: expires || 600,
        query: { 'response-content-disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + enc(name) } });
    }
  };
}

module.exports = { create, presign, signHeaders };
