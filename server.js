#!/usr/bin/env node
/*
 * Neakasa M1 - capture proxy + log UI.
 *
 * Listens in plain HTTP on the port the box is told to call, forwards every
 * request upstream unchanged, and records the full exchange (headers, bodies,
 * status, latency) to JSONL. A small web UI reads those records live.
 *
 * The box cannot be made to trust a local CA, so this is a forwarding proxy,
 * not a TLS interceptor: the device is simply pointed at us via the
 * `regionBaseurl` property. That is also the boundary of what can be seen -
 * the box's Aliyun IoT channel (api-iot.*.aliyuncs.com, TLS) does NOT pass
 * through here regardless of configuration.
 *
 * The transcript is as sensitive as the device credential it contains.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --------------------------------------------------------------------------- //
// configuration
// --------------------------------------------------------------------------- //

function num(v, d) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
}

function truthy(v) {
    return /^(1|true|yes|on)$/i.test(String(v || ''));
}

let upstreamUrl;
try {
    upstreamUrl = new URL(process.env.UPSTREAM || 'https://deveuapi.neakasa.com/api');
} catch (e) {
    console.error('UPSTREAM is not a valid URL: %s', process.env.UPSTREAM);
    process.exit(2);
}
if (!/^https?:$/.test(upstreamUrl.protocol)) {
    console.error('UPSTREAM must be http:// or https://');
    process.exit(2);
}

const CFG = {
    proxyPort: num(process.env.PROXY_PORT, 8999),
    uiPort: num(process.env.UI_PORT, 8998),
    listenHost: process.env.LISTEN_HOST || '0.0.0.0',
    upstream: upstreamUrl,
    logDir: process.env.LOG_DIR || '/data',
    maxBody: num(process.env.MAX_BODY_BYTES, 256 * 1024),
    memLimit: num(process.env.MEM_LIMIT, 5000),
    uiToken: process.env.UI_TOKEN || '',
    verifyTls: truthy(process.env.VERIFY_TLS),
    publicDir: path.join(__dirname, 'public'),
};

const upstreamPath = CFG.upstream.pathname.replace(/\/+$/, '');
const upstreamLib = CFG.upstream.protocol === 'http:' ? http : https;
const agent = new upstreamLib.Agent({
    keepAlive: true,
    rejectUnauthorized: CFG.verifyTls,
    // A capture rig must not die because the far certificate is odd; --verify
    // (VERIFY_TLS=1) is the switch, and it is documented as a cost, not a hint.
    maxSockets: 16,
});

// --------------------------------------------------------------------------- //
// log storage
// --------------------------------------------------------------------------- //

fs.mkdirSync(CFG.logDir, { recursive: true });

const entries = [];          // newest last, capped at memLimit
const byId = new Map();
let seq = 0;
let stream = null;
let streamDate = null;

function bodyText(buf, contentType) {
    if (!buf || !buf.length) return { encoding: 'utf8', size: 0, truncated: false, data: '' };
    const truncated = buf.length > CFG.maxBody;
    const slice = truncated ? buf.subarray(0, CFG.maxBody) : buf;
    const textual = /^text\/|json|xml|urlencoded|javascript/i.test(contentType || '')
        || looksTextual(slice);
    return {
        encoding: textual ? 'utf8' : 'base64',
        size: buf.length,
        truncated,
        data: textual ? slice.toString('utf8') : slice.toString('base64'),
    };
}

function looksTextual(buf) {
    const n = Math.min(buf.length, 512);
    if (!n) return true;
    let ok = 0;
    for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) ok++;
    }
    return ok / n > 0.9;
}

function dayFile(date) {
    return path.join(CFG.logDir, date + '.jsonl');
}

function persist(entry) {
    const date = entry.ts.slice(0, 10);
    if (streamDate !== date) {
        if (stream) stream.end();
        streamDate = date;
        stream = fs.createWriteStream(dayFile(date), { flags: 'a' });
        stream.on('error', e => console.error('log write failed: %s', e.message));
    }
    stream.write(JSON.stringify(entry) + '\n');
}

function remember(entry) {
    entries.push(entry);
    byId.set(entry.id, entry);
    if (entries.length > CFG.memLimit) {
        const drop = entries.splice(0, entries.length - CFG.memLimit);
        for (const e of drop) byId.delete(e.id);
    }
}

function loadRecent() {
    let files;
    try {
        files = fs.readdirSync(CFG.logDir)
            .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
            .sort()
            .slice(-3);
    } catch (e) {
        return;
    }
    const loaded = [];
    for (const f of files) {
        let text;
        try {
            text = fs.readFileSync(path.join(CFG.logDir, f), 'utf8');
        } catch (e) {
            continue;
        }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                loaded.push(JSON.parse(line));
            } catch (e) {
                // a half-written last line is expected after a hard stop
            }
        }
    }
    for (const e of loaded.slice(-CFG.memLimit)) remember(e);
    console.log('loaded %d entries from disk', entries.length);
}

// --------------------------------------------------------------------------- //
// live subscribers
// --------------------------------------------------------------------------- //

const subscribers = new Set();

function broadcast(entry) {
    const payload = 'data: ' + JSON.stringify(entry) + '\n\n';
    for (const res of subscribers) {
        try {
            res.write(payload);
        } catch (e) {
            subscribers.delete(res);
        }
    }
}

// --------------------------------------------------------------------------- //
// filtering (shared by the UI API and the export)
// --------------------------------------------------------------------------- //

function matches(e, q) {
    const needle = (q.q || '').toLowerCase();
    if (needle) {
        const hay = [
            e.method, e.url, e.target, e.client, String(e.res ? e.res.status : ''),
            JSON.stringify(e.req ? e.req.headers : {}),
            e.req && e.req.body ? e.req.body.data : '',
            e.res && e.res.body ? e.res.body.data : '',
        ].join('\n').toLowerCase();
        if (!hay.includes(needle)) return false;
    }
    if (q.method && String(e.method).toUpperCase() !== q.method.toUpperCase()) return false;
    if (q.status) {
        const s = String(q.status).toLowerCase();
        const code = e.res ? e.res.status : 0;
        if (/^[1-5]xx$/.test(s)) {
            if (Math.floor(code / 100) !== parseInt(s[0], 10)) return false;
        } else if (s === 'error') {
            if (!e.error) return false;
        } else if (String(code) !== s) {
            return false;
        }
    }
    return true;
}

function queryEntries(params) {
    const q = {
        q: params.get('q') || '',
        method: params.get('method') || '',
        status: params.get('status') || '',
    };
    const limit = Math.min(num(params.get('limit'), 500), 5000);
    const order = params.get('order') === 'asc' ? 'asc' : 'desc';
    let list = entries.filter(e => matches(e, q));
    if (order === 'desc') list = list.slice().reverse();
    return list.slice(0, limit);
}

// --------------------------------------------------------------------------- //
// the proxy
// --------------------------------------------------------------------------- //

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function decodeForLog(buf, encoding) {
    if (!encoding) return buf.toString('utf8');
    try {
        if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buf).toString('utf8');
        if (encoding === 'deflate') return zlib.inflateSync(buf).toString('utf8');
        if (encoding === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
    } catch (e) {
        return null;
    }
    return buf.toString('utf8');
}

/** The log gets a readable body; the wire always gets the original bytes. */
function loggable(buf, contentType, contentEncoding) {
    if (!buf || !buf.length) return bodyText(buf, contentType);
    const decoded = decodeForLog(buf, contentEncoding);
    if (decoded === null) {
        return {
            encoding: 'base64', size: buf.length, truncated: false,
            data: buf.toString('base64'),
            note: 'undecodable ' + contentEncoding,
        };
    }
    const truncated = decoded.length > CFG.maxBody;
    return {
        encoding: 'utf8',
        size: buf.length,
        truncated,
        data: truncated ? decoded.slice(0, CFG.maxBody) : decoded,
    };
}

