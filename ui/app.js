// al-dente live map. Plain ES module, no build step.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const breaking = (n) => `${plural(n, 'import')} ${n === 1 ? 'breaks' : 'break'} the plan`;

const W = 248, H = 100, GAP_X = 76, GAP_Y = 132, PAD = 64; // W and H must match .node in style.css
const UNMAPPED = '~unmapped';
const FX_MS = 4500, FLASH_MS = 2600;

const stage = $('#stage'), world = $('#world'), wires = $('#wires'), nodesEl = $('#nodes');
const tip = $('#tip'), detailsEl = $('#details'), feedEl = $('#feed'), emptyEl = $('#empty');

let S = null;    // latest graph from the server
let feed = [];   // activity, newest first
let geo = null;  // layout: positions, rows, size
let sel = null;  // { type: 'part' | 'edge', id }
let hover = null;
let userMoved = false;
const view = { x: 0, y: 0, k: 1 };
const nodeEls = new Map();
const fx = { live: new Map(), affected: new Map(), flash: new Map() }; // short-lived highlights after an edit

// ------------------------------------------------------------------ lookups

const edgeKey = (e) => `${e.from}>${e.to}`;
const allEdges = () => [...S.planned.map((e) => ({ ...e, kind: 'planned', count: 0, imports: [] })), ...S.edges];
const findEdge = (key) => allEdges().find((e) => edgeKey(e) === key);
const active = (map, key) => { const v = map.get(key); return v && v.until > Date.now() ? v : null; };
const labelOf = (id) => (id === UNMAPPED ? 'Unmapped' : S?.parts.find((p) => p.id === id)?.label ?? id);
// Part colors follow the part's position in al-dente.json (never cycled); past 8 parts they go neutral.
const colorOf = (id) => { const i = S?.parts.findIndex((p) => p.id === id) ?? -1; return i >= 0 && i < 8 ? `var(--series-${i + 1})` : 'var(--muted)'; };

function partById(id) {
  if (id !== UNMAPPED) return S.parts.find((p) => p.id === id);
  return {
    id, label: 'Unmapped files', description: 'Not claimed by any part yet', paths: [], uses: [], violations: 0,
    files: (S.unmapped ?? []).map((path) => ({ path, imports: 0 })),
  };
}

// ------------------------------------------------------------------ layout

const layoutSig = () => JSON.stringify([S.parts.map((p) => [p.id, p.uses]), !!S.unmapped]);

/** Layered layout from the *rules* (not the live imports), so boxes never jump around while code changes. */
function layout() {
  const ids = S.parts.map((p) => p.id);
  const users = new Map(ids.map((id) => [id, []]));
  for (const p of S.parts) for (const u of p.uses) users.get(u)?.push(p.id);

  // A part sits one row below the lowest part that uses it; cycles in the plan are cut where found.
  const rank = new Map(), stack = new Set();
  const rankOf = (id) => {
    if (rank.has(id)) return rank.get(id);
    if (stack.has(id)) return -1;
    stack.add(id);
    const r = Math.max(0, ...users.get(id).map((u) => rankOf(u) + 1));
    stack.delete(id);
    rank.set(id, r);
    return r;
  };
  ids.forEach(rankOf);
  const rows = [];
  for (const id of ids) (rows[rank.get(id)] ??= []).push(id);
  const filled = rows.filter(Boolean);
  if (S.unmapped) filled.push([UNMAPPED]);

  // Order each row by the average position of its neighbours to cut down crossings.
  const nb = new Map([...ids, UNMAPPED].map((id) => [id, []]));
  for (const p of S.parts) for (const u of p.uses) { nb.get(p.id).push(u); nb.get(u).push(p.id); }
  const cx = new Map();
  const place = () => filled.forEach((row) => row.forEach((id, i) => cx.set(id, (i - (row.length - 1) / 2) * (W + GAP_X))));
  place();
  for (let pass = 0; pass < 8; pass++) {
    for (const row of filled) {
      const bary = new Map(row.map((id) => {
        const xs = nb.get(id).map((n) => cx.get(n));
        return [id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : cx.get(id)];
      }));
      row.sort((a, b) => bary.get(a) - bary.get(b));
    }
    place();
  }

  const widest = Math.max(...filled.map((r) => r.length));
  const half = (widest * W + (widest - 1) * GAP_X) / 2;
  const pos = new Map();
  filled.forEach((row, r) => row.forEach((id) => {
    const x = cx.get(id) + half - W / 2 + PAD;
    pos.set(id, { x, y: PAD + r * (H + GAP_Y), cx: x + W / 2, rank: r });
  }));
  return { pos, rows: filled, w: half * 2 + PAD * 2, h: filled.length * (H + GAP_Y) - GAP_Y + PAD * 2, sig: layoutSig() };
}

