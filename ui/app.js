// al-dente live map. Plain ES module, no build step.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (v) => esc(v).replace(/`([^`]+)`/g, '<code>$1</code>'); // descriptions may quote code in backticks
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const breaking = (n) => `${plural(n, 'import')} ${n === 1 ? 'breaks' : 'break'} the plan`;

// Geometry. Box sizes are set inline from here; ROW must match `.n-files li` in style.css and H `.n-main`.
const W = 240, H = 112;                          // a closed box, and the header of an open one
const XW = 344, ROW = 46, MAX_ROWS = 40, MORE = 34; // an open box: one row per file
const GAP_X = 72, PAD = 60, M = 14;              // M: how far an edge keeps from a box it passes
const TRACK = 12, LANE = 9, GAP_PAD = 22, MIN_GAP = 84;  // edges run on horizontal tracks in the gaps between rows
const FLAG_ROOM = 30;                            // the bottom of a gap stays free for the flags above boxes ("Claude is editing")
const FAR = 0.6;                                 // below this zoom, boxes show titles only
const UNMAPPED = '~unmapped';
const FX_MS = 4500, FLASH_MS = 2600;

const stage = $('#stage'), world = $('#world'), wires = $('#wires'), nodesEl = $('#nodes');
const tip = $('#tip'), detailsEl = $('#details'), feedEl = $('#feed'), emptyEl = $('#empty');
const feedPanel = $('.feed-panel'), commitEl = $('#commit'), timelineEl = $('#timeline'), range = $('#tl-range'), tlTip = $('#tl-tip');

let live = null;   // latest graph from the server (counts only)
let index = {};    // live file index: rel -> { part, about, imports }, patched as files change
let S = null;      // what's on screen: a graph plus its file index (live, or a past commit's)
let hist = null;   // timeline: { all, commits (oldest first), branch, web, index, data, changes, drift, driftDone, driftTotal }
let feed = [];     // activity, newest first
let geo = null;    // layout: boxes, rows, edge routes
let sel = null;    // { type: 'part' | 'edge' | 'file', id }
let hover = null;
let userMoved = false;
let expanded = new Set(); // parts opened to show their files
let derived = null;       // per-S lookups (files by part, importers, imports per edge)
const view = { x: 0, y: 0, k: 1 };
const nodeEls = new Map();
const fx = { live: new Map(), affected: new Map(), flash: new Map() }; // short-lived highlights after an edit
const commitCache = new Map();

// ------------------------------------------------------------------ lookups

const past = () => !!hist?.data;
const edgeKey = (e) => `${e.from}>${e.to}`;
function allEdges() {
  const removed = past() ? hist.data.edges.removed.map((e) => ({ ...e, kind: 'removed' })) : [];
  const gone = new Set(removed.map(edgeKey));
  const planned = S.planned.filter((e) => !gone.has(edgeKey(e))).map((e) => ({ ...e, kind: 'planned', count: 0 }));
  return [...removed, ...planned, ...S.edges];
}
const findEdge = (key) => allEdges().find((e) => edgeKey(e) === key);
const active = (map, key) => { const v = map.get(key); return v && v.until > Date.now() ? v : null; };
const labelOf = (id) => (id === UNMAPPED || !id ? 'Unmapped' : S?.parts.find((p) => p.id === id)?.label ?? id);
// Part colors follow the part's position in al-dente.json (never cycled); past 8 parts they go neutral.
const colorOf = (id) => { const i = S?.parts.findIndex((p) => p.id === id) ?? -1; return i >= 0 && i < 8 ? `var(--series-${i + 1})` : 'var(--muted)'; };
const partOfFile = (rel, hint) => S.files?.[rel]?.part ?? hint ?? UNMAPPED;
/** Does an import from part `from` into part `to` break the plan? */
const breaks = (from, to) => !!from && !!to && from !== UNMAPPED && to !== UNMAPPED && from !== to && !S.parts.find((p) => p.id === from)?.uses.includes(to);

/** Lookups built once per graph: each part's files, who imports each file, and (lazily) the imports behind each edge. */
function derive() {
  if (derived?.S === S) return derived;
  const byPart = new Map(), importers = new Map();
  for (const [rel, f] of Object.entries(S.files ?? {})) {
    const p = f.part ?? UNMAPPED;
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(rel);
    for (const i of f.imports) {
      if (!importers.has(i.target)) importers.set(i.target, []);
      const list = importers.get(i.target);
      if (!list.some((x) => x.file === rel)) list.push({ file: rel, line: i.line });
    }
  }
  for (const list of byPart.values()) list.sort();
  byPart.set(UNMAPPED, S.unmapped ?? []); // the box lists only unclaimed files that touch a part
  return (derived = { S, byPart, importers, edges: new Map() });
}
const filesOf = (id) => derive().byPart.get(id) ?? [];
const importersOf = (rel) => derive().importers.get(rel) ?? [];
function edgeImports(e) {
  const d = derive(), k = edgeKey(e);
  if (!d.edges.has(k)) {
    const list = [];
    for (const [file, f] of Object.entries(S.files ?? {})) {
      const from = f.part ?? UNMAPPED;
      if (from !== e.from) continue;
      for (const i of f.imports) if ((i.to ?? UNMAPPED) === e.to && from !== e.to) list.push({ file, line: i.line, spec: i.spec, target: i.target });
    }
    d.edges.set(k, list);
  }
  return d.edges.get(k);
}

function partById(id) {
  if (id !== UNMAPPED) return S.parts.find((p) => p.id === id);
  return { id, label: 'Unmapped files', description: 'Talk to your parts, but no part claims them', paths: [], uses: [], violations: 0, fileCount: S.unmapped?.length ?? 0 };
}
const countOf = (id) => partById(id)?.fileCount ?? filesOf(id).length;

/** "apps/web/src/ui/Button.tsx" in part "apps/web/src" -> "ui/Button.tsx". */
function relName(id, rel) {
  const base = (partById(id)?.paths ?? []).filter((p) => rel.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0];
  return base ? rel.slice(base.length + 1) : rel;
}

// ------------------------------------------------------------------ layout

function sizeOf(id) {
  if (!expanded.has(id)) return { w: W, h: H };
  const n = filesOf(id).length;
  return { w: XW, h: H + Math.min(n, MAX_ROWS) * ROW + (n > MAX_ROWS ? MORE : 0) + 8 };
}
const fitSig = () => JSON.stringify(S.parts.map((p) => [p.id, p.uses]));
const layoutSig = () => JSON.stringify([
  fitSig(), !!S.unmapped,
  [...expanded].filter((id) => id !== UNMAPPED || S.unmapped).map((id) => [id, sizeOf(id).h]),
  allEdges().map(edgeKey).sort(),
]);

/**
 * Layered layout from the *rules* (rows and order never depend on live imports, so boxes don't jump while
 * code changes), then orthogonal edge routing: each edge leaves its box through its own port, runs along a
 * track in the gap between rows, and crosses rows only through the free channels between boxes.
 */
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
  const size = new Map(filled.flat().map((id) => [id, sizeOf(id)]));

  // Order each row by the average position of its neighbours to cut down crossings.
  const nb = new Map([...ids, UNMAPPED].map((id) => [id, []]));
  for (const p of S.parts) for (const u of p.uses) { nb.get(p.id).push(u); nb.get(u).push(p.id); }
  const cx = new Map();
  const place = () => filled.forEach((row) => {
    let x = -(row.reduce((s, id) => s + size.get(id).w, 0) + GAP_X * (row.length - 1)) / 2;
    for (const id of row) { cx.set(id, x + size.get(id).w / 2); x += size.get(id).w + GAP_X; }
  });
  place();
  for (let pass = 0; pass < 8; pass++) {
    for (const row of filled) {
      const bary = new Map(row.map((id) => {
        const xs = nb.get(id).filter((n) => cx.has(n)).map((n) => cx.get(n));
        return [id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : cx.get(id)];
      }));
      row.sort((a, b) => bary.get(a) - bary.get(b));
    }
    place();
  }

  const left = Math.min(...filled.map((r) => cx.get(r[0]) - size.get(r[0]).w / 2));
  const right = Math.max(...filled.map((r) => cx.get(r.at(-1)) + size.get(r.at(-1)).w / 2));
  const pos = new Map();
  filled.forEach((row, r) => row.forEach((id) => {
    const { w, h } = size.get(id);
    const x = cx.get(id) - w / 2 - left + PAD;
    pos.set(id, { id, x, y: 0, w, h, cx: x + w / 2, rank: r });
  }));
  const rowH = filled.map((row) => Math.max(...row.map((id) => size.get(id).h)));

  const { routes, tracks } = planEdges(allEdges(), pos, filled);
  // Gap g sits above row g. Each is as tall as its tracks need. While scrubbing history gaps never
  // shrink, so the boxes don't bounce from commit to commit.
  const keep = past() && geo && geo.fit === fitSig() && geo.rows.length === filled.length ? geo.gapH : null;
  const gapH = [];
  for (let g = 0; g <= filled.length; g++) {
    const t = tracks.get(g) ?? 0;
    const need = t ? GAP_PAD + (t - 1) * TRACK + FLAG_ROOM : 0;
    gapH[g] = Math.max(g === 0 || g === filled.length ? PAD : MIN_GAP, need, keep?.[g] ?? 0);
  }
  const rowTop = [];
  let y = gapH[0];
  filled.forEach((_, r) => { rowTop[r] = y; y += rowH[r] + gapH[r + 1]; });
  for (const n of pos.values()) n.y = rowTop[n.rank];
  const gapTop = (g) => (g === 0 ? 0 : rowTop[g - 1] + rowH[g - 1]);
  const trackY = (s) => gapTop(s.g) + Math.max(GAP_PAD, (gapH[s.g] - FLAG_ROOM + GAP_PAD - ((tracks.get(s.g) ?? 1) - 1) * TRACK) / 2) + s.track * TRACK;
  const paths = new Map(routes.map((r) => [edgeKey(r.e), drawRoute(r, trackY)]));

  return { pos, rows: filled, rowTop, rowH, gapH, paths, w: right - left + PAD * 2, h: y, sig: layoutSig(), fit: fitSig() };
}