const proxy = http.createServer((cReq, cRes) => {
    const started = Date.now();
    const chunks = [];

    cReq.on('data', c => chunks.push(c));
    cReq.on('end', () => {
        const body = Buffer.concat(chunks);
        const id = started.toString(36) + '-' + (++seq).toString(36);

        // The box stores the base as "http://host:port/api" and may then call
        // either "/api/x" (path repeated) or "/x" (path treated as root).
        let target = cReq.url;
        let patched = false;
        if (upstreamPath && target !== upstreamPath && target.indexOf(upstreamPath + '/') !== 0) {
            target = upstreamPath + (target.startsWith('/') ? target : '/' + target);
            patched = true;
        }

        const headers = {};
        for (const [k, v] of Object.entries(cReq.headers)) {
            const lk = k.toLowerCase();
            if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'content-length') continue;
            headers[k] = v;
        }
        headers.host = CFG.upstream.host;
        if (body.length) headers['content-length'] = body.length;
        headers['accept-encoding'] = 'identity';   // readable answers are the point
        headers['x-forwarded-for'] = cReq.socket.remoteAddress || '';
        headers['x-forwarded-proto'] = 'http';
        headers['x-forwarded-host'] = cReq.headers.host || '';

        const entry = {
            id,
            ts: new Date(started).toISOString(),
            method: cReq.method,
            url: cReq.url,
            target,
            patched,
            client: (cReq.socket.remoteAddress || '?') + ':' + (cReq.socket.remotePort || '?'),
            httpVersion: cReq.httpVersion,
            req: { headers: cReq.headers, body: bodyText(body, cReq.headers['content-type']) },
            res: null,
            ms: null,
            error: null,
        };

        const finish = () => {
            entry.ms = Date.now() - started;
            remember(entry);
            persist(entry);
            broadcast(entry);
        };

        const uReq = upstreamLib.request(new URL(target, CFG.upstream), {
            method: cReq.method,
            headers,
            agent,
        }, uRes => {
            const rChunks = [];
            uRes.on('data', c => rChunks.push(c));
            uRes.on('end', () => {
                const rBody = Buffer.concat(rChunks);
                entry.res = {
                    status: uRes.statusCode,
                    headers: uRes.headers,
                    body: loggable(rBody, uRes.headers['content-type'], uRes.headers['content-encoding']),
                };
                finish();

                const outHeaders = {};
                for (const [k, v] of Object.entries(uRes.headers)) {
                    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
                    outHeaders[k] = v;
                }
                cRes.writeHead(uRes.statusCode, outHeaders);
                cRes.end(rBody);
            });
            uRes.on('error', e => fail(e));
        });

        function fail(e) {
            entry.error = e.message;
            finish();
            console.error('[%s] upstream error: %s', id, e.message);
            if (!cRes.headersSent) cRes.writeHead(502, { 'content-type': 'application/json' });
            cRes.end(JSON.stringify({ proxy: 'upstream error', message: e.message }));
        }

        uReq.on('error', fail);
        uReq.setTimeout(60000, () => uReq.destroy(new Error('upstream timeout after 60s')));
        uReq.end(body);
    });

    cReq.on('error', e => console.error('client error: %s', e.message));
});

