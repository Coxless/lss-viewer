import './style.css';
import { runBench } from './bench/bench';
import { Camera, decodeHash, encodeHash, FLY_MS } from './camera/camera';
import { attachControls } from './camera/controls';
import { Hierarchy } from './data/hierarchy';
import type { ToMain, ToWorker } from './data/protocol';
import type { Layer, Metadata, VoidEntry } from './data/types';
import { Renderer } from './gl/renderer';
import { selectNodes, type Slab } from './lod/select';
import { frustumPlanes, lookAt, multiply, perspective, smoothstep, V, type Plane, type Vec3 } from './math';
import { buildFrame, scaleBar, sphereLines, type Tick } from './ui/frame';
import { setupPanel, type Panel } from './ui/panel';

const MAX_REQUESTS = 6;
const CACHE_FACTOR = 2.2;
const HASH_DELAY_MS = 400;
const REMESH_DELAY_MS = 120;
const HOME_PITCH = 0.95;
const INSIDE_DIST = 0.8;
const LARGE_MESH_VERTICES = 30_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const canvas = $<HTMLCanvasElement>('sky');
const glContext = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
if (!glContext) {
  $('stage').textContent = 'このブラウザはWebGL2に対応していないため表示できません。';
  throw new Error('WebGL2 unavailable');
}
const gl = glContext;
const renderer = new Renderer(gl);
const camera = new Camera();
const isPhone = matchMedia('(max-width: 760px)').matches;
const dpr = Math.min(window.devicePixelRatio || 1, isPhone ? 1.75 : 2);

type Mode = 'auto' | 'shell' | 'gal';

const state = {
  mode: 'auto' as Mode,
  budget: Number(params.get('budget')) || (isPhone ? 250_000 : 400_000),
  threshold: -0.6,
  showFrame: true,
  meta: null as Metadata | null,
  hierarchy: null as Hierarchy | null,
  center: [0, 0, 0] as Vec3,
  ext: 1,
  ticks: [] as Tick[],
  gen: 0,
  transferred: 0,
  dirty: true,
  /** Layer visibility and user opacity. */
  layerOn: new Map<string, boolean>(),
  layerOpacity: new Map<string, number>(),
  /** Which list is shown, and the cached lists. */
  listId: null as string | null,
  lists: new Map<string, VoidEntry[]>(),
  selected: -1,
  slab: null as Slab | null,
  frame: 0,
  visible: [] as number[],
  visiblePoints: 0,
  requested: new Set<number>(),
  failed: new Map<number, number>(),
  firstDraw: null as null | { ms: number; bytes: number },
  remeshPending: false,
};

function markDirty() {
  state.dirty = true;
}

// ---------------- worker ----------------
let remeshTimer = 0;
let hashPending = true;
const worker = new Worker(new URL('./data/worker.ts', import.meta.url), { type: 'module' });

function send(m: ToWorker) {
  worker.postMessage(m);
}

worker.onmessage = (ev: MessageEvent<ToMain>) => {
  const m = ev.data;
  if (m.gen !== state.gen) return; // an answer about a dataset we have left
  switch (m.type) {
    case 'progress':
      showVeil(true, m.text);
      break;
    case 'bytes':
      state.transferred += m.n;
      break;
    case 'opened':
      onOpened(m.meta, m.hierarchy);
      break;
    case 'tile':
      state.requested.delete(m.id);
      state.failed.delete(m.id);
      renderer.addTile(m.id, m.buffer, state.frame);
      markDirty();
      break;
    case 'mesh':
      renderer.setMesh(m.layerId, m.mesh);
      markDirty();
      break;
    case 'list':
      state.lists.set(m.layerId, m.items);
      if (state.listId === m.layerId) panel.renderList(m.items, listMethod());
      markDirty();
      break;
    case 'remeshed': {
      // Answers to earlier slider positions can still be on their way.
      if (m.threshold !== state.threshold) break;
      state.remeshPending = false;
      panel.setThresholdStatus(m.truncated ? '三角形の上限で打ち切りました' : '');
      const simple = state.meta?.layers.find((l) => l.kind === 'list' && l.params.method === 'simple');
      if (simple) {
        state.lists.set(simple.id, m.voids);
        if (state.listId === simple.id) {
          selectVoid(-1);
          panel.renderList(m.voids, 'simple');
        }
      }
      break;
    }
    case 'error':
      onWorkerError(m);
      break;
  }
};