/** Where each edge leaves and enters, which channel it uses to cross rows, and its horizontal runs per gap. */
function planEdges(edges, pos, rows) {
  const routes = [], ends = new Map(), lanes = [];
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b || a === b) continue;
    const type = b.rank > a.rank ? 'down' : b.rank < a.rank ? 'up' : 'same';
    const r = { e, a, b, type, ch: Math.abs(b.rank - a.rank) > 1 ? channel(a, b, pos, rows, lanes) : null, sx: a.cx, tx: b.cx };
    const end = (id, side, which, toward) => {
      const k = `${id}\n${side}`;
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ r, which, toward });
    };
    end(a.id, type === 'down' ? 'bottom' : 'top', 'sx', r.ch ?? b.cx);
    end(b.id, type === 'up' ? 'bottom' : 'top', 'tx', r.ch ?? a.cx);
    routes.push(r);
  }
  // Ports: spread a side's edges along it in the order they head off, so they don't cross at the box.
  for (const [k, list] of ends) {
    const n = pos.get(k.split('\n')[0]);
    list.sort((p, q) => p.toward - q.toward);
    const span = Math.min(n.w - 56, (list.length - 1) * 28);
    list.forEach((it, i) => { it.r[it.which] = n.cx + (list.length > 1 ? -span / 2 + (span * i) / (list.length - 1) : 0); });
  }
  // Horizontal runs. `tops`/`bots`: x where the edge's vertical parts join the run from above/below.
  const gaps = new Map();
  const run = (g, tops, bots) => {
    const xs = [...tops, ...bots];
    const s = { g, tops, bots, lo: Math.min(...xs), hi: Math.max(...xs), track: 0 };
    if (!gaps.has(g)) gaps.set(g, []);
    gaps.get(g).push(s);
    return s;
  };
  for (const r of routes) {
    const s = r.a.rank, t = r.b.rank, c = r.ch;
    if (r.type === 'same') r.runs = [run(s, [], [r.sx, r.tx])];
    else if (r.type === 'down') r.runs = c === null ? [run(s + 1, [r.sx], [r.tx])] : [run(s + 1, [r.sx], [c]), run(t, [c], [r.tx])];
    else r.runs = c === null ? [run(s, [r.tx], [r.sx])] : [run(s, [c], [r.sx]), run(t + 1, [r.tx], [c])];
  }
  const tracks = new Map();
  for (const [g, list] of gaps) tracks.set(g, assignTracks(list));
  return { routes, tracks };
}

/** An x where an edge can cross the rows between its two boxes without touching a box, near the straight line. */
function channel(a, b, pos, rows, lanes) {
  const lo = Math.min(a.rank, b.rank) + 1, hi = Math.max(a.rank, b.rank) - 1;
  const blocked = [];
  for (let k = lo; k <= hi; k++) for (const id of rows[k]) { const n = pos.get(id); blocked.push([n.x - M, n.x + n.w + M]); }
  blocked.sort((p, q) => p[0] - q[0]);
  const free = [];
  let edge = -Infinity;
  for (const [s, t] of blocked) { if (s > edge) free.push([edge, s]); edge = Math.max(edge, t); }
  free.push([edge, Infinity]);
  const ideal = (a.cx + b.cx) / 2;
  let best = null;
  for (const [s, t] of free) {
    const base = Math.min(Math.max(ideal, s), t);
    for (let k = 0; k < 16; k++) { // the closest free lane in this channel
      const x = base + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * LANE;
      if (x < s || x > t || lanes.some((l) => Math.abs(l.x - x) < LANE && l.lo <= hi && lo <= l.hi)) continue;
      if (!best || Math.abs(x - ideal) < Math.abs(best - ideal)) best = x;
      break;
    }
  }
  const x = best ?? ideal;
  lanes.push({ x, lo, hi });
  return x;
}

/**
 * Put each horizontal run of a gap on a track. Runs that overlap get different tracks, ordered so that
 * vertical parts cross as few other runs as possible; runs that don't overlap may share one.
 */
function assignTracks(list) {
  const inside = (x, s) => x > s.lo + 0.5 && x < s.hi - 0.5;
  const overlap = (p, q) => p.lo < q.hi + 8 && q.lo < p.hi + 8;
  const cost = (above, below) => below.tops.filter((x) => inside(x, above)).length + above.bots.filter((x) => inside(x, below)).length;
  const score = list.map((p) => list.reduce((acc, q) => (p === q ? acc : acc + cost(p, q) - cost(q, p)), 0));
  const order = list.map((_, i) => i).sort((i, j) => score[i] - score[j] || list[i].lo - list[j].lo);
  const used = [];
  const placed = [];
  for (const i of order) {
    const s = list[i];
    let t = 0;
    for (const p of placed) if (overlap(p, s) && cost(p, s) <= cost(s, p)) t = Math.max(t, p.track + 1);
    while (used[t]?.some((q) => overlap(q, s))) t++;
    (used[t] ??= []).push(s);
    s.track = t;
    placed.push(s);
  }
  return used.length;
}

function drawRoute(r, trackY) {
  const { a, b, sx, tx, ch } = r;
  const ys = r.runs.map(trackY);
  const start = r.type === 'down' ? a.y + a.h : a.y;
  const end = r.type === 'up' ? b.y + b.h + 2 : b.y - 2;
  const pts = ch === null
    ? [[sx, start], [sx, ys[0]], [tx, ys[0]], [tx, end]]
    : [[sx, start], [sx, ys[0]], [ch, ys[0]], [ch, ys[1]], [tx, ys[1]], [tx, end]];
  return { d: roundPath(pts), mid: labelSpot(pts) };
}

/** Polyline of right angles -> path with rounded corners. */
function roundPath(pts, R = 9) {
  const p = pts.filter((q, i) => i === 0 || Math.abs(q[0] - pts[i - 1][0]) > 0.5 || Math.abs(q[1] - pts[i - 1][1]) > 0.5);
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], [cx, cy] = p[i + 1];
    const ux = Math.sign(bx - ax), uy = Math.sign(by - ay), vx = Math.sign(cx - bx), vy = Math.sign(cy - by);
    if (ux === vx && uy === vy) { d += ` L${bx},${by}`; continue; }
    const r = Math.min(R, Math.hypot(bx - ax, by - ay) / 2, Math.hypot(cx - bx, cy - by) / 2);
    d += ` L${bx - ux * r},${by - uy * r} Q${bx},${by} ${bx + vx * r},${by + vy * r}`;
  }
  return d + ` L${p.at(-1)[0]},${p.at(-1)[1]}`;
}

/** The middle of the longest horizontal stretch (or of the longest stretch, if none): where a label reads best. */
function labelSpot(pts) {
  const segs = pts.slice(1).map((b, i) => [pts[i], b]);
  const len = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const flat = segs.filter(([a, b]) => a[1] === b[1] && len([a, b]) > 1);
  const [a, b] = (flat.length ? flat : segs).reduce((m, s) => (len(s) > len(m) ? s : m));
  return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
}

// ------------------------------------------------------------------ drawing

const ORDER = { removed: -1, planned: 0, unchecked: 1, allowed: 2, violation: 3 };

/** In the history view: is this edge new in the commit, or did its import count change? */
function edgeChange(e) {
  if (!past()) return null;
  const k = edgeKey(e), d = hist.data.edges;
  if (d.added.some((x) => edgeKey(x) === k)) return { added: true };
  const c = d.changed.find((x) => edgeKey(x) === k);
  return c ? { was: c.was } : null;
}

