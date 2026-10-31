'use strict';

/* Neakasa M1 capture UI - no framework, no build step. */

const $ = (id) => document.getElementById(id);

const state = {
  entries: [],          // newest first
  selected: null,       // entry id
  live: true,
  follow: true,
  mask: true,
  filters: { q: '', method: '', status: '' },
  env: null,
  es: null,
};

const SECRET_KEY = /(token|secret|password|passwd|authorization|sign|private|credential|cert)/i;

/** Masks `"key":"value"` pairs inside a blob of text (escaped JSON included). */
function scrubText(text) {
  return String(text).replace(
    /("(?:[^"\\]|\\.)*?(?:token|secret|password|passwd|sign|authorization|private|credential|cert)(?:[^"\\]|\\.)*?"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    (m, pre) => pre + '"\u2588\u2588\u2588\u2588\u2588\u2588"',
  );
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

function qs(extra) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  const token = new URLSearchParams(location.search).get('token')
    || localStorage.getItem('neakasa.token');
  if (token) p.set('token', token);
  return p.toString();
}

function time(iso) {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function statusClass(entry) {
  if (entry.error) return 'net';
  const s = entry.res && entry.res.status;
  if (!s) return 'net';
  return Math.floor(s / 100) + 'xx';
}

function fmtBytes(n) {
  if (!n) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function copy(text, what) {
  navigator.clipboard.writeText(text).then(
    () => toast(what + ' copied'),
    () => toast('clipboard refused by the browser'),
  );
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --------------------------------------------------------------------------- //
// masking - the transcript holds the device credential, so show it hidden
// --------------------------------------------------------------------------- //

function maskDeep(value, keyHint) {
  if (Array.isArray(value)) return value.map(v => maskDeep(v, keyHint));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
    return out;
  }
  if (keyHint && SECRET_KEY.test(keyHint) && value !== '' && value !== null) {
    return '\u2588'.repeat(Math.min(12, String(value).length || 8));
  }
  // a body echoed as a JSON string still carries its own secrets
  return typeof value === 'string' ? scrubText(value) : value;
}

/** Returns display-safe text for a captured body. */
function displayBody(body) {
  if (!body || !body.data) return { text: '(empty)', note: '' };
  if (body.encoding === 'base64') {
    return { text: '<' + body.size + ' bytes binary, base64>\n' + body.data, note: 'binary' };
  }
  let text = body.data;
  if (state.mask) {
    try {
      text = JSON.stringify(maskDeep(JSON.parse(text)), null, 2);
    } catch (e) {
      // not JSON: blank out the usual "key":"value" pairs
      text = scrubText(text);
    }
  } else {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) { /* leave as is */ }
  }
  return { text, note: body.truncated ? 'truncated at ' + fmtBytes(body.size) : '' };
}

function displayHeaderValue(name, value) {
  if (!state.mask || !SECRET_KEY.test(name)) return esc(value);
  return '<span class="secret">\u2588\u2588\u2588\u2588\u2588\u2588</span>';
}

// --------------------------------------------------------------------------- //
// data loading
// --------------------------------------------------------------------------- //

async function loadEnv() {
  try {
    const r = await fetch('/api/env?' + qs());
    if (r.status === 401) return needToken();
    state.env = await r.json();
    $('upstream').textContent = state.env.upstream;
    $('upstream').title = 'everything is forwarded here, byte for byte';
    const host = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? '<this-machine>' : location.hostname;
    $('hintCmd').textContent =
      'python3 scripts/neakasa_ota.py set --device <iotId> --yes \\\n' +
      '    --items \'{"regionBaseurl":"http://' + host + ':' + state.env.proxyPort + state.env.upstreamPath + '"}\'';
  } catch (e) {
    toast('cannot reach the proxy API');
  }
}

async function loadEntries() {
  const r = await fetch('/api/entries?' + qs({ limit: 400 }));
  if (r.status === 401) return needToken();
  const data = await r.json();
  state.entries = data.entries;
  renderStats(data.stats);
  renderList();
}

function needToken() {
  const t = prompt('This UI is protected. Paste UI_TOKEN:');
  if (t) {
    localStorage.setItem('neakasa.token', t.trim());
    location.reload();
  }
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

function renderStats(s) {
  $('sTotal').textContent = s.total;
  $('sOk').textContent = s.ok;
  $('sClient').textContent = s.client;
  $('sServer').textContent = s.server;
  $('sErr').textContent = s.errors;
  $('sAvg').textContent = s.avgMs;
}

function renderList() {
  const list = $('list');
  const frag = document.createDocumentFragment();
  for (const e of state.entries) {
    const cls = statusClass(e);
    const row = document.createElement('div');
    row.className = 'row' + (e.id === state.selected ? ' sel' : '');
    row.dataset.id = e.id;
    row.innerHTML =
      '<span class="t">' + time(e.ts) + '</span>' +
      '<span class="m ' + esc(e.method) + '">' + esc(e.method) + '</span>' +
      '<span class="p" title="' + esc(e.url) + '">' + esc(e.url) +
        (e.patched ? ' <span class="badge" title="upstream path was prepended">*</span>' : '') + '</span>' +
      '<span class="num s' + cls[0] + '">' + (e.status || (e.error ? 'ERR' : '…')) + '</span>' +
      '<span class="num t">' + (e.ms == null ? '' : e.ms) + '</span>';
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
  $('empty').style.display = state.entries.length ? 'none' : 'block';

  if (state.follow && state.entries.length) {
    list.scrollTop = 0;
  }
  if (state.selected) markSelected(state.selected);
}

function markSelected(id) {
  for (const el of $('list').children) el.classList.toggle('sel', el.dataset.id === id);
}

async function openEntry(id) {
  state.selected = id;
  history.replaceState(null, '', '#' + id);
  markSelected(id);
  const r = await fetch('/api/entries/' + encodeURIComponent(id) + '?' + qs());
  if (!r.ok) return toast('entry vanished (log rotated?)');
  renderDetail(await r.json());
}

function renderDetail(e) {
  const cls = statusClass(e);
  const req = displayBody(e.req && e.req.body);
  const res = displayBody(e.res && e.res.body);

  const head =
    '<div class="d-head">' +
      '<div class="d-line">' +
        '<span class="m ' + esc(e.method) + '">' + esc(e.method) + '</span>' +
        '<span class="s' + cls[0] + '">' + (e.error ? 'NETWORK ERROR' : (e.res ? e.res.status : '?')) + '</span>' +
        '<span>' + esc(e.url) + '</span>' +
        (e.patched ? '<span class="pill warn" title="the box called a path without the upstream prefix">path patched</span>' : '') +
      '</div>' +
      '<div class="d-sub">' +
        '<span><span class="k">at</span> ' + esc(e.ts) + '</span>' +
        '<span><span class="k">client</span> ' + esc(e.client) + '</span>' +
        '<span><span class="k">took</span> ' + (e.ms == null ? '?' : e.ms) + ' ms</span>' +
        '<span><span class="k">upstream</span> ' + esc(e.target) + '</span>' +
      '</div>' +
      '<div class="d-actions">' +
        '<button data-act="curl">copy as curl</button>' +
        '<button data-act="json">copy json</button>' +
        '<button data-act="raw">' + (state.mask ? 'reveal secrets' : 'mask secrets') + '</button>' +
      '</div>' +
    '</div>';

  const errBlock = e.error
    ? '<div class="block"><h3>error</h3><pre class="body">' + esc(e.error) + '</pre></div>'
    : '';

  const detail = $('detail');
  detail.innerHTML =
    head + errBlock +
    block('request headers', headerTable(e.req ? e.req.headers : {})) +
    block('request body' + sizeNote(e.req && e.req.body, req), '<pre class="body">' + esc(req.text) + '</pre>') +
    block('response headers', headerTable(e.res ? e.res.headers : {})) +
    block('response body' + sizeNote(e.res && e.res.body, res), '<pre class="body">' + esc(res.text) + '</pre>');

  detail.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'curl') copy(asCurl(e), 'curl');
      else if (act === 'json') copy(JSON.stringify(e, null, 2), 'JSON');
      else if (act === 'raw') {
        state.mask = !state.mask;
        $('mask').checked = state.mask;
        renderDetail(e);
      }
    };
  });
}