proxy.on('error', e => {
    console.error('proxy listen failed on %s: %s', CFG.proxyPort, e.message);
    process.exit(1);
});

// --------------------------------------------------------------------------- //
// the UI + its API
// --------------------------------------------------------------------------- //

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function sendJson(res, code, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    }, extra || {}));
    res.end(body);
}

function authed(req, url) {
    if (!CFG.uiToken) return true;
    const header = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header);
    const given = url.searchParams.get('token') || (bearer ? bearer[1] : '');
    return given === CFG.uiToken;
}

function stats() {
    let ok = 0, client = 0, server = 0, errors = 0, totalMs = 0, timed = 0;
    for (const e of entries) {
        const code = e.res ? e.res.status : 0;
        if (e.error) errors++;
        else if (code >= 500) server++;
        else if (code >= 400) client++;
        else if (code >= 200) ok++;
        if (typeof e.ms === 'number') { totalMs += e.ms; timed++; }
    }
    return {
        total: entries.length,
        ok, client, server, errors,
        avgMs: timed ? Math.round(totalMs / timed) : 0,
        first: entries.length ? entries[0].ts : null,
        last: entries.length ? entries[entries.length - 1].ts : null,
    };
}

function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(CFG.publicDir, rel);
    if (!file.startsWith(CFG.publicDir)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
            return;
        }
        res.writeHead(200, {
            'content-type': MIME[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'no-cache',
        });
        res.end(data);
    });
}