function drawEdges() {
  const edges = allEdges().sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  wires.setAttribute('width', geo.w);
  wires.setAttribute('height', geo.h);
  const marker = (k) => `<marker id="m-${k}" class="mk-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0.5 L10,5 L0,9.5 z"/></marker>`;
  const markers = [...Object.keys(ORDER), 'fw-out', 'fw-in', 'fw-bad'].map(marker).join('');
  wires.innerHTML = `<defs>${markers}</defs>` + edges.map((e) => {
    const key = edgeKey(e);
    const route = geo.paths.get(key);
    if (!route) return '';
    const { d, mid } = route;
    const ch = edgeChange(e);
    const width = e.kind === 'allowed' ? `--w:${(1.4 + Math.min(1.8, Math.log2(e.count) * 0.6)).toFixed(2)}` : '';
    let text = e.kind === 'violation' ? `✗ ${e.count}` : e.count ? String(e.count) : '';
    if (e.kind === 'removed') text = 'removed';
    else if (ch?.added) text = e.kind === 'violation' ? `✗ new · ${e.count}` : `new · ${e.count}`;
    else if (ch) text = `${e.kind === 'violation' ? '✗ ' : ''}${e.count} (${e.count > ch.was ? '+' : '−'}${Math.abs(e.count - ch.was)})`;
    const pill = text
      ? `<g class="elabel${ch ? ' is-new' : ''}" transform="translate(${mid.x},${mid.y})"><g><rect x="${-(text.length * 3.5 + 8)}" y="-9" width="${text.length * 7 + 16}" height="18" rx="9"/><text>${esc(text)}</text></g></g>`
      : '';
    const flash = active(fx.flash, key) || ch?.added ? ' flash' : '';
    return `<g class="edge k-${e.kind}${flash}" data-edge="${esc(key)}" style="${width}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#m-${e.kind})"/>${pill}</g>`;
  }).join('');
  applyFocus();
}

const statusWord = (s) => ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' })[s] ?? 'Changed';
const chevron = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function fileRow(id, rel) {
  const f = S.files?.[rel];
  const own = f?.part ?? UNMAPPED;
  const out = new Map(); // part -> { n, bad }
  for (const i of f?.imports ?? []) {
    const to = i.to ?? UNMAPPED;
    if (to === own) continue;
    const o = out.get(to) ?? { n: 0, bad: false };
    o.n++;
    o.bad ||= breaks(f.part, i.to);
    out.set(to, o);
  }
  const links = [...out].map(([to, o]) =>
    `<span class="f-link${o.bad ? ' bad' : ''}" style="--part:${colorOf(to)}" title="${o.bad ? 'Breaks the plan: imports' : 'Uses'} ${esc(labelOf(to))} (${plural(o.n, 'import')})">${o.bad ? '✗' : ''}</span>`).join('');
  const users = importersOf(rel).length;
  const ch = hist?.changes?.get(rel);
  const name = relName(id, rel), cut = name.lastIndexOf('/') + 1;
  return `<li><button type="button" class="f-row${ch ? ' changed' : ''}" data-file="${esc(rel)}" title="${esc(rel)}">
    <span class="f-top">${ch ? `<span class="f-st st-${ch.status}" title="${statusWord(ch.status)} in this commit">${ch.status}</span>` : ''}<span class="f-name"><span class="f-dir">${esc(name.slice(0, cut))}</span>${esc(name.slice(cut))}</span><span class="f-links">${links}${users ? `<span class="f-in" title="Imported by ${plural(users, 'file')}">used by ${users}</span>` : ''}</span></span>
    <span class="f-about${f?.about?.from === 'code' ? ' auto' : ''}">${md(f?.about?.text ?? (f ? '' : 'Not a source file'))}</span>
  </button></li>`;
}

