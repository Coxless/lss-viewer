import './style.css';
import { runBench } from './bench/bench';
import { Camera, decodeHash, encodeHash, FLY_MS } from './camera/camera';
import { attachControls } from './camera/controls';
import { Hierarchy } from './data/hierarchy';
import type { ToMain, ToWorker } from './data/protocol';
import { decodeStructureIds, MAX_HIGHLIGHTS, regionVectors, type Structure } from './data/structures';
import type { Layer, Metadata, VoidEntry } from './data/types';
import { Renderer } from './gl/renderer';
import { selectNodes, type Slab } from './lod/select';
import { frustumPlanes, hexColor, lookAt, multiply, perspective, smoothstep, V, type Plane, type Vec3 } from './math';
import { buildFrame, scaleBar, sphereLines, type Tick } from './ui/frame';
import { setupPanel, type Panel } from './ui/panel';

const MAX_REQUESTS = 6;
const CACHE_FACTOR = 2.2;
const HASH_DELAY_MS = 400;
const REMESH_DELAY_MS = 120;
const HOME_PITCH = 0.95;
const INSIDE_DIST = 0.8;
const LARGE_MESH_VERTICES = 30_000;
const DEFAULT_LAYER_COLOR = '#8ce0f7';
/** A fan view fills the screen height with the survey's depth. */
const FAN_DIST_FACTOR = 1.2;
const MAX_PITCH = 1.52;
/** How far from a structure a flight ends, in units of its extent. */
const FAN_FOCUS_DIST = 2.4;
const ORBIT_DIST = 2.6;
const ORBIT_PITCH = 0.45;
const ORBIT_TURN = 0.4;

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
  meshLoading: new Set<string>(),
  failed: new Map<number, number>(),
  firstDraw: null as null | { ms: number; bytes: number },
  remeshPending: false,
  structures: [] as Structure[],
  structuresLoading: false,
  highlighted: new Set<string>(),
  /** Brightness of everything outside the highlighted structures. */
  dim: 0.25,
  densityLoading: false,
  /** Structures named by the URL, until the list they refer to arrives. */
  pendingStructures: decodeStructureIds(location.hash),
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
      state.meshLoading.delete(m.layerId);
      panel.setLayerStatus(m.layerId, '');
      markDirty();
      break;
    case 'list':
      state.lists.set(m.layerId, m.items);
      if (state.listId === m.layerId) panel.renderList(m.items, listMethod());
      markDirty();
      break;
    case 'structures':
      state.structuresLoading = false;
      state.structures = m.items;
      panel.setStructures(m.items);
      if (state.pendingStructures) applyStructureIds(state.pendingStructures);
      state.pendingStructures = null;
      markDirty();
      break;
    case 'densityTexture': {
      state.densityLoading = false;
      const d = state.meta?.density;
      if (d) renderer.setDensity(m.bytes, d.dims, d.origin, d.cell);
      panel.setStructureNote('');
      updateHighlights();
      break;
    }
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
  if (m.request === 'structures') {
    state.structuresLoading = false;
    return;
  }
  if (m.request === 'densityTexture') {
    state.densityLoading = false;
    panel.setStructureNote('密度を読み込めなかったため、範囲全体に色を付けています。');
    return;
  }
  if (m.request === 'remesh') state.remeshPending = false;
  if (m.request === 'layerMesh' && m.layerId) {
    // Leave the layer off, so turning it on again retries.
    state.meshLoading.delete(m.layerId);
    panel.setLayerStatus(m.layerId, '');
    setLayerOn(m.layerId, false);
  }
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
  state.meshLoading.clear();
  state.failed.clear();
  state.lists.clear();
  state.listId = null;
  state.selected = -1;
  state.transferred = 0;
  state.firstDraw = null;
  state.slab = null;
  state.remeshPending = false;
  state.structures = [];
  state.structuresLoading = false;
  state.highlighted.clear();
  state.densityLoading = false;
  panel.setStructures([]);
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
  if (surface) loadMesh(surface);
  const list = (surface && listOfSurface(surface.id)) ?? firstOfKind(meta, 'list');
  state.listId = list?.id ?? null;
  applyListColor();
  if (list) send({ type: 'layerList', gen: state.gen, layerId: list.id, file: list.file });

  const regions = firstOfKind(meta, 'regions');
  if (regions) {
    state.structuresLoading = true;
    send({ type: 'structures', gen: state.gen, file: regions.file });
  }

  // A view in the URL belongs to the dataset the page opened with, not to one loaded later.
  const shared = hashPending ? decodeHash(location.hash) : null;
  hashPending = false;
  if (shared) camera.set(shared);
  else goHome(false);

  panel.setDataset(meta, state.layerOn, state.layerOpacity, state.listId);
  panel.renderList([], listMethod(), true);
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
  renderer.setSelection(v ? sphereLines(v.center, v.radius) : [], hexColor(listColor()));
  panel.markSelected(i);
  if (v && flyIn) camera.flyTo(v.center as Vec3, v.radius * INSIDE_DIST, camera.yaw + 0.6, 0.2, performance.now());
  markDirty();
}