/** Route every edge: spread ports along each box side, and thread long edges through the gaps between boxes. */
function route(edges) {
  const ports = new Map();
  const plans = [];
  for (const e of edges) {
    const a = geo.pos.get(e.from), b = geo.pos.get(e.to);
    if (!a || !b) continue;
    const [exit, enter] = b.rank > a.rank ? ['bottom', 'top'] : b.rank < a.rank ? ['top', 'bottom'] : ['top', 'top'];
    const plan = { e, a, b };
    for (const [key, end, other] of [[`${e.from}\n${exit}`, 'p0', b.cx], [`${e.to}\n${enter}`, 'p1', a.cx]]) {
      if (!ports.has(key)) ports.set(key, []);
      ports.get(key).push({ plan, end, other });
    }
    plans.push(plan);
  }
  for (const [key, items] of ports) {
    const [id, side] = key.split('\n');
    const n = geo.pos.get(id);
    items.sort((p, q) => p.other - q.other);
    const step = Math.min(20, (W * 0.6) / Math.max(1, items.length - 1));
    items.forEach((it, i) => {
      const arrowRoom = it.end === 'p1' ? (side === 'top' ? -3 : 3) : 0;
      it.plan[it.end] = { x: n.cx + (i - (items.length - 1) / 2) * step, y: (side === 'top' ? n.y : n.y + H) + arrowRoom };
    });
  }

  const gaps = new Map();
  return plans.map(({ e, a, b, p0, p1 }) => {
    if (a.rank === b.rank) { // same row: arc over the top
      const h = Math.min(80, 44 + Math.abs(p1.x - p0.x) * 0.12);
      return { e, d: `M${p0.x},${p0.y} C${p0.x},${p0.y - h} ${p1.x},${p1.y - h} ${p1.x},${p1.y}`, mid: { x: (p0.x + p1.x) / 2, y: p0.y - h * 0.75 } };
    }
    const pts = [p0];
    const dir = Math.sign(b.rank - a.rank);
    for (let r = a.rank + dir; r !== b.rank; r += dir) {
      const top = geo.pos.get(geo.rows[r][0]).y;
      let x = p0.x + ((p1.x - p0.x) * (top + H / 2 - p0.y)) / (p1.y - p0.y);
      for (const id of geo.rows[r]) {
        const n = geo.pos.get(id);
        if (x > n.x - 20 && x < n.x + W + 20) x = x - n.x < W / 2 ? n.x - GAP_X / 2 : n.x + W + GAP_X / 2;
      }
      const slot = `${r}:${Math.round(x)}`, used = gaps.get(slot) ?? 0;
      gaps.set(slot, used + 1);
      x += (used % 2 ? -1 : 1) * Math.ceil(used / 2) * 9;
      // Run straight down the gap for the whole row height, so bends happen between rows, never beside a box.
      const [y1, y2] = dir > 0 ? [top - 8, top + H + 8] : [top + H + 8, top - 8];
      pts.push({ x, y: y1 }, { x, y: y2 });
    }
    pts.push(p1);
    let d = `M${p0.x},${p0.y}`;
    for (let i = 1; i < pts.length; i++) {
      const s = pts[i - 1], t = pts[i], dy = (t.y - s.y) / 2;
      d += ` C${s.x},${s.y + dy} ${t.x},${t.y - dy} ${t.x},${t.y}`;
    }
    const segs = pts.length - 1;
    const m = (segs - 1) / 2;
    const mid = segs % 2 ? { x: (pts[m].x + pts[m + 1].x) / 2, y: (pts[m].y + pts[m + 1].y) / 2 } : pts[segs / 2];
    return { e, d, mid };
  });
}

// ------------------------------------------------------------------ drawing

const ORDER = { planned: 0, unchecked: 1, allowed: 2, violation: 3 };