function drawNodes() {
  if (!geo) return;
  for (const [id, el] of nodeEls) if (!geo.pos.has(id)) { el.remove(); nodeEls.delete(id); }
  const touched = new Map();
  if (past()) for (const f of hist.data.changes) if (f.part) touched.set(f.part, (touched.get(f.part) ?? 0) + 1);
  for (const [id, n] of geo.pos) {
    let el = nodeEls.get(id);
    if (!el) {
      el = Object.assign(document.createElement('div'), { className: 'node' });
      el.dataset.part = id;
      el.setAttribute('role', 'group');
      nodesEl.append(el);
      nodeEls.set(id, el);
    }
    const p = partById(id);
    const open = expanded.has(id);
    const count = countOf(id);
    const editing = !past() && active(fx.live, id), affected = !past() && active(fx.affected, id);
    Object.assign(el.style, { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` });
    el.style.setProperty('--part', colorOf(id));
    el.classList.toggle('open', open);
    el.classList.toggle('unmapped', id === UNMAPPED);
    el.classList.toggle('affected', !!affected && !editing);
    el.classList.toggle('touched', touched.has(id));
    el.setAttribute('aria-label', p.label);
    const flag = editing
      ? `<span class="n-flag">${editing.actor === 'agent' ? 'Claude is editing' : 'You edited'}</span>`
      : affected ? '<span class="n-flag affected">May be affected</span>'
      : '';
    const list = filesOf(id);
    el.innerHTML = `
      <button type="button" class="n-main" aria-label="${esc(`${p.label}: ${plural(count, 'file')}${p.violations ? `, ${plural(p.violations, 'rule break')}` : ''}`)}">
        <span class="n-title">${esc(p.label)}</span>
        <span class="n-desc">${esc(p.description)}</span>
        ${touched.has(id)
          ? `<span class="n-path n-changed">Changed here · ${plural(touched.get(id), 'file')}</span>`
          : `<span class="n-path">${esc(p.paths.map((x) => `${x}/`).join('  ') || 'not in al-dente.json')}</span>`}
      </button>
      <button type="button" class="n-toggle" data-toggle aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} the files in ${esc(p.label)}">${plural(count, 'file')}${chevron}</button>
      ${open ? `<ul class="n-files">${list.slice(0, MAX_ROWS).map((rel) => fileRow(id, rel)).join('')}</ul>` : ''}
      ${open && list.length > MAX_ROWS ? `<button type="button" class="f-more" data-more>+${list.length - MAX_ROWS} more files: see the side panel</button>` : ''}
      ${p.violations ? `<span class="n-bad" title="${breaking(p.violations)}">✗ ${p.violations}</span>` : ''}
      ${flag}`;
  }
}

/** Dim everything that isn't connected to what you're hovering or have selected. */
function applyFocus() {
  if (!geo) return;
  const f = hover ?? sel;
  let parts = null, edges = null, files = null;
  if (f?.type === 'part') {
    parts = new Set([f.id]);
    edges = new Set();
    for (const e of allEdges()) if (e.from === f.id || e.to === f.id) { edges.add(edgeKey(e)); parts.add(e.from); parts.add(e.to); }
  } else if (f?.type === 'edge') {
    const e = findEdge(f.id);
    if (e) {
      parts = new Set([e.from, e.to]);
      edges = new Set([f.id]);
      files = new Set(edgeImports(e).flatMap((i) => [i.file, i.target]));
    }
  } else if (f?.type === 'file') {
    const own = partOfFile(f.id);
    parts = new Set([own]);
    edges = new Set();
    files = new Set([f.id]);
    for (const i of S.files?.[f.id]?.imports ?? []) {
      const to = i.to ?? UNMAPPED;
      parts.add(to);
      files.add(i.target);
      if (to !== own) edges.add(`${own}>${to}`);
    }
    for (const u of importersOf(f.id)) {
      const from = partOfFile(u.file);
      parts.add(from);
      files.add(u.file);
      if (from !== own) edges.add(`${from}>${own}`);
    }
  }
  for (const [id, el] of nodeEls) {
    el.classList.toggle('dim', !!parts && !parts.has(id));
    el.classList.toggle('sel', sel?.type === 'part' && sel.id === id);
  }
  for (const row of nodesEl.querySelectorAll('.f-row')) {
    row.classList.toggle('focus', f?.type === 'file' && row.dataset.file === f.id);
    row.classList.toggle('sel', sel?.type === 'file' && row.dataset.file === sel.id);
    row.classList.toggle('dim', !!files && !files.has(row.dataset.file));
  }
  for (const g of wires.querySelectorAll('.edge')) {
    g.classList.toggle('dim', !!edges && !edges.has(g.dataset.edge));
    g.classList.toggle('hot', !!edges && edges.has(g.dataset.edge));
  }
  drawFileWires(f?.type === 'file' ? f.id : null);
}

/** Where a file sits on the map: its row if its part is open, otherwise its part's box. */
function anchorOf(rel, hint) {
  const part = partOfFile(rel, hint);
  const n = geo.pos.get(part);
  if (!n) return null;
  const row = expanded.has(part) ? nodeEls.get(part)?.querySelector(`[data-file="${CSS.escape(rel)}"]`) : null;
  return { n, y: row ? n.y + row.offsetTop + row.offsetHeight / 2 : n.y + H / 2 };
}

function curve(a, b, cls) {
  let d;
  const stacked = Math.abs(b.n.cx - a.n.cx) < (a.n.w + b.n.w) / 2; // same box, or boxes above each other: loop out on the right
  if (stacked) {
    const sx = a.n.x + a.n.w, ex = b.n.x + b.n.w + 4;
    const bulge = Math.max(sx, ex) + 30 + Math.min(110, Math.abs(b.y - a.y) * 0.18);
    d = `M${sx},${a.y} C${bulge},${a.y} ${bulge},${b.y} ${ex},${b.y}`;
  } else {
    const right = b.n.cx > a.n.cx;
    const sx = right ? a.n.x + a.n.w : a.n.x, ex = right ? b.n.x - 4 : b.n.x + b.n.w + 4;
    const dx = Math.max(40, Math.abs(ex - sx) / 2) * (right ? 1 : -1);
    d = `M${sx},${a.y} C${sx + dx},${a.y} ${ex - dx},${b.y} ${ex},${b.y}`;
  }
  return `<path class="fw fw-${cls}" d="${d}" marker-end="url(#m-fw-${cls})"/>`;
}

/** File-level lines for the focused file: what it imports (solid) and who imports it (dashed). */
function drawFileWires(rel) {
  wires.querySelector('.fwires')?.remove();
  if (!rel || !geo) return;
  const me = anchorOf(rel);
  if (!me) return;
  const own = S.files?.[rel]?.part;
  const lines = [], seen = new Set();
  for (const i of S.files?.[rel]?.imports ?? []) {
    if (seen.has(i.target)) continue;
    seen.add(i.target);
    const to = anchorOf(i.target, i.to);
    if (to) lines.push(curve(me, to, breaks(own, i.to) ? 'bad' : 'out'));
  }
  for (const u of importersOf(rel)) {
    const from = anchorOf(u.file);
    if (from) lines.push(curve(from, me, breaks(S.files[u.file]?.part, own) ? 'bad' : 'in'));
  }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'fwires');
  g.innerHTML = lines.join('');
  wires.append(g);
}

// ------------------------------------------------------------------ side panel

const edgeRow = (e) => `<li><button type="button" class="row" data-edge="${esc(edgeKey(e))}">${e.kind === 'violation' ? '<span class="x">✗</span>' : ''}<span class="grow">${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</span><span class="meta">${plural(e.count, 'import')}</span></button></li>`;
const closeBtn = '<button type="button" class="close" data-close aria-label="Close">×</button>';
const partChip = (pid, meta = '', cls = '') => `<button type="button" class="chip ${cls}" data-part="${esc(pid)}" style="--part:${colorOf(pid)}">${esc(labelOf(pid))}${meta ? `<small>${esc(meta)}</small>` : ''}</button>`;

let helpSeen = false;
try { helpSeen = localStorage.getItem('al-dente-help') === 'seen'; } catch { /* storage blocked */ }

/** Nothing selected: the state of the architecture at a glance. */
function overview() {
  const bad = S.edges.filter((e) => e.kind === 'violation');
  const links = (id, dir) => new Set(S.edges.filter((e) => e.kind !== 'unchecked' && (dir === 'out' ? e.from === id : e.to === id)).map((e) => (dir === 'out' ? e.to : e.from))).size;
  const parts = S.parts.map((p) => `<li><button type="button" class="row" data-part="${esc(p.id)}">
      <span class="dot" style="--part:${colorOf(p.id)}"></span><span class="grow">${esc(p.label)}</span>
      <span class="meta">${plural(p.fileCount, 'file')} · uses ${links(p.id, 'out')} · used by ${links(p.id, 'in')}</span>
      ${p.violations ? `<span class="x" title="${breaking(p.violations)}">✗ ${p.violations}</span>` : ''}</button></li>`).join('');
  const unmapped = S.unmapped ?? [];
  return `<h2>Architecture${past() ? ` <small class="when">at ${esc(hist.data.commit.hash.slice(0, 7))}</small>` : ''}</h2>
    ${bad.length
      ? `<span class="verdict bad"><i>✗</i> ${breaking(S.violations)}</span><h3>Rule breaks</h3><ul class="rows">${bad.map(edgeRow).join('')}</ul>`
      : '<span class="verdict good"><i>✓</i> Every import follows the plan</span>'}
    <h3>Parts · ${S.parts.length}</h3>
    <ul class="rows">${parts}</ul>
    ${unmapped.length ? `<h3>Not in any part · ${unmapped.length}</h3>
      <p>These files talk to your parts, but no part claims them, so they aren't checked. Add their folders to <code>al-dente.json</code>.</p>
      <ul class="rows">${unmapped.slice(0, 6).map((rel) => `<li><button type="button" class="row" ${S.files?.[rel] ? `data-file="${esc(rel)}"` : 'disabled'}><code class="grow">${esc(rel)}</code></button></li>`).join('')}</ul>
      ${unmapped.length > 6 ? `<p>and ${unmapped.length - 6} more</p>` : ''}` : ''}
    <details class="help"${helpSeen ? '' : ' open'}><summary>How to read the map</summary>
      <ul class="howto">
        <li>Each box is a part of your app from <code>al-dente.json</code>. Arrows point from the part that imports to the part it uses; dashed ones are allowed but not used yet.</li>
        <li>Click <b>N files</b> on a box to open it, then hover a file to see exactly what it imports and who imports it.</li>
        <li><b>History</b> scrubs through merged PRs and commits: when did a rule break first appear, and what did each PR change?</li>
      </ul>
    </details>
    ${S.ignore?.length ? `<p class="hint">Not part of the architecture: ${S.ignore.slice(0, 4).map((g) => `<code>${esc(g)}</code>`).join(' ')}${S.ignore.length > 4 ? ' …' : ''} (the <code>ignore</code> list in al-dente.json).</p>` : ''}`;
}

function partDetails(id) {
  const p = partById(id);
  const out = S.edges.filter((e) => e.from === id), inc = S.edges.filter((e) => e.to === id);
  const badFiles = new Set(out.filter((e) => e.kind === 'violation').flatMap((e) => edgeImports(e).map((i) => i.file)));
  const uses = p.uses.map((u) => {
    const e = out.find((x) => x.to === u);
    return partChip(u, e ? plural(e.count, 'import') : 'not used yet', e ? '' : 'unused');
  }).join('');
  const extra = out.filter((e) => e.kind !== 'allowed');
  const verdict = id === UNMAPPED ? '<p>Add these folders to a part in <code>al-dente.json</code> so they get checked too.</p>'
    : p.violations ? `<span class="verdict bad"><i>✗</i> ${breaking(p.violations)}</span>`
    : '<span class="verdict good"><i>✓</i> Follows the plan</span>';
  const list = filesOf(id);
  const file = (rel) => {
    const about = S.files?.[rel]?.about;
    return `<li><button type="button" class="row file" ${S.files?.[rel] ? `data-file="${esc(rel)}"` : 'disabled'}>${badFiles.has(rel) ? '<span class="x">✗</span>' : ''}<span class="grow"><code>${esc(relName(id, rel))}</code>${about ? `<small class="${about.from === 'code' ? 'auto' : ''}">${md(about.text)}</small>` : ''}</span></button></li>`;
  };
  return `
    <div class="d-title" style="--part:${colorOf(id)}"><span class="swatch"></span><h2>${esc(p.label)}</h2>${closeBtn}</div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ''}
    ${verdict}
    ${id === UNMAPPED ? '' : `<h3>Allowed to use</h3>${uses ? `<div class="chips">${uses}</div>` : '<p>Nothing. This part stands on its own.</p>'}`}
    ${extra.length ? `<h3>Also imports</h3><ul class="rows">${extra.map(edgeRow).join('')}</ul>` : ''}
    <h3>Used by</h3>${inc.length ? `<ul class="rows">${inc.map(edgeRow).join('')}</ul>` : '<p>No other part imports it.</p>'}
    <h3 class="h-row">${plural(list.length, 'file')}<button type="button" class="link" data-toggle-part="${esc(id)}">${expanded.has(id) ? 'Hide on map' : 'Show on map'}</button></h3>
    <ul class="rows files">${list.slice(0, 200).map(file).join('')}</ul>
    ${list.length > 200 ? `<p>and ${list.length - 200} more</p>` : ''}`;
}

function fileDetails(rel) {
  const f = S.files?.[rel];
  const part = f?.part ?? UNMAPPED;
  const cut = rel.lastIndexOf('/') + 1;
  const imps = f?.imports ?? [];
  const bad = imps.filter((i) => breaks(f.part, i.to));
  const groups = new Map();
  for (const i of imps) { const k = i.to ?? UNMAPPED; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const inside = groups.get(part);
  groups.delete(part);
  const impRow = (i) => `<li><button type="button" class="row" ${S.files?.[i.target] ? `data-file="${esc(i.target)}"` : 'disabled'}>${breaks(f.part, i.to) ? '<span class="x">✗</span>' : ''}<code class="grow" title="${esc(`"${i.spec}" → ${i.target}`)}">${esc(i.target)}</code><span class="meta">line ${i.line}</span></button></li>`;
  const group = (pid, list, title) => `<div class="grp"><div class="grp-h" style="--part:${colorOf(pid)}"><span class="swatch"></span>${title}</div><ul class="rows">${list.map(impRow).join('')}</ul></div>`;
  const users = importersOf(rel);
  const ch = hist?.changes?.get(rel);
  const about = f?.about;
  return `
    <div class="d-title" style="--part:${colorOf(part)}"><span class="swatch"></span><h2>${esc(rel.slice(cut))}</h2>${closeBtn}</div>
    <code class="d-path">${esc(rel)}</code>
    <p class="about">${md(about?.text ?? 'Not a source file al-dente reads.')}</p>
    ${about?.from === 'code' ? '<p class="hint">Summarised from the code. A doc comment at the top of the file replaces this with your own words.</p>' : ''}
    <div class="chips">${partChip(part, 'part')}</div>
    ${part === UNMAPPED ? '<p>No part claims this file, so its imports aren\'t checked.</p>'
      : bad.length ? `<span class="verdict bad"><i>✗</i> ${breaking(bad.length)}</span>` : '<span class="verdict good"><i>✓</i> Fits the plan</span>'}
    ${ch ? `<h3>In this commit</h3>${changeNotes(ch, true)}` : ''}
    ${about?.exports?.length ? `<h3>Exports</h3><div class="exports">${about.exports.slice(0, 24).map((x) => `<code>${esc(x)}</code>`).join('')}${about.exports.length > 24 ? ` <small>+${about.exports.length - 24} more</small>` : ''}</div>` : ''}
    <h3>Imports${imps.length ? ` · ${imps.length}` : ''}</h3>
    ${imps.length
      ? [...groups].map(([pid, list]) => group(pid, list, `${esc(labelOf(pid))}${breaks(f.part, pid) ? ' <span class="x">✗ not allowed by the plan</span>' : ''}`)).join('')
        + (inside ? group(part, inside, `Inside ${esc(labelOf(part))}`) : '')
      : '<p>Imports nothing from this project.</p>'}
    <h3>Imported by${users.length ? ` · ${users.length}` : ''}</h3>
    ${users.length
      ? `<ul class="rows">${users.map((u) => `<li><button type="button" class="row" data-file="${esc(u.file)}">${breaks(S.files[u.file]?.part, f?.part) ? '<span class="x">✗</span>' : `<span class="dot" style="--part:${colorOf(partOfFile(u.file))}"></span>`}<code class="grow">${esc(u.file)}</code><span class="meta">line ${u.line}</span></button></li>`).join('')}</ul>`
      : '<p>No file in this project imports it.</p>'}`;
}

function edgeDetails(e) {
  const from = e.from === UNMAPPED ? null : partById(e.from);
  const may = from?.uses.length ? from.uses.map(labelOf).map(esc).join(', ') : 'nothing outside itself';
  const verdict = {
    allowed: '<span class="verdict good"><i>✓</i> Allowed by the plan</span>',
    planned: '<span class="verdict"><i>○</i> Allowed by the plan, not used yet</span>',
    violation: `<span class="verdict bad"><i>✗</i> Breaks the plan</span><p>${esc(from?.label)} may only use: ${may}.</p>`,
    unchecked: '<span class="verdict"><i>?</i> Not checked: involves files no part claims</span>',
    removed: `<span class="verdict"><i>−</i> Removed in this commit</span><p>The parent commit had ${plural(e.count, 'import')} here.</p>`,
  }[e.kind];
  const imps = e.kind === 'removed' || e.kind === 'planned' ? [] : edgeImports(e);
  const list = imps.slice(0, 200).map((i) => `<li><button type="button" class="imp" data-file="${esc(i.file)}"><code>${esc(i.file)}:${i.line}</code><code class="to">"${esc(i.spec)}" → ${esc(i.target)}</code></button></li>`).join('');
  return `
    <div class="d-title"><h2>${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</h2>${closeBtn}</div>
    ${verdict}
    ${imps.length ? `<h3>${plural(imps.length, 'import')}</h3><ul class="rows imports">${list}</ul>` : ''}
    ${imps.length > 200 ? `<p>and ${imps.length - 200} more</p>` : ''}`;
}

function renderDetails() {
  if (!S || S.missing || S.error) return void (detailsEl.innerHTML = '');
  const edge = sel?.type === 'edge' && findEdge(sel.id);
  if (sel?.type === 'part' && geo?.pos.has(sel.id)) detailsEl.innerHTML = partDetails(sel.id);
  else if (sel?.type === 'file' && (S.files?.[sel.id] || S.unmapped?.includes(sel.id))) detailsEl.innerHTML = fileDetails(sel.id);
  else if (edge) detailsEl.innerHTML = edgeDetails(edge);
  else { sel = null; detailsEl.innerHTML = overview(); }
}

function select(s) {
  sel = s;
  applyFocus();
  renderDetails();
}

/** Select a file, opening its part on the map so you can see it. */
function selectFile(rel) {
  const part = partOfFile(rel);
  if (geo?.pos.has(part) && !expanded.has(part)) setExpanded(part, true);
  select({ type: 'file', id: rel });
  reveal(part);
}

// ------------------------------------------------------------------ opening parts

const openKey = () => `al-dente-open:${live?.project ?? ''}`;
function saveExpanded() { try { localStorage.setItem(openKey(), JSON.stringify([...expanded])); } catch { /* storage blocked */ } }
function loadExpanded() { try { expanded = new Set(JSON.parse(localStorage.getItem(openKey()) ?? '[]')); } catch { expanded = new Set(); } }

function setExpanded(id, open) {
  if (open) expanded.add(id); else expanded.delete(id);
  saveExpanded();
  relayout(id);
  renderDetails();
}

/** Re-run the layout but keep `anchorId`'s box where it is on screen, so the map doesn't jump under the cursor. */
function relayout(anchorId) {
  const before = anchorId && geo?.pos.get(anchorId);
  geo = layout();
  drawNodes();
  drawEdges();
  const after = anchorId && geo.pos.get(anchorId);
  if (before && after) setView(view.x + (before.x - after.x) * view.k, view.y + (before.y - after.y) * view.k, view.k);
}

/** Pan just enough to bring a part's box into view. */
function reveal(id) {
  const n = geo?.pos.get(id);
  if (!n) return;
  const r = stage.getBoundingClientRect();
  const x = view.x + n.x * view.k, y = view.y + n.y * view.k;
  const visible = x < r.width - 40 && x + n.w * view.k > 40 && y < r.height - 40 && y + Math.min(n.h, 300) * view.k > 40;
  if (!visible) setView(r.width / 2 - (n.x + n.w / 2) * view.k, 80 - n.y * view.k, view.k);
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
  if (a.ignored) tags.push('<span class="tag">Test or ignored file · not checked</span>');
  for (const v of a.broke) tags.push(`<span class="tag bad"><i>✗</i>${esc(labelOf(a.part))} → ${esc(labelOf(v.to))} not allowed · line ${v.line}</span>`);
  for (const v of a.fixed) tags.push(`<span class="tag good"><i>✓</i>Fixed ${esc(labelOf(a.part))} → ${esc(labelOf(v.to))}</span>`);
  if (a.part && !a.ignored && a.kind !== 'deleted' && !a.broke.length && !a.fixed.length) {
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
  if (past() || !geo || !a.part || !geo.pos.has(a.part)) return;
  const now = Date.now();
  fx.live.set(a.part, { until: now + FX_MS, actor: a.actor });
  for (const id of a.affected) fx.affected.set(id, { until: now + FX_MS });
  for (const to of a.links) fx.flash.set(`${a.part}>${to}`, { until: now + FLASH_MS });
  drawNodes();
  drawEdges();
  pulse(a.part);
  setTimeout(() => { if (!past()) { drawNodes(); drawEdges(); } }, FX_MS + 50);
}

// ------------------------------------------------------------------ history (git timeline)

function when(t) {
  const days = (Date.now() - t) / 864e5;
  if (days < 1) return ago(t);
  if (days < 7) return `${Math.floor(days)}d ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

let loadTimer = 0, driftTimer = 0;

async function loadLog() {
  const all = hist?.all ?? false;
  const keep = past() ? hist.data.commit.hash : null;
  let j;
  try { j = await (await fetch(`/api/history${all ? '?all=1' : ''}`)).json(); }
  catch { $('#tl-caption').textContent = 'Could not read the git history.'; return; }
  if (j.error) { $('#tl-caption').textContent = j.error; return; }
  const commits = j.commits.slice().reverse();
  const sameMode = hist?.all === all;
  hist = {
    all, commits, branch: j.branch, web: j.web, index: commits.length,
    data: hist?.data ?? null, changes: hist?.changes ?? null,
    drift: sameMode ? hist.drift : new Map(), driftDone: false, driftTotal: commits.length,
  };
  for (const b of timelineEl.querySelectorAll('[data-all]')) b.setAttribute('aria-pressed', String((b.dataset.all === '1') === all));
  range.max = String(commits.length);
  $('#tl-first').textContent = commits.length ? when(commits[0].time) : '';
  const at = keep ? commits.findIndex((c) => c.hash === keep) : -1;
  setIndex(at >= 0 ? at : commits.length);
  pollDrift();
}

/** Rule breaks over the whole history, computed by the server in the background; collect what's ready. */
async function pollDrift() {
  clearTimeout(driftTimer);
  if (!hist || timelineEl.hidden) return;
  const mode = hist.all;
  let j;
  try { j = await (await fetch(`/api/drift${mode ? '?all=1' : ''}`)).json(); } catch { return; }
  if (!hist || hist.all !== mode) return;
  for (const p of j.points ?? []) hist.drift.set(p.hash, p);
  if (j.stats) for (const c of hist.commits) { const s = j.stats[c.hash]; if (s) [c.files, c.add, c.del] = s; }
  hist.driftDone = !!j.done;
  hist.driftTotal = j.total ?? hist.commits.length;
  drawChart();
  if (!j.done) driftTimer = setTimeout(pollDrift, 700);
}

/** Track geometry shared by the chart, the ticks and the range thumb (16px wide). */
const tlX = (i, w) => 8 + (hist.commits.length ? i / hist.commits.length : 1) * (w - 16);

function drawChart() {
  const svg = $('#tl-chart');
  const w = svg.clientWidth, h = svg.clientHeight;
  if (!hist || !w) return;
  const n = hist.commits.length;
  const band = h - 20, base = h - 1; // drift band on top, ticks below it
  const known = hist.commits.map((c, i) => [i, hist.drift.get(c.hash)]).filter(([, p]) => p);
  const maxV = Math.max(4, ...known.map(([, p]) => p.v)); // a floor, so one break isn't a wall of red
  const maxL = Math.max(1, ...known.map(([, p]) => p.links));
  const yV = (v) => 2 + band - (v / maxV) * (band - 4);
  const yL = (l) => 2 + band - (l / maxL) * (band - 4);
  let area = '', line = '', top = '';
  for (let k = 0; k < known.length; k++) {
    const [i, p] = known[k];
    const x0 = tlX(i, w), x1 = tlX(i + 1, w);
    const startRun = k === 0 || known[k - 1][0] !== i - 1;
    area += `${startRun ? `M${x0},${2 + band}` : ''} L${x0},${yV(p.v)} L${x1},${yV(p.v)}${k === known.length - 1 || known[k + 1][0] !== i + 1 ? ` L${x1},${2 + band} Z` : ''}`;
    line += `${startRun ? 'M' : ' L'}${x0},${yL(p.links)} L${x1},${yL(p.links)}`;
    top += `${startRun ? 'M' : ' L'}${x0},${yV(p.v)} L${x1},${yV(p.v)}`;
  }
  const max = Math.max(1, ...hist.commits.map((c) => (c.add ?? 0) + (c.del ?? 0)));
  const ticks = hist.commits.map((c, i) => {
    const p = hist.drift.get(c.hash);
    const cls = !p ? '' : p.dv > 0 ? 'up' : p.dv < 0 ? 'down' : p.added || p.removed ? 'arch' : '';
    const th = 3 + 13 * (Math.log1p((c.add ?? 0) + (c.del ?? 0)) / Math.log1p(max));
    const big = c.pr || c.parents.length > 1;
    return `<rect class="tk ${cls}${big ? ' pr' : ''}${i === hist.index ? ' on' : ''}" x="${tlX(i, w) - (big ? 1.5 : 1)}" y="${base - th}" width="${big ? 3 : 2}" height="${th}" rx="1"/>`;
  }).join('');
  const marks = known.filter(([, p]) => p.dv).map(([i, p]) => `<circle class="mk ${p.dv > 0 ? 'up' : 'down'}" cx="${tlX(i, w)}" cy="${yV(p.v)}" r="3"/>`).join('');
  svg.innerHTML = `<path class="d-area" d="${area}"/><path class="d-top" d="${top}"/><path class="d-line" d="${line}"/>${marks}<line class="d-base" x1="0" x2="${w}" y1="${base + 0.5}" y2="${base + 0.5}"/>${ticks}<circle class="now${hist.index === n ? ' on' : ''}" cx="${tlX(n, w)}" cy="${base - 4}" r="4"/>`;
  const introduced = known.filter(([, p]) => p.dv > 0).length, fixed = known.filter(([, p]) => p.dv < 0).length;
  $('#tl-status').innerHTML = !hist.driftDone
    ? `Checking history against the plan… ${known.length}/${hist.driftTotal}`
    : introduced || fixed
      ? `<span class="up"><i>✗</i> ${plural(introduced, 'commit')} introduced rule breaks</span>${fixed ? ` · <span class="down"><i>✓</i> ${fixed} fixed some</span>` : ''}`
      : 'No commit introduced a rule break';
}

function renderCaption() {
  const el = $('#tl-caption');
  const n = hist.commits.length;
  if (hist.index >= n) {
    el.innerHTML = `<b>Now</b><span>your working tree${hist.branch ? ` on <code>${esc(hist.branch)}</code>` : ''} · ${plural(n, hist.all ? 'commit' : 'step')} of history to the left</span>`;
  } else {
    const c = hist.commits[hist.index];
    const tag = c.pr ? `<span class="pill">#${c.pr}</span>` : c.parents.length > 1 ? '<span class="pill">merge</span>' : '';
    el.innerHTML = `${tag}<b title="${esc(c.title)}">${esc(c.title)}</b><span>${c.hash.slice(0, 7)} · ${esc(c.author)} · ${when(c.time)}</span>`;
  }
  $('#tl-live').disabled = hist.index >= n;
}

function setIndex(i) {
  const n = hist.commits.length;
  hist.index = Math.max(0, Math.min(n, i));
  range.value = String(hist.index);
  renderCaption();
  drawChart();
  clearTimeout(loadTimer);
  if (hist.index >= n) return showLive();
  const c = hist.commits[hist.index];
  if (commitCache.has(c.hash)) return showCommit(commitCache.get(c.hash));
  timelineEl.classList.add('loading');
  loadTimer = setTimeout(async () => {
    let data;
    try { data = await (await fetch(`/api/commit?rev=${c.hash}`)).json(); } catch { data = { error: 'The map server stopped.' }; }
    timelineEl.classList.remove('loading');
    if (data.error) { $('#tl-caption').textContent = data.error; return; }
    if (commitCache.size > 12) commitCache.delete(commitCache.keys().next().value);
    commitCache.set(c.hash, data);
    if (hist.commits[hist.index]?.hash === c.hash) showCommit(data);
  }, 70);
}

function showCommit(data) {
  timelineEl.classList.remove('loading');
  hist.data = data;
  hist.changes = new Map(data.changes.map((f) => [f.path, f]));
  S = data.graph;
  render();
  renderCommit();
}

function showLive() {
  if (hist) { hist.data = null; hist.changes = null; }
  if (live) { S = { ...live, files: index }; render(); }
  renderCommit();
}

function openTimeline(open) {
  timelineEl.hidden = !open;
  $('#history-btn').setAttribute('aria-pressed', String(open));
  if (open) loadLog();
  else { clearTimeout(driftTimer); if (hist) hist.index = hist.commits.length; showLive(); }
}

function showTlTip(ev) {
  if (!hist) return;
  const r = range.getBoundingClientRect();
  const n = hist.commits.length;
  const i = Math.max(0, Math.min(n, Math.round(((ev.clientX - r.left - 8) / (r.width - 16)) * n)));
  const c = hist.commits[i];
  const p = c && hist.drift.get(c.hash);
  const drift = !c ? '' : !p ? '<div class="t-d">Checking…</div>' : `<div class="t-d">${
    p.dv > 0 ? `<span class="up"><i>✗</i> +${p.dv} rule break${p.dv === 1 ? '' : 's'}</span>` : p.dv < 0 ? `<span class="down"><i>✓</i> fixed ${-p.dv}</span>` : p.v ? `<span class="up"><i>✗</i> ${plural(p.v, 'rule break')}</span>` : '<span class="down"><i>✓</i> follows the plan</span>'
  } · ${plural(p.links, 'connection')}${p.added || p.removed ? ` (${p.added ? `+${p.added}` : ''}${p.added && p.removed ? ' ' : ''}${p.removed ? `−${p.removed}` : ''})` : ''}</div>`;
  tlTip.innerHTML = c
    ? `<b>${c.pr ? `#${c.pr} ` : ''}${esc(c.title)}</b><div class="t-m">${c.hash.slice(0, 7)} · ${esc(c.author)} · ${when(c.time)}${c.add || c.del ? ` · +${c.add} −${c.del}` : ''}</div>${drift}`
    : '<b>Now</b><div class="t-m">your working tree, live</div>';
  tlTip.hidden = false;
  const x = tlX(i, r.width);
  tlTip.style.left = `${Math.max(0, Math.min(r.width - tlTip.offsetWidth, x - tlTip.offsetWidth / 2))}px`;
}

/** What happened to one file in the commit, in words. */
function changeNotes(f, long) {
  const d = f.delta;
  const notes = [];
  if (long) notes.push(`${statusWord(f.status)}${f.old ? ` from <code>${esc(f.old)}</code>` : ''}${f.add !== null ? ` · +${f.add} −${f.del} lines` : ''}`);
  for (const v of d?.broke ?? []) notes.push(`<span class="bad"><i>✗</i> started importing ${esc(labelOf(v.to))} (line ${v.line}), which the plan doesn't allow</span>`);
  for (const v of d?.fixed ?? []) notes.push(`<span class="good"><i>✓</i> stopped importing ${esc(labelOf(v.to))}: rule break fixed</span>`);
  for (const p of d?.gained ?? []) if (!d.broke.some((v) => v.to === p)) notes.push(`now uses ${esc(labelOf(p))}`);
  for (const p of d?.lost ?? []) if (!d.fixed.some((v) => v.to === p)) notes.push(`no longer uses ${esc(labelOf(p))}`);
  return notes.length ? `<ul class="notes">${notes.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
}

function renderCommit() {
  const on = past();
  feedPanel.hidden = on;
  commitEl.hidden = !on;
  document.body.classList.toggle('past', on);
  if (!on) return;
  const { commit: c, changes, edges, violations: v } = hist.data;
  const add = changes.reduce((n, f) => n + (f.add ?? 0), 0), del = changes.reduce((n, f) => n + (f.del ?? 0), 0);
  const touched = [...new Set(changes.map((f) => f.part).filter(Boolean))];
  const verdict = v.after > v.before ? `<span class="verdict bad"><i>✗</i> Introduced ${plural(v.after - v.before, 'rule break')}</span>`
    : v.after < v.before ? `<span class="verdict good"><i>✓</i> Fixed ${plural(v.before - v.after, 'rule break')}</span>`
    : edges.added.length || edges.removed.length ? '<span class="verdict"><i>◆</i> Changed how parts connect</span>'
    : touched.length ? '<span class="verdict"><i>○</i> Same connections between parts</span>'
    : '<span class="verdict"><i>○</i> Didn\'t touch any part\'s code</span>';

  const conn = [
    ...edges.added.map((e) => ({ e, sign: '+', note: e.kind === 'violation' ? '✗ breaks the plan' : `new · ${plural(e.count, 'import')}` })),
    ...edges.removed.map((e) => ({ e, sign: '−', note: 'removed' })),
    ...edges.changed.map((e) => ({ e, sign: '~', note: `${e.was} → ${e.count} imports` })),
  ].map(({ e, sign, note }) => `<li><button type="button" class="row" data-edge="${esc(edgeKey(e))}"><span class="sign">${sign}</span><span class="grow">${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</span><span class="meta${e.kind === 'violation' ? ' bad' : ''}">${note}</span></button></li>`).join('');

  // Files grouped by part, in plan order; then unmapped source; then tests; then everything else.
  const order = [...S.parts.map((p) => p.id), UNMAPPED, '~ignored', ''];
  const groupOf = (f) => (f.part ?? (f.ignored ? '~ignored' : f.source ? UNMAPPED : ''));
  const title = (g) => (g === '~ignored' ? 'Tests and ignored files' : g ? esc(labelOf(g)) : 'Other files');
  const groups = order.map((g) => [g, changes.filter((f) => groupOf(f) === g)]).filter(([, list]) => list.length);
  const fileLi = (f) => {
    const there = !!S.files?.[f.path];
    const name = f.path.split('/').pop();
    return `<li><button type="button" class="row" ${there ? `data-file="${esc(f.path)}"` : 'disabled'} title="${esc(f.path)}"><span class="f-st st-${f.status}" title="${statusWord(f.status)}">${f.status}</span><span class="grow"><code>${esc(name)}</code><small>${esc(f.path.slice(0, -name.length))}</small></span><span class="meta">${f.add !== null ? `+${f.add} −${f.del}` : 'binary'}</span></button>${changeNotes(f, false)}</li>`;
  };
  const filesHtml = groups.map(([g, list]) => `<div class="grp"><div class="grp-h" style="--part:${g && g !== '~ignored' ? colorOf(g) : 'transparent'}">${g && g !== '~ignored' ? '<span class="swatch"></span>' : ''}${title(g)}<small>${list.length}</small></div><ul class="rows">${list.map(fileLi).join('')}</ul></div>`).join('');

  const meta = [
    c.prUrl ? `<a href="${esc(c.prUrl)}" target="_blank" rel="noopener">PR #${c.pr} ↗</a>` : c.pr ? `PR #${c.pr}` : '',
    c.branch ? `<code>${esc(c.branch)}</code>` : '',
    esc(c.author),
    `<time title="${esc(new Date(c.time).toLocaleString())}">${when(c.time)}</time>`,
  ].filter(Boolean).join(' · ');
  const body = c.pr ? c.body.split('\n').slice(1).join('\n').trim() : c.body;

  commitEl.innerHTML = `
    <header class="panel-head"><h2>${c.pr ? 'Pull request' : c.parents.length > 1 ? 'Merge' : 'Commit'}</h2>${c.url ? `<a class="hash" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.hash.slice(0, 7))} ↗</a>` : `<code class="hash">${esc(c.hash.slice(0, 7))}</code>`}</header>
    <div class="commit-body">
      <div class="c-title">${esc(c.title)}</div>
      <div class="c-meta">${meta}</div>
      <div class="c-stats">${plural(changes.length, 'file')} changed · +${add} −${del}${touched.length ? ` · ${plural(touched.length, 'part')}: ${touched.map((p) => `<span class="dot" style="--part:${colorOf(p)}"></span>${esc(labelOf(p))}`).join(', ')}` : ''}</div>
      ${verdict}
      ${conn ? `<h3>Connections between parts</h3><ul class="rows">${conn}</ul>` : ''}
      <h3>Files changed</h3>
      ${filesHtml || '<p>No files changed in this project folder.</p>'}
      ${body ? `<details class="c-msg"><summary>Full message</summary><pre>${esc(body)}</pre></details>` : ''}
      <p class="hint">Judged against today's <code>al-dente.json</code>, so you can see when a break first crept in.</p>
    </div>`;
}

// ------------------------------------------------------------------ top bar + empty states

function renderHeader() {
  const L = live;
  if (!L) return;
  $('#project').textContent = L.project ?? '';
  const h = $('#health');
  h.className = 'health';
  if (L.error) { h.classList.add('warn'); h.innerHTML = '<i>⚠</i> Plan has an error'; }
  else if (L.missing) h.innerHTML = '<i>○</i> No plan yet';
  else if (L.violations) { h.classList.add('bad'); h.innerHTML = `<i>✗</i> ${plural(L.violations, 'rule break')}`; }
  else { h.classList.add('good'); h.innerHTML = '<i>✓</i> Matches the plan'; }
  $('#stats').textContent = L.stats ? `${plural(L.stats.parts, 'part')} · ${plural(L.stats.files, 'file')} · ${plural(L.stats.imports, 'import')}` : '';
  $('#history-btn').hidden = !L.git || !!L.missing || !!L.error;
  document.title = L.violations ? `✗ ${L.violations} · al-dente` : `${L.project} · al-dente`;
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
  if (!geo || geo.fit !== fitSig()) {
    geo = layout();
    drawNodes();
    drawEdges();
    userMoved = false;
    fit();
  } else if (geo.sig !== layoutSig()) relayout(sel?.type === 'part' ? sel.id : sel?.type === 'file' ? partOfFile(sel.id) : null);
  else { drawNodes(); drawEdges(); }
  renderDetails();
}

// ------------------------------------------------------------------ pan & zoom

function setView(x, y, k) {
  Object.assign(view, { x, y, k });
  world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  world.style.setProperty('--k', String(k));
  world.classList.toggle('far', k < FAR); // zoomed out: titles only, sized to stay readable
  world.classList.toggle('mid', k < 0.8);  // a bit out: one line of description
  stage.style.backgroundPosition = `${x}px ${y}px`;
  stage.style.backgroundSize = `${22 * k}px ${22 * k}px`;
}

function fit() {
  if (!geo) return;
  const r = stage.getBoundingClientRect();
  const fitTo = (h) => {
    const k = Math.min(1.1, Math.max(0.2, Math.min(r.width / geo.w, h / geo.h)));
    setView((r.width - geo.w * k) / 2, (h - geo.h * k) / 2, k);
  };
  fitTo(r.height);
  // Shrink only if a box would end up under the legend in the bottom-left corner.
  const legend = $('.legend').getBoundingClientRect();
  const covered = legend.width > 0 && [...geo.pos.values()].some((n) =>
    r.left + view.x + n.x * view.k < legend.right + 12 && r.top + view.y + (n.y + n.h) * view.k > legend.top - 12);
  if (covered) fitTo(legend.top - r.top - 12);
}

function zoomAt(mx, my, factor) {
  const k = Math.min(2.5, Math.max(0.2, view.k * factor));
  setView(mx - ((mx - view.x) * k) / view.k, my - ((my - view.y) * k) / view.k, k);
  userMoved = true;
}

stage.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
}, { passive: false });