function block(title, inner) {
  return '<div class="block"><h3>' + title + '</h3>' + inner + '</div>';
}

function sizeNote(body, shown) {
  if (!body || !body.size) return '';
  return ' \u2014 ' + fmtBytes(body.size) + (shown.note ? ', ' + esc(shown.note) : '');
}

function headerTable(headers) {
  const keys = Object.keys(headers || {});
  if (!keys.length) return '<div class="muted">none</div>';
  return '<table class="kv">' + keys.map(k =>
    '<tr><td>' + esc(k) + '</td><td>' + displayHeaderValue(k, Array.isArray(headers[k]) ? headers[k].join(', ') : headers[k]) + '</td></tr>'
  ).join('') + '</table>';
}

function asCurl(e) {
  let base = (state.env && state.env.upstream) || 'https://deveuapi.neakasa.com/api';
  base = base.replace(/\/+$/, '');
  const url = base + (e.target.startsWith('/') ? e.target : '/' + e.target);
  const skip = /^(host|content-length|accept-encoding|connection|x-forwarded-)/i;
  const parts = ['curl -sS -X ' + e.method + " '" + url.replace(/'/g, "'\\''") + "'"];
  for (const [k, v] of Object.entries(e.req && e.req.headers ? e.req.headers : {})) {
    if (skip.test(k)) continue;
    parts.push("  -H '" + (k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).replace(/'/g, "'\\''") + "'");
  }
  const body = e.req && e.req.body;
  if (body && body.size) {
    const data = body.encoding === 'base64' ? '<base64>' : body.data;
    parts.push("  --data-raw '" + String(data).replace(/'/g, "'\\''") + "'");
  }
  return parts.join(' \\\n');
}

// --------------------------------------------------------------------------- //
// live stream
// --------------------------------------------------------------------------- //

function connectLive() {
  if (state.es) state.es.close();
  if (!state.live) { $('liveDot').classList.remove('on'); return; }

  const token = new URLSearchParams(location.search).get('token')
    || localStorage.getItem('neakasa.token');
  state.es = new EventSource('/api/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
  state.es.onopen = () => $('liveDot').classList.add('on');
  state.es.onerror = () => $('liveDot').classList.remove('on');
  state.es.addEventListener('reset', () => {
    state.entries = [];
    state.selected = null;
    renderList();
    $('detail').innerHTML = '<div class="placeholder"><p>Select a request.</p></div>';
    toast('logs deleted');
    refreshStats();
  });
  state.es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (!passesFilter(e)) return;
    state.entries.unshift({
      id: e.id, ts: e.ts, method: e.method, url: e.url, client: e.client,
      status: e.res ? e.res.status : null,
      reqSize: e.req && e.req.body ? e.req.body.size : 0,
      resSize: e.res && e.res.body ? e.res.body.size : 0,
      ms: e.ms, error: e.error, patched: e.patched,
    });
    if (state.entries.length > 600) state.entries.length = 600;
    renderList();
    refreshStats();
  };
}

function passesFilter(e) {
  const f = state.filters;
  if (f.method && e.method !== f.method) return false;
  if (f.status) {
    if (f.status === 'error') { if (!e.error) return false; }
    else if (String(Math.floor((e.res ? e.res.status : 0) / 100)) + 'xx' !== f.status) return false;
  }
  if (f.q) {
    const hay = (e.method + ' ' + e.url + ' ' + (e.error || '') + ' ' + (e.res ? e.res.status : '')).toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

let statsTimer = null;
function refreshStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => {
    const r = await fetch('/api/stats?' + qs());
    if (r.ok) renderStats(await r.json());
  }, 400);
}

// --------------------------------------------------------------------------- //
// wiring
// --------------------------------------------------------------------------- //

let filterTimer = null;
function onFilterChange() {
  state.filters.q = $('q').value.trim();
  state.filters.method = $('method').value;
  state.filters.status = $('status').value;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadEntries, 150);
}

$('q').addEventListener('input', onFilterChange);
$('method').addEventListener('change', onFilterChange);
$('status').addEventListener('change', onFilterChange);

$('live').addEventListener('click', () => {
  state.live = !state.live;
  $('live').classList.toggle('on', state.live);
  connectLive();
  toast(state.live ? 'live stream on' : 'live stream paused');
});

$('follow').addEventListener('click', () => {
  state.follow = !state.follow;
  $('follow').classList.toggle('on', state.follow);
});

$('mask').addEventListener('change', (ev) => {
  state.mask = ev.target.checked;
  document.body.classList.toggle('reveal', !state.mask);
  if (state.selected) openEntry(state.selected);
});

$('export').addEventListener('click', () => {
  const p = qs({ limit: 5000 });
  window.location.href = '/api/export?' + p;
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every .jsonl transcript in the log volume? This cannot be undone.')) return;
  const r = await fetch('/api/logs?' + qs(), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  toast('deleted ' + (data.removed ?? '?') + ' log file(s)');
  await loadEntries();
});

$('list').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (row) openEntry(row.dataset.id);
});

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (ev.key === '/' && !typing) { ev.preventDefault(); $('q').focus(); }
  else if (ev.key === 'Escape') {
    if (typing) document.activeElement.blur();
    else if (state.selected) { state.selected = null; markSelected(null); $('detail').innerHTML = '<div class="placeholder"><p>Select a request.</p></div>'; }
  } else if (ev.key === ' ' && !typing) { ev.preventDefault(); $('live').click(); }
  else if ((ev.key === 'j' || ev.key === 'k') && !typing && state.entries.length) {
    ev.preventDefault();
    const i = state.entries.findIndex(e => e.id === state.selected);
    const next = ev.key === 'j' ? Math.min(state.entries.length - 1, i + 1) : Math.max(0, i - 1);
    openEntry(state.entries[next].id);
  }
});

// --------------------------------------------------------------------------- //

(async function init() {
  await loadEnv();
  await loadEntries();
  connectLive();

  // deep link: /#<entry-id> opens that request directly
  const deep = decodeURIComponent(location.hash.slice(1));
  if (deep) {
    try { await openEntry(deep); } catch (e) { /* gone after rotation */ }
  }

  setInterval(async () => {
    if (!state.live) await loadEntries();   // keep a paused view fresh enough
  }, 15000);
})();