function layerById(id: string | null) {
  return state.meta?.layers.find((l) => l.id === id) ?? null;
}

function listOfSurface(id: string) {
  return state.meta?.layers.find((l) => l.kind === 'list' && l.params.surface === id) ?? null;
}

function listColor(): string {
  return layerById(layerById(state.listId)?.params.surface ?? null)?.params.color ?? DEFAULT_LAYER_COLOR;
}

function applyListColor() {
  document.documentElement.style.setProperty('--list-color', listColor());
}

/** Shows a list. The list on screen always describes a surface the user can see. */
function showList(id: string) {
  if (state.listId === id) return;
  state.listId = id;
  applyListColor();
  selectVoid(-1);
  const layer = layerById(id);
  panel.setListChoice(id, layer?.name ?? '');
  const method = layer?.params.method ?? 'simple';
  const items = state.lists.get(id);
  if (items) panel.renderList(items, method);
  else if (layer) {
    panel.renderList([], method, true);
    send({ type: 'layerList', gen: state.gen, layerId: id, file: layer.file });
  }
}

/** The user picked a list: its surface comes on with it. */
function chooseList(id: string) {
  showList(id);
  const surface = layerById(id)?.params.surface;
  if (surface && !state.layerOn.get(surface)) setLayerOn(surface, true);
}

function loadMesh(layer: Layer) {
  if (renderer.hasMesh(layer.id) || state.meshLoading.has(layer.id)) return;
  state.meshLoading.add(layer.id);
  panel.setLayerStatus(layer.id, '読み込み中');
  send({ type: 'layerMesh', gen: state.gen, layerId: layer.id, file: layer.file });
}

function setLayerOn(id: string, on: boolean) {
  state.layerOn.set(id, on);
  panel.setLayerChecked(id, on);
  const layer = layerById(id);
  if (on) {
    if (layer) loadMesh(layer);
    const list = listOfSurface(id);
    if (list) showList(list.id);
  } else if (layerById(state.listId)?.params.surface === id) {
    // This list's surface went away: follow another visible surface, if there is one.
    for (const [other, visible] of state.layerOn) {
      const list = visible ? listOfSurface(other) : null;
      if (list) {
        showList(list.id);
        break;
      }
    }
  }
  markDirty();
}

function structureById(id: string) {
  return state.structures.find((s) => s.id === id && s.status === 'visible') ?? null;
}

/** Voids have nothing to paint and need their surroundings to be seen, so only the others dim the map. */
function dimmingActive(): boolean {
  return [...state.highlighted].some((id) => structureById(id)?.type !== 'void');
}

/** Sends the checked structures to the renderer. Smaller ones first, so a cluster keeps its colour inside its supercluster. */
function updateHighlights() {
  const active = [...state.highlighted].map(structureById).filter((s): s is Structure => s !== null).sort((a, b) => a.extent - b.extent);
  renderer.setHighlights(
    active.map((s) => ({
      vectors: regionVectors(s.geometry, s.minDelta),
      color: s.type === 'void' ? null : hexColor(s.color),
      center: s.center,
      extent: s.extent,
    })),
  );
  renderer.setOutlines(
    active
      .filter((s) => s.type === 'void' && s.geometry.shape === 'sphere')
      .map((s) => ({ data: s.geometry.shape === 'sphere' ? sphereLines(s.geometry.center, s.geometry.radius) : [], color: hexColor(s.color) })),
  );
  if (active.some((s) => s.minDelta !== undefined) && state.meta?.density && !renderer.hasDensity() && !state.densityLoading) {
    state.densityLoading = true;
    panel.setStructureNote('構造の形を読み込み中');
    send({ type: 'densityTexture', gen: state.gen });
  }
  panel.markStructures(state.highlighted, dimmingActive());
  markDirty();
}

function setStructure(id: string, on: boolean) {
  if (on && !state.highlighted.has(id) && state.highlighted.size >= MAX_HIGHLIGHTS) return;
  if (on) state.highlighted.add(id);
  else state.highlighted.delete(id);
  updateHighlights();
}

function applyStructureIds(ids: string[]) {
  state.highlighted = new Set(ids.filter((id) => structureById(id)).slice(0, MAX_HIGHLIGHTS));
  updateHighlights();
}

/** A wall is seen as a thin fan; anything else from a distance that can be orbited. */
function flyToStructure(id: string) {
  const s = structureById(id);
  if (!s) return;
  setStructure(id, true);
  if (s.view === 'fan') {
    const thickness = s.thickness ?? 30;
    panel.setSlabThickness(thickness);
    showFan(thickness, s);
  } else {
    state.slab = null;
    panel.resetSlab();
    camera.flyTo(s.center, s.extent * ORBIT_DIST, camera.yaw + ORBIT_TURN, ORBIT_PITCH, performance.now());
    markDirty();
  }
  if (isPhone) panel.openSheet(false);
}