function drawEdges() {
  const edges = allEdges().sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  wires.setAttribute('width', geo.w);
  wires.setAttribute('height', geo.h);
  const marker = (k) => `<marker id="m-${k}" class="mk-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0.5 L10,5 L0,9.5 z"/></marker>`;
  wires.innerHTML = `<defs>${Object.keys(ORDER).map(marker).join('')}</defs>` + route(edges).map(({ e, d, mid }) => {
    const key = edgeKey(e);
    const width = e.kind === 'allowed' ? `--w:${(1.4 + Math.min(2.4, Math.log2(e.count))).toFixed(2)}` : '';
    const text = e.kind === 'violation' ? `✗ ${e.count}` : e.count > 1 ? String(e.count) : '';
    const pill = text
      ? `<g class="elabel" transform="translate(${mid.x},${mid.y})"><rect x="${-(text.length * 3.6 + 8)}" y="-9" width="${text.length * 7.2 + 16}" height="18" rx="9"/><text>${text}</text></g>`
      : '';
    const flash = active(fx.flash, key) ? ' flash' : '';
    return `<g class="edge k-${e.kind}${flash}" data-edge="${esc(key)}" style="${width}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#m-${e.kind})"/>${pill}</g>`;
  }).join('');
  applyFocus();
}

function drawNodes() {
  if (!geo) return;
  for (const [id, el] of nodeEls) if (!geo.pos.has(id)) { el.remove(); nodeEls.delete(id); }
  for (const [id, n] of geo.pos) {
    let el = nodeEls.get(id);
    if (!el) {
      el = Object.assign(document.createElement('button'), { type: 'button', className: 'node' });
      el.dataset.part = id;
      nodesEl.append(el);
      nodeEls.set(id, el);
    }
    const p = partById(id);
    const editing = active(fx.live, id), affected = active(fx.affected, id);
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.setProperty('--part', colorOf(id));
    el.classList.toggle('unmapped', id === UNMAPPED);
    el.classList.toggle('affected', !!affected && !editing);
    el.setAttribute('aria-label', `${p.label}: ${plural(p.files.length, 'file')}${p.violations ? `, ${plural(p.violations, 'rule break')}` : ''}`);
    const flag = editing
      ? `<span class="n-flag">${editing.actor === 'agent' ? 'Claude is editing' : 'You edited'}</span>`
      : affected ? '<span class="n-flag affected">May be affected</span>' : '';
    el.innerHTML = `
      <span class="n-head"><span class="n-title">${esc(p.label)}</span><span class="n-count">${plural(p.files.length, 'file')}</span></span>
      <span class="n-desc">${esc(p.description) || '&nbsp;'}</span>
      <span class="n-paths">${p.paths.map((x) => `<code>${esc(x)}/</code>`).join('') || '<code>add to al-dente.json</code>'}</span>
      ${p.violations ? `<span class="n-bad" title="${breaking(p.violations)}">✗ ${p.violations}</span>` : ''}
      ${flag}`;
  }
}

/** Dim everything that isn't connected to what you're hovering or have selected. */
function applyFocus() {
  if (!geo) return;
  const f = hover ?? sel;
  let parts = null, edges = null;
  if (f?.type === 'part') {
    parts = new Set([f.id]);
    edges = new Set();
    for (const e of allEdges()) if (e.from === f.id || e.to === f.id) { edges.add(edgeKey(e)); parts.add(e.from); parts.add(e.to); }
  } else if (f?.type === 'edge') {
    const e = findEdge(f.id);
    if (e) { parts = new Set([e.from, e.to]); edges = new Set([f.id]); }
  }
  for (const [id, el] of nodeEls) {
    el.classList.toggle('dim', !!parts && !parts.has(id));
    el.classList.toggle('sel', sel?.type === 'part' && sel.id === id);
  }
  for (const g of wires.querySelectorAll('.edge')) {
    g.classList.toggle('dim', !!edges && !edges.has(g.dataset.edge));
    g.classList.toggle('hot', !!edges && edges.has(g.dataset.edge));
  }
}

// ------------------------------------------------------------------ side panel

const edgeRow = (e) => `<li><button type="button" class="row" data-edge="${esc(edgeKey(e))}">${e.kind === 'violation' ? '<span class="x">✗</span>' : ''}<span class="grow">${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</span><span class="meta">${plural(e.count, 'import')}</span></button></li>`;
const closeBtn = '<button type="button" class="close" data-close aria-label="Close">×</button>';