// Drag anywhere (boxes too) to pan; a press that doesn't move stays a click.
let drag = null;
stage.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || ev.target.closest('.hud, .empty-card')) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false, id: ev.pointerId };
});
stage.addEventListener('pointermove', (ev) => {
  if (drag) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) stage.setPointerCapture(drag.id); // capture only once it's a drag, so clicks still reach buttons
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
stage.addEventListener('pointerup', (ev) => {
  if (drag && !drag.moved && !ev.target.closest('.node, .edge')) select(null);
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
    removed: '− Removed in this commit',
  }[e.kind];
  const imps = e.kind === 'removed' || e.kind === 'planned' ? [] : edgeImports(e);
  const shown = imps.slice(0, 5);
  tip.innerHTML = `<h3>${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}</h3><div class="tip-k">${esc(head)}${e.count ? ` · ${plural(e.count, 'import')}` : ''}</div>
    ${shown.length ? `<ul>${shown.map((i) => `<li><code>${esc(i.file)}:${i.line}</code></li>`).join('')}</ul>` : ''}
    ${imps.length > shown.length ? `<div class="more">+${imps.length - shown.length} more · click for all</div>` : ''}`;
  tip.hidden = false;
  const r = stage.getBoundingClientRect();
  let x = ev.clientX - r.left + 16, y = ev.clientY - r.top + 16;
  if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 16;
  if (y + tip.offsetHeight > r.height - 8) y = ev.clientY - r.top - tip.offsetHeight - 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

nodesEl.addEventListener('pointerover', (ev) => {
  const row = ev.target.closest('[data-file]');
  const el = ev.target.closest('.node');
  const next = row ? { type: 'file', id: row.dataset.file } : el ? { type: 'part', id: el.dataset.part } : null;
  if (next && (hover?.type !== next.type || hover?.id !== next.id)) { hover = next; applyFocus(); }
});
nodesEl.addEventListener('pointerout', (ev) => {
  const el = ev.target.closest('.node');
  if (el && !el.contains(ev.relatedTarget)) { hover = null; applyFocus(); }
});
nodesEl.addEventListener('click', (ev) => {
  const el = ev.target.closest('.node');
  if (!el) return;
  const id = el.dataset.part;
  const row = ev.target.closest('[data-file]');
  if (ev.target.closest('[data-toggle]')) setExpanded(id, !expanded.has(id));
  else if (row) select(sel?.type === 'file' && sel.id === row.dataset.file ? null : { type: 'file', id: row.dataset.file });
  else if (ev.target.closest('[data-more]')) select({ type: 'part', id });
  else select(sel?.type === 'part' && sel.id === id ? null : { type: 'part', id });
});

$('.zoom').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-zoom]');
  if (!b || !geo) return;
  const r = stage.getBoundingClientRect();
  if (b.dataset.zoom === 'fit') { userMoved = false; fit(); }
  else if (b.dataset.zoom === 'files') {
    const ids = [...geo.pos.keys()];
    expanded = ids.some((id) => !expanded.has(id)) ? new Set(ids) : new Set();
    saveExpanded();
    geo = layout();
    drawNodes();
    drawEdges();
    userMoved = false;
    fit();
    renderDetails();
  } else zoomAt(r.width / 2, r.height / 2, b.dataset.zoom === 'in' ? 1.25 : 0.8);
});
new ResizeObserver(() => { if (!userMoved) fit(); }).observe(stage);
new ResizeObserver(() => drawChart()).observe($('#tl-chart'));