const ui = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true });
    }
    if (!authed(req, url)) {
        return sendJson(res, 401, { error: 'unauthorized' });
    }

    if (url.pathname === '/api/env') {
        return sendJson(res, 200, {
            upstream: CFG.upstream.href,
            upstreamPath,
            verifyTls: CFG.verifyTls,
            maxBody: CFG.maxBody,
            memLimit: CFG.memLimit,
            logDir: CFG.logDir,
            proxyPort: CFG.proxyPort,
            uiPort: CFG.uiPort,
            uiToken: Boolean(CFG.uiToken),
        });
    }

    if (url.pathname === '/api/stats') {
        return sendJson(res, 200, stats());
    }

    if (url.pathname === '/api/entries') {
        const list = queryEntries(url.searchParams).map(e => ({
            // list rows do not need the bodies; keep the payload small
            id: e.id, ts: e.ts, method: e.method, url: e.url, client: e.client,
            status: e.res ? e.res.status : null,
            reqSize: e.req && e.req.body ? e.req.body.size : 0,
            resSize: e.res && e.res.body ? e.res.body.size : 0,
            ms: e.ms, error: e.error, patched: e.patched,
        }));
        return sendJson(res, 200, { entries: list, stats: stats() });
    }

    if (url.pathname.startsWith('/api/entries/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/entries/'.length));
        const e = byId.get(id);
        return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: 'no such entry' });
    }

    if (url.pathname === '/api/stream') {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        subscribers.add(res);
        console.log('stream client connected (%d open)', subscribers.size);
        const beat = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (e) { /* dropped below */ }
        }, 20000);
        req.on('close', () => {
            clearInterval(beat);
            subscribers.delete(res);
            console.log('stream client closed (%d open)', subscribers.size);
        });
        return;
    }

    if (url.pathname === '/api/export') {
        const list = queryEntries(url.searchParams);
        const lines = list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '');
        res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="neakasa-capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl"',
            'cache-control': 'no-store',
        });
        return res.end(lines);
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
        let files = [];
        try {
            files = fs.readdirSync(CFG.logDir)
                .filter(f => f.endsWith('.jsonl'))
                .sort()
                .map(f => {
                    const st = fs.statSync(path.join(CFG.logDir, f));
                    return { file: f, bytes: st.size, modified: st.mtime.toISOString() };
                });
        } catch (e) { /* empty is fine */ }
        return sendJson(res, 200, { files });
    }

    if (url.pathname === '/api/logs' && req.method === 'DELETE') {
        // The transcript goes, on disk and in the view. The write stream holds
        // an open descriptor to a file that is about to be unlinked, so it has
        // to be closed as well - otherwise the next entry is written to an
        // inode nobody can reach again.
        let removed = 0;
        if (stream) { stream.end(); stream = null; streamDate = null; }
        for (const f of fs.readdirSync(CFG.logDir)) {
            if (!f.endsWith('.jsonl')) continue;
            try { fs.unlinkSync(path.join(CFG.logDir, f)); removed++; } catch (e) { /* keep going */ }
        }
        entries.length = 0;
        byId.clear();
        for (const res of subscribers) {
            try { res.write('event: reset\ndata: {}\n\n'); } catch (e) { subscribers.delete(res); }
        }
        return sendJson(res, 200, { removed });
    }

    if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'no such endpoint' });
    }

    return serveStatic(req, res, url.pathname);
});

ui.on('error', e => {
    console.error('ui listen failed on %s: %s', CFG.uiPort, e.message);
    process.exit(1);
});

// --------------------------------------------------------------------------- //
// start
// --------------------------------------------------------------------------- //

loadRecent();

proxy.listen(CFG.proxyPort, CFG.listenHost, () => {
    console.log('capture proxy  http://%s:%d  ->  %s', CFG.listenHost, CFG.proxyPort, CFG.upstream.href);
    console.log('upstream TLS  %s', CFG.verifyTls ? 'verified' : 'NOT verified (VERIFY_TLS=1 to enable)');
    console.log('logs          %s', CFG.logDir);
});

ui.listen(CFG.uiPort, CFG.listenHost, () => {
    console.log('log ui        http://%s:%d%s', CFG.listenHost, CFG.uiPort, CFG.uiToken ? '  (UI_TOKEN required)' : '');
});

function shutdown(sig) {
    console.log('%s - stopping', sig);
    for (const res of subscribers) { try { res.end(); } catch (e) { /* gone */ } }
    if (stream) stream.end();
    proxy.close();
    ui.close();
    setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