function overview() {
  const bad = S.edges.filter((e) => e.kind === 'violation');
  return `<h2>Overview</h2>
    ${bad.length
      ? `<span class="verdict bad"><i>✗</i> ${breaking(S.violations)}</span><h3>Rule breaks</h3><ul class="rows">${bad.map(edgeRow).join('')}</ul>`
      : '<span class="verdict good"><i>✓</i> Every import follows the plan</span>'}
    <h3>How to read it</h3>
    <ul class="howto">
      <li>Each box is a part of your app, defined in <code>al-dente.json</code>.</li>
      <li>Arrows go from the part that imports to the part it uses. Higher parts build on lower ones.</li>
      <li>Click a part or an arrow to see the exact files and lines.</li>
    </ul>`;
}

function partDetails(id) {
  const p = partById(id);
  const out = S.edges.filter((e) => e.from === id), inc = S.edges.filter((e) => e.to === id);
  const badFiles = new Set(out.filter((e) => e.kind === 'violation').flatMap((e) => e.imports.map((i) => i.file)));
  const chip = (pid, meta, cls) => `<button type="button" class="chip ${cls}" data-part="${esc(pid)}" style="--part:${colorOf(pid)}">${esc(labelOf(pid))}<small>${esc(meta)}</small></button>`;
  const uses = p.uses.map((u) => {
    const e = out.find((x) => x.to === u);
    return chip(u, e ? plural(e.count, 'import') : 'not used yet', e ? '' : 'unused');
  }).join('');
  const extra = out.filter((e) => e.kind !== 'allowed');
  const verdict = id === UNMAPPED ? '<p>Add these folders to a part in <code>al-dente.json</code> so they get checked too.</p>'
    : p.violations ? `<span class="verdict bad"><i>✗</i> ${breaking(p.violations)}</span>`
    : '<span class="verdict good"><i>✓</i> Follows the plan</span>';
  return `
    <div class="d-title" style="--part:${colorOf(id)}"><span class="swatch"></span><h2>${esc(p.label)}</h2>${closeBtn}</div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${verdict}
    ${id === UNMAPPED ? '' : `<h3>Allowed to use</h3>${uses ? `<div class="chips">${uses}</div>` : '<p>Nothing. This part stands on its own.</p>'}`}
    ${extra.length ? `<h3>Also imports</h3><ul class="rows">${extra.map(edgeRow).join('')}</ul>` : ''}
    <h3>Used by</h3>${inc.length ? `<ul class="rows">${inc.map(edgeRow).join('')}</ul>` : '<p>No other part imports it.</p>'}
    <h3>${plural(p.files.length, 'file')}</h3>
    <ul class="rows files">${p.files.slice(0, 80).map((f) => `<li>${badFiles.has(f.path) ? '<span class="x">✗</span>' : ''}<code title="${esc(f.path)}">${esc(f.path)}</code></li>`).join('')}</ul>
    ${p.files.length > 80 ? `<p>and ${p.files.length - 80} more</p>` : ''}`;
}

function edgeDetails(e) {
  const from = e.from === UNMAPPED ? null : partById(e.from);
  const may = from?.uses.length ? from.uses.map(labelOf).map(esc).join(', ') : 'nothing outside itself';
  const verdict = {
    allowed: '<span class="verdict good"><i>✓</i> Allowed by the plan</span>',
    planned: '<span class="verdict"><i>○</i> Allowed by the plan, not used yet</span>',
    violation: `<span class="verdict bad"><i>✗</i> Breaks the plan</span><p>${esc(from?.label)} may only use: ${may}.</p>`,
    unchecked: '<span class="verdict"><i>?</i> Not checked: involves files no part claims</span>',
  }[e.kind];
  const list = e.imports.map((i) => `<li><code>${esc(i.file)}:${i.line}</code><code class="to">"${esc(i.spec)}" → ${esc(i.target)}</code></li>`).join('');
  return `
    <div class="d-title"><h2>${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</h2>${closeBtn}</div>
    ${verdict}
    ${e.count ? `<h3>${plural(e.count, 'import')}</h3><ul class="rows imports">${list}</ul>` : ''}
    ${e.count > e.imports.length ? `<p>and ${e.count - e.imports.length} more</p>` : ''}`;
}