function onWorkerError(m: Extract<ToMain, { type: 'error' }>) {
  if (m.request === 'tile' && m.id !== undefined) {
    // Retry after a while rather than asking again on the next frame.
    state.requested.delete(m.id);
    state.failed.set(m.id, performance.now() + 3000);
    return;
  }
  if (m.request === 'remesh') state.remeshPending = false;
  showVeil(false);
  panel.showError(m.text);
  panel.setThresholdStatus('');
}

// ---------------- dataset ----------------
function beginDataset() {
  state.gen++;
  renderer.reset();
  state.meta = null;
  state.hierarchy = null;
  state.visible = [];
  state.visiblePoints = 0;
  state.requested.clear();
  state.failed.clear();
  state.lists.clear();
  state.listId = null;
  state.selected = -1;
  state.transferred = 0;
  state.firstDraw = null;
  state.slab = null;
  state.remeshPending = false;
  clearTimeout(remeshTimer);
  panel.setThresholdStatus('');
  panel.resetSlab();
  panel.showError(null);
  return state.gen;
}

function openUrl(url: string) {
  const gen = beginDataset();
  showVeil(true, 'データを読み込み中');
  send({ type: 'openUrl', gen, url: new URL(url, location.href).href });
}

function openCsv(file: File) {
  const gen = beginDataset();
  showVeil(true, 'CSVを読み取り中');
  send({ type: 'openCsv', gen, file, threshold: state.threshold });
}

function openMock(n: number) {
  const gen = beginDataset();
  showVeil(true, '模擬カタログを準備中');
  send({ type: 'openMock', gen, n, seed: 7, threshold: state.threshold });
}

function firstOfKind(meta: Metadata, kind: Layer['kind']) {
  return meta.layers.find((l) => l.kind === kind) ?? null;
}

function listMethod(): string {
  return state.meta?.layers.find((l) => l.id === state.listId)?.params.method ?? 'simple';
}

function onOpened(meta: Metadata, hierarchy: ArrayBuffer) {
  state.meta = meta;
  state.hierarchy = new Hierarchy(hierarchy);
  const b = meta.bbox;
  state.center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  state.ext = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  camera.maxDist = state.ext * 4;

  const frame = buildFrame(meta);
  renderer.setFrame(frame.lines);
  state.ticks = frame.ticks;

  state.layerOn.clear();
  const surface = firstOfKind(meta, 'isosurface');
  for (const l of meta.layers) {
    if (l.kind !== 'isosurface') continue;
    state.layerOn.set(l.id, l === surface);
    if (!state.layerOpacity.has(l.id)) state.layerOpacity.set(l.id, defaultOpacity(l));
  }
  if (surface) send({ type: 'layerMesh', gen: state.gen, layerId: surface.id, file: surface.file });
  const list = firstOfKind(meta, 'list');
  state.listId = list?.id ?? null;
  if (list) send({ type: 'layerList', gen: state.gen, layerId: list.id, file: list.file });

  // A view in the URL belongs to the dataset the page opened with, not to one loaded later.
  const shared = hashPending ? decodeHash(location.hash) : null;
  hashPending = false;
  if (shared) camera.set(shared);
  else goHome(false);

  panel.setDataset(meta, state.layerOn, state.layerOpacity, state.listId);
  panel.renderList([], listMethod());
  showVeil(false);
  markDirty();
}

/** Surfaces add up on screen, so a much larger mesh starts fainter. */
function defaultOpacity(layer: Layer): number {
  return 0.6 * Math.min(1, Math.sqrt(LARGE_MESH_VERTICES / Math.max(1, layer.params.vertices ?? 0)));
}

function homeView() {
  const fp = state.meta?.footprint;
  // Look at the bulk of the galaxies, from behind the observer.
  const partial = fp && !fp.fullSky;
  const target: Vec3 = partial ? [...fp.centroid] : state.center;
  const yaw = partial ? Math.atan2(target[1], target[0]) + Math.PI : 0;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const dist = state.ext * 1.25 * (aspect < 1 ? Math.max(1, 0.8 / aspect) : 1);
  return { target, dist, yaw };
}

