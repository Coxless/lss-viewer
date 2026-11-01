import type { Metadata, VoidEntry } from '../data/types';

type Mode = 'auto' | 'shell' | 'gal';

export interface PanelHandlers {
  isPhone: boolean;
  onMode(m: Mode): void;
  onBudget(points: number): void;
  onHome(): void;
  onNextVoid(): void;
  onSelectVoid(i: number): void;
  onChooseList(id: string): void;
  onSlabThickness(t: number): void;
  onSlabAlign(): void;
  onSlabFan(thickness: number): void;
  onThreshold(t: number): void;
  onLayerOn(id: string, on: boolean): void;
  onLayerOpacity(id: string, opacity: number): void;
  onShowFrame(on: boolean): void;
  onCsv(file: File): void;
  onMock(n: number): void;
}

export interface Readout {
  points: number;
  budget: number;
  visibleNodes: number;
  cachedNodes: number;
  totalNodes: number;
  gpuMB: number;
  transferredMB: number;
  fps: number;
  zoomText: string;
}

export interface Panel {
  setDataset(meta: Metadata, on: Map<string, boolean>, opacity: Map<string, number>, listId: string | null): void;
  renderList(items: VoidEntry[], method: string, loading?: boolean): void;
  setListChoice(id: string, name: string): void;
  setLayerChecked(id: string, on: boolean): void;
  setLayerStatus(id: string, text: string): void;
  markSelected(i: number): void;
  resetSlab(): void;
  showError(text: string | null): void;
  setThresholdStatus(text: string): void;
  openSheet(open: boolean): void;
  updateReadout(r: Readout): void;
  updateScale(px: number, text: string): void;
}