// ------------------------------------------------------------------ panel + feed clicks, keyboard, theme

function panelClick(ev) {
  const t = ev.target.closest('[data-part], [data-edge], [data-file], [data-close], [data-toggle-part]');
  if (!t || t.disabled) return;
  if (t.dataset.togglePart) setExpanded(t.dataset.togglePart, !expanded.has(t.dataset.togglePart));
  else if (t.dataset.file) selectFile(t.dataset.file);
  else if (t.dataset.part) { select({ type: 'part', id: t.dataset.part }); reveal(t.dataset.part); }
  else if (t.dataset.edge) select({ type: 'edge', id: t.dataset.edge });
  else select(null);
}
detailsEl.addEventListener('click', panelClick);
commitEl.addEventListener('click', panelClick);
detailsEl.addEventListener('toggle', (ev) => {
  if (!ev.target.matches?.('details.help')) return;
  helpSeen = !ev.target.open;
  try { localStorage.setItem('al-dente-help', helpSeen ? 'seen' : ''); } catch { /* storage blocked */ }
}, true);
feedEl.addEventListener('click', (ev) => {
  const li = ev.target.closest('[data-ev]');
  const a = li && feed.find((x) => x.id === Number(li.dataset.ev));
  if (a?.file && S.files?.[a.file]) selectFile(a.file);
  else if (a?.part && geo?.pos.has(a.part)) { select({ type: 'part', id: a.part }); pulse(a.part); }
});
$('#health').addEventListener('click', () => {
  const bad = S?.edges?.find((e) => e.kind === 'violation');
  if (bad) select({ type: 'edge', id: edgeKey(bad) });
});