/** A thin slab through the observer and the view target, seen from straight above: the classic 2D fan. */
function showFan(thickness: number, focus?: Structure) {
  const fp = state.meta?.footprint;
  let t: Vec3 = focus ? focus.center : camera.target;
  if (V.len(t) < 1) t = fp ? [...fp.centroid] : [1, 0, 0];
  const out = V.norm(t);
  let normal = V.sub([0, 0, 1], V.sc(out, out[2]));
  if (V.len(normal) < 1e-3) normal = [1, 0, 0];
  normal = V.norm(normal);
  state.slab = { normal, center: [...t] as Vec3, thickness };

  const depth = state.meta?.rRange[1] ?? state.ext;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const yaw = Math.hypot(normal[0], normal[1]) > 1e-3 ? Math.atan2(normal[1], normal[0]) : Math.atan2(-out[1], -out[0]);
  const pitch = Math.min(MAX_PITCH, Math.asin(Math.min(1, normal[2])));
  const fit = aspect < 1 ? Math.max(1, 0.8 / aspect) : 1;
  const target = focus ? focus.center : V.sc(out, depth / 2);
  const dist = focus ? focus.extent * FAN_FOCUS_DIST : depth * FAN_DIST_FACTOR;
  camera.flyTo(target, dist * fit, yaw, pitch, performance.now());
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
  onSelectVoid: (i) => {
    selectVoid(i, true);
    if (isPhone) panel.openSheet(false);
  },
  onChooseList: chooseList,
  onSlabThickness: (t) => {
    if (t === 0) state.slab = null;
    else if (state.slab) state.slab.thickness = t;
    else state.slab = { ...slabFromView(), thickness: t };
    markDirty();
  },
  onSlabFan: (t) => {
    showFan(t);
    // On a phone the open sheet would hide the view that was just asked for.
    if (isPhone) panel.openSheet(false);
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
    // Moving the slider means the user wants to see this surface.
    setLayerOn(surface.id, true);
    state.remeshPending = true;
    panel.setThresholdStatus('作り直し中');
    remeshTimer = window.setTimeout(() => {
      send({ type: 'remesh', gen: state.gen, layerId: surface.id, threshold: t });
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
  onStructure: setStructure,
  onFlyToStructure: flyToStructure,
  onDim: (brightness) => {
    state.dim = brightness;
    markDirty();
  },
  onCsv: openCsv,
  onMock: openMock,
});

function slabFromView(): { normal: Vec3; center: Vec3 } {
  return { normal: V.norm(V.sub(camera.target, camera.eye())), center: [...camera.target] as Vec3 };
}

function hideHint() {
  $('hint').style.opacity = '0';
}

attachControls(
  canvas,
  camera,
  markDirty,
  () => {
    hideHint();
    if (isPhone) panel.openSheet(false);
    markDirty();
  },
);
// Using the panel also counts as having found the controls.
$('sheet').addEventListener('pointerdown', hideHint);
addEventListener('resize', markDirty);

// ---------------- labels ----------------
const labelsEl = $('labels');
const labelPool: HTMLDivElement[] = [];

function setLabels(items: { p: Vec3; t: string; cls?: string; color?: string }[], vp: Float32Array) {
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
    d.style.color = it.color ?? '';
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
  const dimming = dimmingActive();
  // A highlighted structure is made of galaxies, so they are not thinned out when zoomed out.
  const budget = state.mode === 'shell' ? 0 : state.budget * (state.mode === 'auto' && !dimming ? 1 - 0.75 * zt : 1);
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
  const dim = dimming ? state.dim : 1;
  const meshes = meta.layers
    .filter((l) => l.kind === 'isosurface' && state.layerOn.get(l.id))
    .map((l) => ({ id: l.id, opacity: (state.layerOpacity.get(l.id) ?? 0.6) * shellScale * dim, color: hexColor(l.params.color ?? DEFAULT_LAYER_COLOR) }));

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
    dim,
  });
  checkFirstDraw(now);

  const items: { p: Vec3; t: string; cls?: string; color?: string }[] = [{ p: [0, 0, 0], t: '天の川銀河（私たち）', cls: 'me' }];
  if (state.showFrame) for (const t of state.ticks) items.push(t);
  for (const id of state.highlighted) {
    const s = structureById(id);
    if (s) items.push({ p: s.center, t: s.name, cls: 'structure', color: s.color });
  }
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

  // Until the list arrives, the URL still holds what it asked for.
  const hash = encodeHash(camera, state.pendingStructures ?? [...state.highlighted]);
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
  const ids = decodeStructureIds(location.hash);
  if (state.meta) applyStructureIds(ids ?? []);
});

// ---------------- test and bench hooks ----------------
const hooks = {
  /** True when nothing is loading and no frame is pending. */
  idle: () => !!state.meta && !state.dirty && state.requested.size === 0 && state.meshLoading.size === 0 && !state.remeshPending && !state.structuresLoading && !state.densityLoading,
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
    listId: state.listId,
    slab: state.slab,
    layersOn: Object.fromEntries(state.layerOn),
    highlighted: [...state.highlighted],
    hasDensity: renderer.hasDensity(),
  }),
  camera,
  bench: null as null | Awaited<ReturnType<typeof runBench>>,
};
(window as unknown as { __lssViewer: typeof hooks }).__lssViewer = hooks;

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
