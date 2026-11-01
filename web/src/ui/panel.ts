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
  renderList(items: VoidEntry[], method: string): void;
  markSelected(i: number): void;
  resetSlab(): void;
  showError(text: string | null): void;
  setThresholdStatus(text: string): void;
  openSheet(open: boolean): void;
  updateReadout(r: Readout): void;
  updateScale(px: number, text: string): void;
}

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
  const applySlab = () => {
    const v = +slab.value;
    const t = v === 0 ? 0 : Math.round(4 * Math.pow(100, v / 100));
    slabText.textContent = t === 0 ? 'オフ' : `厚さ ${t} Mpc/h`;
    h.onSlabThickness(t);
  };
  slab.oninput = applySlab;
  $('slabAlign').onclick = () => {
    h.onSlabAlign();
    if (+slab.value === 0) slab.value = '35';
    applySlab();
  };

  const thr = $<HTMLInputElement>('thr');
  const thrText = $('thrTxt');
  const thrStatus = $('thrStatus');
  thr.oninput = () => {
    const t = +thr.value / 100;
    thrText.textContent = `δ = −${Math.abs(t).toFixed(2)}`;
    h.onThreshold(t);
  };

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
      for (const layer of meta.layers) {
        if (layer.kind !== 'isosurface') continue;
        const row = document.createElement('div');
        row.className = 'layer';
        const label = document.createElement('label');
        label.className = 'check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = on.get(layer.id) ?? false;
        check.onchange = () => h.onLayerOn(layer.id, check.checked);
        label.append(check, ` ${layer.name}`);
        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.value = String(Math.round((opacity.get(layer.id) ?? 0.6) * 100));
        range.setAttribute('aria-label', `${layer.name}の濃さ`);
        range.oninput = () => h.onLayerOpacity(layer.id, +range.value / 100);
        row.append(label, range);
        box.append(row);
      }

      const canRemesh = !!meta.density && meta.layers.some((l) => l.id === 'voids');
      $('thrSection').hidden = !canRemesh;
      thr.value = String(Math.round((meta.layers.find((l) => l.id === 'voids')?.params.threshold ?? -0.6) * 100));
      thrText.textContent = `δ = −${Math.abs(+thr.value / 100).toFixed(2)}`;
      thrStatus.textContent = '';

      // More than one list: choose between them.
      const lists = meta.layers.filter((l) => l.kind === 'list');
      const choose = $('listChoice');
      choose.textContent = '';
      choose.hidden = lists.length < 2;
      if (lists.length > 1) {
        const buttons = lists.map((l) => {
          const b = document.createElement('button');
          b.textContent = METHOD_LABEL[l.params.method ?? ''] ?? l.name;
          b.setAttribute('aria-pressed', String(l.id === listId));
          b.onclick = () => {
            for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
            h.onChooseList(l.id);
          };
          return b;
        });
        choose.append(...buttons);
      }
      $('listName').textContent = lists.find((l) => l.id === listId)?.name ?? 'ボイド';
      $('dataNote').textContent = meta.source.mock
        ? 'いまは本物そっくりの泡構造をもつ模擬カタログです。SkyServerで取得した ra, dec, z 列のCSVを読み込むと、同じ処理で実データに切り替わります。'
        : `${meta.source.name}：${meta.source.rows.toLocaleString('ja-JP')} 行のうち ${meta.source.dropped.toLocaleString('ja-JP')} 行を除外しました。`;
    },

    renderList(items, method) {
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
      $('vCount').textContent = `${items.length} 個`;
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
      thrStatus.textContent = text;
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