const DEFAULT_COLOR = '#8ce0f7';
/** Thickness about 23 Mpc/h on the logarithmic slider. */
const FAN_SLIDER_DEFAULT = 38;
const METHOD_LABEL: Record<string, string> = {
  simple: '簡易検出',
  'vast-voidfinder': 'VAST VoidFinder',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function segmented(ids: string[], onPick: (id: string) => void) {
  for (const id of ids) {
    $(id).onclick = () => {
      for (const j of ids) $(j).setAttribute('aria-pressed', String(j === id));
      onPick(id);
    };
  }
}

function sliderRow(name: string, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'slider-row';
  const label = document.createElement('span');
  label.className = 'slider-name';
  label.textContent = name;
  row.append(label, ...controls);
  return row;
}

/** The threshold belongs to the density surface, so it lives inside that layer's block. */
function thresholdControls(threshold: number, onChange: (t: number) => void): HTMLElement[] {
  const format = (t: number) => `δ = −${Math.abs(t).toFixed(2)}`;
  const text = document.createElement('span');
  text.className = 'slider-value';
  text.id = 'thrTxt';
  text.textContent = format(threshold);
  const status = document.createElement('span');
  status.className = 'status';
  status.id = 'thrStatus';

  const range = document.createElement('input');
  range.type = 'range';
  range.id = 'thr';
  range.min = '-85';
  range.max = '-30';
  range.step = '5';
  range.value = String(Math.round(threshold * 100));
  range.setAttribute('aria-label', 'ボイド境界の密度しきい値');
  range.oninput = () => {
    const t = +range.value / 100;
    text.textContent = format(t);
    onChange(t);
  };

  const head = document.createElement('div');
  head.className = 'slider-head';
  const name = document.createElement('span');
  name.className = 'slider-name';
  name.textContent = '境界';
  head.append(name, text, status);

  const help = document.createElement('p');
  help.className = 'layer-help';
  help.textContent = '平均密度より何割少ない所を「空洞の壁」とみなすか。−0.60は平均の4割以下の領域です。';
  return [head, range, help];
}

function formatCount(n: number): string {
  return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
}

export function setupPanel(h: PanelHandlers): Panel {
  const sheet = $('sheet');
  const openSheet = (open: boolean) => sheet.classList.toggle('collapsed', !open);
  $('grip').onclick = () => openSheet(sheet.classList.contains('collapsed'));
  if (!h.isPhone) openSheet(true);

  segmented(['mAuto', 'mShell', 'mGal'], (id) => h.onMode(id === 'mAuto' ? 'auto' : id === 'mShell' ? 'shell' : 'gal'));
  const standard = h.isPhone ? 250_000 : 400_000;
  if (h.isPhone) {
    $('q2').textContent = '標準 25万';
    for (const id of ['q1', 'q2', 'q3']) $(id).setAttribute('aria-pressed', String(id === 'q2'));
  }
  const budgets: Record<string, number> = { q1: 150_000, q2: standard, q3: 1_000_000 };
  segmented(['q1', 'q2', 'q3'], (id) => h.onBudget(budgets[id]));
  const mocks: Record<string, number> = { n1: 300_000, n2: 600_000, n3: 1_200_000 };
  segmented(['n1', 'n2', 'n3'], (id) => h.onMock(mocks[id]));

  $('home').onclick = () => h.onHome();
  $('nextVoid').onclick = () => h.onNextVoid();

  const slab = $<HTMLInputElement>('slab');
  const slabText = $('slabTxt');
  const showSlabThickness = () => {
    const v = +slab.value;
    const t = v === 0 ? 0 : Math.round(4 * Math.pow(100, v / 100));
    slabText.textContent = t === 0 ? 'オフ' : `厚さ ${t} Mpc/h`;
    return t;
  };
  const applySlab = () => h.onSlabThickness(showSlabThickness());
  slab.oninput = applySlab;
  $('slabAlign').onclick = () => {
    h.onSlabAlign();
    if (+slab.value === 0) slab.value = '35';
    applySlab();
  };

  $('slabFan').onclick = () => {
    if (+slab.value === 0) slab.value = String(FAN_SLIDER_DEFAULT);
    h.onSlabFan(showSlabThickness());
  };

  const checks = new Map<string, HTMLInputElement>();
  const statuses = new Map<string, HTMLElement>();
  const listButtons = new Map<string, HTMLButtonElement>();

  $<HTMLInputElement>('showFrame').onchange = (e) => h.onShowFrame((e.target as HTMLInputElement).checked);

  const csv = $<HTMLInputElement>('csv');
  csv.onchange = () => {
    const f = csv.files?.[0];
    if (!f) return;
    for (const j of ['n1', 'n2', 'n3']) $(j).setAttribute('aria-pressed', 'false');
    h.onCsv(f);
    csv.value = '';
  };

  let lastList: HTMLButtonElement[] = [];
  const err = $('err');

  return {
    setDataset(meta, on, opacity, listId) {
      const n = meta.octree.points;
      const depth = Math.round(meta.rRange[1]);
      const src = $('srcline');
      src.textContent = '';
      const name = document.createElement('b');
      name.textContent = meta.source.mock ? '模擬カタログ' : meta.source.name;
      src.append(name, ` · ${formatCount(n)}銀河 · 奥行き ${depth} Mpc/h`);

      $('creditMock').hidden = !meta.source.mock;
      $('creditSdss').hidden = meta.source.mock === true || !/sdss/i.test(meta.source.name);
      $('creditVast').hidden = !meta.layers.some((l) => l.params.method === 'vast-voidfinder');

      // Layers: names come from the metadata, so other structures need no UI changes.
      const box = $('layers');
      box.textContent = '';
      checks.clear();
      statuses.clear();
      for (const layer of meta.layers) {
        if (layer.kind !== 'isosurface') continue;
        const row = document.createElement('div');
        row.className = 'layer';
        row.dataset.layer = layer.id;

        const head = document.createElement('label');
        head.className = 'check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = on.get(layer.id) ?? false;
        check.onchange = () => h.onLayerOn(layer.id, check.checked);
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = layer.params.color ?? DEFAULT_COLOR;
        const status = document.createElement('span');
        status.className = 'status';
        head.append(check, swatch, ` ${layer.name} `, status);
        checks.set(layer.id, check);
        statuses.set(layer.id, status);
        row.append(head);

        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.value = String(Math.round((opacity.get(layer.id) ?? 0.6) * 100));
        range.setAttribute('aria-label', `${layer.name}の濃さ`);
        range.oninput = () => h.onLayerOpacity(layer.id, +range.value / 100);
        row.append(sliderRow('濃さ', range));

        if (layer.id === 'voids' && meta.density) row.append(...thresholdControls(layer.params.threshold ?? -0.6, h.onThreshold));
        box.append(row);
      }

      const fp = meta.footprint;
      const notes: string[] = [];
      if (fp && !fp.fullSky && !fp.rectangular) notes.push('細い帯状の領域ではボイドの形を計算できないため、銀河の点だけを表示します。');
      if (meta.layers.some((l) => l.params.method === 'vast-voidfinder')) notes.push('VAST のカタログは SDSS DR7 の主領域だけを対象にしています。');
      const note = $('surveyNote');
      note.hidden = notes.length === 0;
      note.textContent = notes.join('');

      // More than one list: choose between them.
      const lists = meta.layers.filter((l) => l.kind === 'list');
      const choose = $('listChoice');
      choose.textContent = '';
      choose.hidden = lists.length < 2;
      listButtons.clear();
      if (lists.length > 1) {
        for (const l of lists) {
          const b = document.createElement('button');
          b.textContent = METHOD_LABEL[l.params.method ?? ''] ?? l.name;
          b.setAttribute('aria-pressed', String(l.id === listId));
          b.onclick = () => h.onChooseList(l.id);
          listButtons.set(l.id, b);
          choose.append(b);
        }
      }
      $('listName').textContent = lists.find((l) => l.id === listId)?.name ?? 'ボイド';
      $('dataNote').textContent = meta.source.mock
        ? 'いまは本物そっくりの泡構造をもつ模擬カタログです。SkyServerで取得した ra, dec, z 列のCSVを読み込むと、同じ処理で実データに切り替わります。'
        : `${meta.source.name}：${meta.source.rows.toLocaleString('ja-JP')} 行のうち ${meta.source.dropped.toLocaleString('ja-JP')} 行を除外しました。`;
    },

    setListChoice(id, name) {
      for (const [other, b] of listButtons) b.setAttribute('aria-pressed', String(other === id));
      $('listName').textContent = name;
    },

    setLayerChecked(id, on) {
      const c = checks.get(id);
      if (c) c.checked = on;
    },

    setLayerStatus(id, text) {
      const s = statuses.get(id);
      if (s) s.textContent = text;
    },

    renderList(items, method, loading = false) {
      const ul = $('voidList');
      ul.textContent = '';
      lastList = items.map((v, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        const id = document.createElement('span');
        id.className = 'id';
        id.textContent = v.id;
        const size = document.createElement('span');
        size.textContent = `直径 ${Math.round(v.radius * 2)} Mpc/h`;
        const dist = document.createElement('span');
        dist.className = 'r';
        dist.textContent = `${Math.round(Math.hypot(...v.center))} Mpc/h先`;
        b.append(id, size, dist);
        b.onclick = () => h.onSelectVoid(i);
        li.append(b);
        ul.append(li);
        return b;
      });
      $('vCount').textContent = loading ? '読み込み中' : `${items.length} 個`;
      $('vMethod').textContent = `検出方法：${METHOD_LABEL[method] ?? method}`;
    },

    markSelected(i) {
      lastList.forEach((b, k) => b.setAttribute('aria-current', String(k === i)));
    },

    resetSlab() {
      slab.value = '0';
      slabText.textContent = 'オフ';
    },

    showError(text) {
      err.hidden = text === null;
      err.textContent = text ?? '';
      if (text) openSheet(true);
    },

    setThresholdStatus(text) {
      const status = document.getElementById('thrStatus');
      if (status) status.textContent = text;
    },

    openSheet,

    updateReadout(r) {
      $('rPts').textContent = r.points.toLocaleString('ja-JP');
      $('rBar').style.width = `${Math.min(100, (r.points / Math.max(1, r.budget)) * 100)}%`;
      $('rNodes').textContent = `${r.visibleNodes}/${r.cachedNodes}/${r.totalNodes}`;
      $('rGpu').textContent = r.gpuMB.toFixed(1);
      $('rXfer').textContent = r.transferredMB.toFixed(1);
      $('rFps').textContent = r.fps ? String(r.fps) : '–';
      $('zoomState').textContent = r.zoomText;
    },

    updateScale(px, text) {
      $('scaleBar').style.width = `${px}px`;
      $('scaleTxt').textContent = text;
    },
  };
}