function goHome(animate: boolean) {
  const { target, dist, yaw } = homeView();
  if (animate) camera.flyTo(target, dist, yaw, HOME_PITCH, performance.now());
  else camera.set({ target, dist, yaw, pitch: HOME_PITCH });
  selectVoid(-1);
  markDirty();
}

function currentVoids(): VoidEntry[] {
  return (state.listId && state.lists.get(state.listId)) || [];
}

function selectVoid(i: number, flyIn = false) {
  state.selected = i;
  const v = currentVoids()[i];
  renderer.setSelection(v ? sphereLines(v.center, v.radius) : []);
  panel.markSelected(i);
  if (v && flyIn) camera.flyTo(v.center as Vec3, v.radius * INSIDE_DIST, camera.yaw + 0.6, 0.2, performance.now());
  markDirty();
}

function chooseList(id: string) {
  state.listId = id;
  selectVoid(-1);
  const layer = state.meta?.layers.find((l) => l.id === id);
  const items = state.lists.get(id);
  if (items) panel.renderList(items, layer?.params.method ?? 'simple');
  else if (layer) {
    panel.renderList([], layer.params.method ?? 'simple');
    send({ type: 'layerList', gen: state.gen, layerId: id, file: layer.file });
  }
}

function setLayerOn(id: string, on: boolean) {
  state.layerOn.set(id, on);
  const layer = state.meta?.layers.find((l) => l.id === id);
  if (on && layer && !renderer.hasMesh(id)) send({ type: 'layerMesh', gen: state.gen, layerId: id, file: layer.file });
  markDirty();
}

// ---------------- UI ----------------
function showVeil(on: boolean, text?: string) {
  const v = $('veil');
  if (text) $('stage').textContent = text;
  v.style.opacity = on ? '1' : '0';
  v.style.pointerEvents = on ? 'auto' : 'none';
}

const panel: Panel = setupPanel({
  isPhone,
  onMode: (m) => {
    state.mode = m;
    markDirty();
  },
  onBudget: (b) => {
    state.budget = b;
    markDirty();
  },
  onHome: () => goHome(true),
  onNextVoid: () => {
    const n = currentVoids().length;
    if (n) selectVoid((state.selected + 1) % n, true);
  },
  onSelectVoid: (i) => selectVoid(i, true),
  onChooseList: chooseList,
  onSlabThickness: (t) => {
    if (t === 0) state.slab = null;
    else if (state.slab) state.slab.thickness = t;
    else state.slab = { ...slabFromView(), thickness: t };
    markDirty();
  },
  onSlabAlign: () => {
    const thickness = state.slab?.thickness ?? 0;
    state.slab = { ...slabFromView(), thickness };
    markDirty();
  },
  onThreshold: (t) => {
    state.threshold = t;
    clearTimeout(remeshTimer);
    const surface = state.meta?.layers.find((l) => l.kind === 'isosurface' && l.params.polarity === 'low' && l.id === 'voids');
    if (!surface || !state.meta?.density) return;
    state.remeshPending = true;
    panel.setThresholdStatus('作り直し中');
    remeshTimer = window.setTimeout(() => {
      send({ type: 'remesh', gen: state.gen, layerId: surface.id, threshold: t });
      if (!state.layerOn.get(surface.id)) setLayerOn(surface.id, true);
    }, REMESH_DELAY_MS);
  },
  onLayerOn: setLayerOn,
  onLayerOpacity: (id, op) => {
    state.layerOpacity.set(id, op);
    markDirty();
  },
  onShowFrame: (on) => {
    state.showFrame = on;
    markDirty();
  },
  onCsv: openCsv,
  onMock: openMock,
});

function slabFromView(): { normal: Vec3; center: Vec3 } {
  return { normal: V.norm(V.sub(camera.target, camera.eye())), center: [...camera.target] as Vec3 };
}

attachControls(
  canvas,
  camera,
  markDirty,
  () => {
    $('hint').style.opacity = '0';
    if (isPhone) panel.openSheet(false);
    markDirty();
  },
);
addEventListener('resize', markDirty);

// ---------------- labels ----------------
const labelsEl = $('labels');
const labelPool: HTMLDivElement[] = [];