function renderDetails() {
  if (!S || S.missing || S.error) return void (detailsEl.innerHTML = '');
  const edge = sel?.type === 'edge' && findEdge(sel.id);
  if (sel?.type === 'part' && geo?.pos.has(sel.id)) detailsEl.innerHTML = partDetails(sel.id);
  else if (edge) detailsEl.innerHTML = edgeDetails(edge);
  else { sel = null; detailsEl.innerHTML = overview(); }
}

function select(s) {
  sel = s;
  applyFocus();
  renderDetails();
}

// ------------------------------------------------------------------ activity feed

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function entryHtml(a, fresh) {
  const who = a.actor === 'agent' ? '<span class="who"><i>✦</i>Claude</span>' : '<span class="who you"><i>●</i>You</span>';
  const time = `<time data-t="${a.time}">${ago(a.time)}</time>`;
  const li = (verb, file, tags) => `<li class="ev${fresh ? ' fresh' : ''}" data-ev="${a.id}">
    <div class="ev-head">${who}<span class="verb">${verb}</span>${time}</div>
    <div class="ev-file">${file}</div><div class="tags">${tags.join('')}</div></li>`;

  if (a.kind === 'rules') {
    return li('updated the plan', 'al-dente.json', [a.error
      ? `<span class="tag bad"><i>✗</i>${esc(a.error)}</span>`
      : `<span class="tag good"><i>✓</i>${plural(a.parts, 'part')}</span>`]);
  }
  const cut = a.file.lastIndexOf('/') + 1;
  const tags = [a.part
    ? `<span class="tag part" style="--part:${colorOf(a.part)}">${esc(labelOf(a.part))}</span>`
    : '<span class="tag">Unmapped</span>'];
  for (const v of a.broke) tags.push(`<span class="tag bad"><i>✗</i>${esc(labelOf(a.part))} → ${esc(labelOf(v.to))} not allowed · line ${v.line}</span>`);
  for (const v of a.fixed) tags.push(`<span class="tag good"><i>✓</i>Fixed ${esc(labelOf(a.part))} → ${esc(labelOf(v.to))}</span>`);
  if (a.part && a.kind !== 'deleted' && !a.broke.length && !a.fixed.length) {
    tags.push(a.violations ? `<span class="tag bad"><i>✗</i>Still ${plural(a.violations, 'rule break')}</span>` : '<span class="tag good"><i>✓</i>Fits the plan</span>');
  }
  if (a.affected.length) tags.push(`<span class="tag warn"><i>⚠</i>May affect ${a.affected.map(labelOf).map(esc).join(', ')}</span>`);
  const verb = { created: 'created', changed: 'edited', deleted: 'deleted' }[a.kind];
  return li(verb, `<span>${esc(a.file.slice(0, cut))}</span>${esc(a.file.slice(cut))}`, tags);
}

function renderFeed(freshId) {
  feedEl.innerHTML = feed.length
    ? feed.map((a) => entryHtml(a, a.id === freshId)).join('')
    : '<li class="ev-empty">Edits show up here as they happen.<br>Ask Claude to change something.</li>';
}

function pulse(id) {
  const el = nodeEls.get(id);
  if (!el) return;
  el.classList.remove('ping');
  void el.offsetWidth; // restart the animation
  el.classList.add('ping');
}

/** Light up what an edit touched: the part, the arrows it uses, and the parts that depend on the file. */
function animate(a) {
  if (!geo || !a.part || !geo.pos.has(a.part)) return;
  const now = Date.now();
  fx.live.set(a.part, { until: now + FX_MS, actor: a.actor });
  for (const id of a.affected) fx.affected.set(id, { until: now + FX_MS });
  for (const to of a.links) fx.flash.set(`${a.part}>${to}`, { until: now + FLASH_MS });
  drawNodes();
  drawEdges();
  pulse(a.part);
  setTimeout(() => { drawNodes(); drawEdges(); }, FX_MS + 50);
}

// ------------------------------------------------------------------ top bar + empty states