$('#history-btn').addEventListener('click', () => openTimeline(timelineEl.hidden));
range.addEventListener('input', () => setIndex(Number(range.value)));
range.addEventListener('pointermove', showTlTip);
range.addEventListener('pointerleave', () => { tlTip.hidden = true; });
timelineEl.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-step], [data-all], [data-live]');
  if (!t || !hist) return;
  if (t.dataset.step) setIndex(hist.index + Number(t.dataset.step));
  else if (t.dataset.all) { if ((t.dataset.all === '1') !== hist.all) { hist.all = t.dataset.all === '1'; loadLog(); } }
  else setIndex(hist.commits.length);
});

addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea')) return;
  if (ev.key === 'Escape') { if (sel) select(null); else if (past()) setIndex(hist.commits.length); }
  else if (!timelineEl.hidden && hist && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    ev.preventDefault();
    setIndex(hist.index + (ev.key === 'ArrowLeft' ? -1 : 1));
  }
});

const legend = $('.legend');
try { if (localStorage.getItem('al-dente-legend') === 'closed') legend.open = false; } catch { /* storage blocked */ }
legend.addEventListener('toggle', () => { try { localStorage.setItem('al-dente-legend', legend.open ? 'open' : 'closed'); } catch { /* storage blocked */ } });

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
events.addEventListener('state', (ev) => {
  const first = !live;
  live = JSON.parse(ev.data);
  if (first) loadExpanded();
  if (past()) renderHeader();
  else { S = { ...live, files: index }; render(); }
});
events.addEventListener('files', (ev) => {
  index = JSON.parse(ev.data);
  if (live && !past()) { S = { ...live, files: index }; render(); }
});
// File changes arrive just before the graph that reflects them, which triggers the redraw.
events.addEventListener('patch', (ev) => {
  const { set, del } = JSON.parse(ev.data);
  Object.assign(index, set);
  for (const rel of del) delete index[rel];
});
events.addEventListener('feed', (ev) => { feed = JSON.parse(ev.data); renderFeed(); });
events.addEventListener('history', () => { if (!timelineEl.hidden) loadLog(); });
events.addEventListener('activity', (ev) => {
  const a = JSON.parse(ev.data);
  const i = feed.findIndex((x) => x.id === a.id);
  if (i >= 0) { // the hook re-labelled an edit as Claude's
    feed[i] = a;
    const fl = fx.live.get(a.part);
    if (fl) { fl.actor = a.actor; if (!past()) drawNodes(); }
    return renderFeed();
  }
  feed.unshift(a);
  feed.length = Math.min(feed.length, 60);
  renderFeed(a.id);
  animate(a);
});