function setLabels(items: { p: Vec3; t: string; cls?: string }[], vp: Float32Array) {
  while (labelPool.length < items.length) {
    const d = document.createElement('div');
    d.className = 'label';
    labelsEl.appendChild(d);
    labelPool.push(d);
  }
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  labelPool.forEach((d, i) => {
    const it = items[i];
    if (!it) {
      d.hidden = true;
      return;
    }
    const p = it.p;
    const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw <= 0.01) {
      d.hidden = true;
      return;
    }
    const sx = (x / cw * 0.5 + 0.5) * w;
    const sy = (1 - (y / cw * 0.5 + 0.5)) * h;
    if (sx < -50 || sy < -20 || sx > w + 50 || sy > h + 20) {
      d.hidden = true;
      return;
    }
    d.hidden = false;
    d.className = `label ${it.cls ?? ''}`;
    if (d.textContent !== it.t) d.textContent = it.t;
    d.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -140%)`;
  });
}

// ---------------- frame ----------------
let lastT = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fpsShown = 0;
let hashTimer = 0;
let lastHash = '';

function resize() {
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    state.dirty = true;
  }
}

function requestTiles(want: number[], now: number) {
  const h = state.hierarchy!;
  let needMore = false;
  for (const id of want) {
    if (state.requested.has(id)) continue;
    const retryAt = state.failed.get(id);
    if (retryAt !== undefined && now < retryAt) {
      needMore = true;
      continue;
    }
    if (state.requested.size >= MAX_REQUESTS) break;
    state.requested.add(id);
    send({ type: 'tile', gen: state.gen, id, byteOffset: h.byteOffset(id), count: h.points(id) });
  }
  return needMore;
}

function checkFirstDraw(now: number) {
  if (state.firstDraw || !state.hierarchy || !state.meta) return;
  const h = state.hierarchy;
  const surface = firstOfKind(state.meta, 'isosurface');
  if (surface && !renderer.hasMesh(surface.id)) return;
  if (state.mode !== 'shell') {
    const end = Math.min(h.count, 1 + h.childCount(0));
    for (let id = 0; id < end; id++) if (!renderer.tiles.has(id)) return;
  }
  state.firstDraw = { ms: Math.round(now), bytes: state.transferred };
}

function draw(now: number) {
  requestAnimationFrame(draw);
  if (camera.step(now)) state.dirty = true;
  resize();
  const dt = now - lastT;
  lastT = now;
  if (!state.dirty) return;
  state.dirty = false;
  state.frame++;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 500) {
    fpsShown = Math.round((1000 * fpsN) / fpsAcc);
    fpsAcc = 0;
    fpsN = 0;
  }

  const W = canvas.width;
  const H = canvas.height;
  gl.viewport(0, 0, W, H);
  gl.clearColor(0.016, 0.024, 0.043, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const meta = state.meta;
  const hierarchy = state.hierarchy;
  if (!meta || !hierarchy) return;

  const eye = camera.eye();
  const near = Math.max(0.05, camera.dist * 0.004);
  const far = camera.dist + state.ext * 3;
  const vp = multiply(perspective(camera.fov, W / H, near, far), lookAt(eye, camera.target, [0, 0, 1]));
  const planes: Plane[] = frustumPlanes(vp);
  const projection = canvas.clientHeight / (2 * Math.tan(camera.fov / 2));

  const zt = smoothstep(state.ext * 0.22, state.ext * 1.1, camera.dist);
  const budget = state.mode === 'shell' ? 0 : state.budget * (state.mode === 'auto' ? 1 - 0.75 * zt : 1);
  const selection = selectNodes({
    hierarchy,
    eye,
    projection,
    planes,
    budget,
    slab: state.slab && state.slab.thickness > 0 ? state.slab : null,
    isLoaded: (id) => renderer.tiles.has(id),
  });
  for (const id of selection.visible) renderer.tiles.touch(id, state.frame);
  state.visible = selection.visible;
  state.visiblePoints = selection.points;
  if (requestTiles(selection.want, now) || state.requested.size > 0) state.dirty = true;
  renderer.tiles.evict(state.budget * CACHE_FACTOR, state.frame);

  const shellScale = state.mode === 'gal' ? 0 : state.mode === 'shell' ? 1 : 0.35 + 0.65 * zt;
  const meshes = meta.layers
    .filter((l) => l.kind === 'isosurface' && state.layerOn.get(l.id))
    .map((l) => ({ id: l.id, opacity: (state.layerOpacity.get(l.id) ?? 0.6) * shellScale }));

  renderer.draw({
    vp,
    eye,
    projection,
    dpr,
    fog: state.ext * 1.4,
    fogStart: camera.dist,
    slab: state.slab && state.slab.thickness > 0 ? state.slab : null,
    pointAlpha: state.mode === 'gal' ? 0.85 : 0.8 - 0.25 * zt,
    showFrame: state.showFrame,
    visible: state.visible,
    hierarchy,
    meshes,
    frameNumber: state.frame,
  });
  checkFirstDraw(now);

  const items: { p: Vec3; t: string; cls?: string }[] = [{ p: [0, 0, 0], t: '天の川銀河（私たち）', cls: 'me' }];
  if (state.showFrame) for (const t of state.ticks) items.push(t);
  const v = currentVoids()[state.selected];
  if (v) {
    const c = v.center as Vec3;
    const inside = V.len(V.sub(eye, c)) < v.radius;
    items.push({
      p: V.add(c, [0, 0, inside ? v.radius * 0.15 : v.radius]),
      t: `${v.id} · 直径 約${Math.round(v.radius * 2)} Mpc/h（約${(v.radius * 2 * 0.0466).toFixed(1)}億光年）${inside ? ' · いま内部' : ''}`,
      cls: 'void',
    });
  }
  setLabels(items, vp);

  panel.updateReadout({
    points: state.visiblePoints,
    budget: state.budget,
    visibleNodes: state.visible.length,
    cachedNodes: renderer.tiles.size,
    totalNodes: hierarchy.count,
    gpuMB: renderer.gpuBytes() / 1048576,
    transferredMB: state.transferred / 1048576,
    fps: fpsShown,
    zoomText: zt > 0.7 ? '縮小：輪郭中心' : zt > 0.15 ? '中間' : '拡大：全銀河',
  });
  const scale = scaleBar((2 * camera.dist * Math.tan(camera.fov / 2)) / canvas.clientHeight);
  panel.updateScale(scale.px, scale.text);

  const hash = encodeHash(camera);
  if (hash !== lastHash) {
    lastHash = hash;
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => history.replaceState(null, '', hash), camera.flying ? FLY_MS : HASH_DELAY_MS);
  }
}
requestAnimationFrame(draw);

addEventListener('hashchange', () => {
  const s = decodeHash(location.hash);
  if (s) {
    camera.set(s);
    markDirty();
  }
});

// ---------------- test and bench hooks ----------------
const hooks = {
  /** True when nothing is loading and no frame is pending. */
  idle: () => !!state.meta && !state.dirty && state.requested.size === 0 && !state.remeshPending,
  stats: () => ({
    points: state.visiblePoints,
    nodes: state.visible.length,
    cached: renderer.tiles.size,
    cachedPoints: renderer.tiles.points,
    transferred: state.transferred,
    gpuBytes: renderer.gpuBytes(),
    firstDraw: state.firstDraw,
    frame: state.frame,
    budget: state.budget,
    voids: currentVoids().length,
    source: state.meta?.source.name ?? null,
    threshold: state.threshold,
    selected: state.selected,
  }),
  camera,
  bench: null as null | Awaited<ReturnType<typeof runBench>>,
};
(window as unknown as { __zspace: typeof hooks }).__zspace = hooks;

async function startBench() {
  while (!hooks.idle()) await new Promise((r) => setTimeout(r, 50));
  const seconds = Number(params.get('seconds')) || 20;
  const result = await runBench({
    camera,
    center: state.center,
    ext: state.ext,
    seconds,
    markDirty,
    stats: () => ({
      points: state.visiblePoints,
      transferred: state.transferred,
      gpuBytes: renderer.gpuBytes(),
      budget: state.budget,
      width: canvas.width,
      height: canvas.height,
      dpr,
    }),
  });
  hooks.bench = result;
  const out = $('benchOut');
  out.hidden = false;
  out.textContent = JSON.stringify(result);
}

const dataUrl = params.get('data') ?? 'dataset/';
openUrl(dataUrl.endsWith('/') ? dataUrl : `${dataUrl}/`);
if (params.get('bench') === '1') void startBench();