function renderHeader() {
  $('#project').textContent = S?.project ?? '';
  const h = $('#health');
  h.className = 'health';
  if (S.error) { h.classList.add('warn'); h.innerHTML = '<i>⚠</i> Plan has an error'; }
  else if (S.missing) h.innerHTML = '<i>○</i> No plan yet';
  else if (S.violations) { h.classList.add('bad'); h.innerHTML = `<i>✗</i> ${plural(S.violations, 'rule break')}`; }
  else { h.classList.add('good'); h.innerHTML = '<i>✓</i> Matches the plan'; }
  $('#stats').textContent = S.stats ? `${plural(S.stats.parts, 'part')} · ${plural(S.stats.files, 'file')} · ${plural(S.stats.imports, 'import')}` : '';
  document.title = S.violations ? `✗ ${S.violations} · al-dente` : `${S.project} · al-dente`;
}

const MISSING = `<div class="empty-card">
  <h2>No plan yet</h2>
  <p>al-dente draws your app from a plan in <code>al-dente.json</code>: the parts of your app, and which part may use which. Ask Claude in this project:</p>
  <pre>Design the architecture for this app with al-dente</pre>
  <p>Already have code? Ask <code>Map this codebase into al-dente parts</code> instead. The map appears here the moment the plan is saved.</p>
</div>`;

function render() {
  renderHeader();
  if (S.missing || S.error) {
    geo = null;
    nodeEls.forEach((el) => el.remove());
    nodeEls.clear();
    wires.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.innerHTML = S.error
      ? `<div class="empty-card"><h2>The plan has a problem</h2><p>${esc(S.error)}</p><p>Fix <code>al-dente.json</code> and the map comes back by itself.</p></div>`
      : MISSING;
    renderDetails();
    return;
  }
  emptyEl.hidden = true;
  const relayout = !geo || geo.sig !== layoutSig();
  if (relayout) geo = layout();
  drawNodes();
  drawEdges();
  if (relayout) { userMoved = false; fit(); }
  renderDetails();
}

// ------------------------------------------------------------------ pan & zoom

function setView(x, y, k) {
  Object.assign(view, { x, y, k });
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  stage.style.backgroundSize = `${22 * k}px ${22 * k}px`;
}

function fit() {
  if (!geo) return;
  const r = stage.getBoundingClientRect();
  const fitTo = (h) => {
    const k = Math.min(1.1, Math.max(0.3, Math.min(r.width / geo.w, h / geo.h)));
    setView((r.width - geo.w * k) / 2, (h - geo.h * k) / 2, k);
  };
  fitTo(r.height);
  // Shrink only if a box would end up under the legend in the bottom-left corner.
  const legend = $('.legend').getBoundingClientRect();
  const covered = legend.width > 0 && [...geo.pos.values()].some((n) =>
    r.left + view.x + n.x * view.k < legend.right + 12 && r.top + view.y + (n.y + H) * view.k > legend.top - 12);
  if (covered) fitTo(legend.top - r.top - 12);
}

function zoomAt(mx, my, factor) {
  const k = Math.min(2.5, Math.max(0.25, view.k * factor));
  setView(mx - ((mx - view.x) * k) / view.k, my - ((my - view.y) * k) / view.k, k);
  userMoved = true;
}

stage.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
}, { passive: false });

let drag = null;
stage.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || ev.target.closest('.node, .hud, .edge, .empty-card')) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
  stage.setPointerCapture(ev.pointerId);
});
stage.addEventListener('pointermove', (ev) => {
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = userMoved = true;
    stage.classList.add('panning');
    setView(drag.vx + dx, drag.vy + dy, view.k);
    return;
  }
  const g = ev.target.closest?.('.edge');
  if (g && S && !S.missing) {
    if (hover?.id !== g.dataset.edge) { hover = { type: 'edge', id: g.dataset.edge }; applyFocus(); }
    showTip(findEdge(g.dataset.edge), ev);
  } else if (hover?.type === 'edge') {
    hover = null;
    tip.hidden = true;
    applyFocus();
  }
});
stage.addEventListener('pointerup', () => {
  if (drag && !drag.moved) select(null);
  drag = null;
  stage.classList.remove('panning');
});
stage.addEventListener('dblclick', (ev) => { if (!ev.target.closest('.node, .hud, .edge')) { userMoved = false; fit(); } });
stage.addEventListener('click', (ev) => {
  const g = ev.target.closest('.edge');
  if (g) select({ type: 'edge', id: g.dataset.edge });
});

function showTip(e, ev) {
  if (!e) return;
  const head = {
    allowed: '✓ Allowed by the plan',
    planned: '○ Allowed by the plan, not used yet',
    violation: `✗ Breaks the plan: ${labelOf(e.from)} may not use ${labelOf(e.to)}`,
    unchecked: '? Involves files no part claims',
  }[e.kind];
  const shown = e.imports.slice(0, 5);
  tip.innerHTML = `<h3>${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</h3><div class="tip-k">${esc(head)}</div>
    ${shown.length ? `<ul>${shown.map((i) => `<li><code>${esc(i.file)}:${i.line}</code></li>`).join('')}</ul>` : ''}
    ${e.count > shown.length ? `<div class="more">+${e.count - shown.length} more · click for all</div>` : ''}`;
  tip.hidden = false;
  const r = stage.getBoundingClientRect();
  let x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 16;
  if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 16;
  if (y + tip.offsetHeight > r.height - 8) y = ev.clientY - r.top - tip.offsetHeight - 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

nodesEl.addEventListener('pointerover', (ev) => {
  const el = ev.target.closest('.node');
  if (el && hover?.id !== el.dataset.part) { hover = { type: 'part', id: el.dataset.part }; applyFocus(); }
});
nodesEl.addEventListener('pointerout', (ev) => {
  const el = ev.target.closest('.node');
  if (el && !el.contains(ev.relatedTarget)) { hover = null; applyFocus(); }
});
nodesEl.addEventListener('click', (ev) => {
  const el = ev.target.closest('.node');
  if (el) select(sel?.type === 'part' && sel.id === el.dataset.part ? null : { type: 'part', id: el.dataset.part });
});

$('.zoom').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-zoom]');
  if (!b || !geo) return;
  const r = stage.getBoundingClientRect();
  if (b.dataset.zoom === 'fit') { userMoved = false; fit(); }
  else zoomAt(r.width / 2, r.height / 2, b.dataset.zoom === 'in' ? 1.25 : 0.8);
});
new ResizeObserver(() => { if (!userMoved) fit(); }).observe(stage);

// ------------------------------------------------------------------ panel + feed clicks, keyboard, theme

detailsEl.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-part], [data-edge], [data-close]');
  if (!t) return;
  if (t.dataset.part) select({ type: 'part', id: t.dataset.part });
  else if (t.dataset.edge) select({ type: 'edge', id: t.dataset.edge });
  else select(null);
});
feedEl.addEventListener('click', (ev) => {
  const li = ev.target.closest('[data-ev]');
  const a = li && feed.find((x) => x.id === Number(li.dataset.ev));
  if (a?.part && geo?.pos.has(a.part)) { select({ type: 'part', id: a.part }); pulse(a.part); }
});
$('#health').addEventListener('click', () => {
  const bad = S?.edges?.find((e) => e.kind === 'violation');
  if (bad) select({ type: 'edge', id: edgeKey(bad) });
});
addEventListener('keydown', (ev) => { if (ev.key === 'Escape') select(null); });

const THEME_KEY = 'al-dente-theme';
try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch { /* storage blocked */ }
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* storage blocked */ }
});

setInterval(() => { for (const t of feedEl.querySelectorAll('time')) t.textContent = ago(Number(t.dataset.t)); }, 10_000);

// ------------------------------------------------------------------ live connection

const conn = $('#conn');
const setConn = (state, text) => { conn.dataset.state = state; conn.lastElementChild.textContent = text; };
const events = new EventSource('/api/events');
events.addEventListener('open', () => setConn('live', 'Live'));
events.addEventListener('error', () => setConn('reconnecting', 'Reconnecting…'));
events.addEventListener('state', (ev) => { S = JSON.parse(ev.data); render(); });
events.addEventListener('feed', (ev) => { feed = JSON.parse(ev.data); renderFeed(); });
events.addEventListener('activity', (ev) => {
  const a = JSON.parse(ev.data);
  const i = feed.findIndex((x) => x.id === a.id);
  if (i >= 0) { // the hook re-labelled an edit as Claude's
    feed[i] = a;
    const live = fx.live.get(a.part);
    if (live) { live.actor = a.actor; drawNodes(); }
    return renderFeed();
  }
  feed.unshift(a);
  feed.length = Math.min(feed.length, 60);
  renderFeed(a.id);
  animate(a);
});
