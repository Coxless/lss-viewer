/// <reference lib="webworker" />
// Fetching, decoding and Wasm all run here, so the main thread only draws and handles input.
import { decodeShells } from './shells';
import { HttpSource, MemorySource } from './sources';
import type { Structure } from './structures';
import type { DataSource, Metadata, VoidEntry } from './types';
import type { ToMain, ToWorker } from './protocol';

type WasmDataset = { metadata: string; hierarchy: Uint8Array; points: Uint8Array; shells: Uint8Array; density: Uint8Array; voids: string };

const FILE_SHELLS = 'shells.bin.gz';
const FILE_VOIDS = 'voids.json';
const STAGE: Record<string, string> = {
  octree: '八分木タイルを構築中',
  footprint: '観測範囲を計算中',
  density: '密度格子を計算中',
  shells: 'ボイドの輪郭を抽出中',
  voids: 'ボイドを探索中',
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
let source: DataSource | null = null;
let meta: Metadata | null = null;

function post(m: ToMain, transfer: Transferable[] = []) {
  scope.postMessage(m, transfer);
}

async function wasm() {
  const mod = await import('../wasm/lss_viewer_wasm.js');
  await mod.default();
  return mod;
}

async function openSource(next: DataSource, gen: number) {
  const m = await next.metadata();
  const hierarchy = await next.hierarchy();
  source = next;
  meta = m;
  post({ type: 'opened', gen, meta: m, hierarchy }, [hierarchy]);
}

function memorySource(ds: WasmDataset): MemorySource {
  const m = JSON.parse(ds.metadata) as Metadata;
  const files = new Map<string, ArrayBuffer>([
    [FILE_SHELLS, ds.shells.slice().buffer as ArrayBuffer],
    [FILE_VOIDS, new TextEncoder().encode(ds.voids).buffer as ArrayBuffer],
  ]);
  return new MemorySource(m, ds.hierarchy, ds.points, files, ds.density);
}

const progress = (gen: number) => (stage: string) => post({ type: 'progress', gen, text: STAGE[stage] ?? stage });

function sendMesh(layerId: string, gen: number, buffer: ArrayBuffer) {
  const mesh = decodeShells(buffer);
  post({ type: 'mesh', gen, layerId, mesh }, [mesh.vertices, mesh.indices.buffer as ArrayBuffer]);
}

async function handle(m: ToWorker) {
  switch (m.type) {
    case 'openUrl':
      await openSource(new HttpSource(m.url, (n) => post({ type: 'bytes', gen: m.gen, n })), m.gen);
      break;
    case 'openCsv': {
      post({ type: 'progress', gen: m.gen, text: `CSVを読み取り中（${(m.file.size / 1048576).toFixed(1)} MB）` });
      const bytes = new Uint8Array(await m.file.arrayBuffer());
      post({ type: 'progress', gen: m.gen, text: '前処理エンジンを準備中' });
      const w = await wasm();
      const ds = w.buildFromCsv(bytes, m.file.name, m.threshold, 1, progress(m.gen)) as WasmDataset;
      await openSource(memorySource(ds), m.gen);
      break;
    }
    case 'openMock': {
      post({ type: 'progress', gen: m.gen, text: '前処理エンジンを準備中' });
      const w = await wasm();
      post({ type: 'progress', gen: m.gen, text: `模擬カタログを生成中（${m.n / 10000}万銀河）` });
      const ds = w.buildMock(m.n, m.seed, m.threshold, 1, progress(m.gen)) as WasmDataset;
      await openSource(memorySource(ds), m.gen);
      break;
    }
    case 'tile': {
      if (!source) return;
      const buffer = await source.tile(m.id, m.byteOffset, m.count);
      post({ type: 'tile', gen: m.gen, id: m.id, buffer }, [buffer]);
      break;
    }
    case 'layerMesh': {
      if (!source) return;
      sendMesh(m.layerId, m.gen, await source.file(m.file));
      break;
    }
    case 'layerList': {
      if (!source) return;
      const text = new TextDecoder().decode(await source.file(m.file));
      post({ type: 'list', gen: m.gen, layerId: m.layerId, items: JSON.parse(text) as VoidEntry[] });
      break;
    }
    case 'structures': {
      if (!source) return;
      const text = new TextDecoder().decode(await source.file(m.file));
      post({ type: 'structures', gen: m.gen, items: JSON.parse(text) as Structure[] });
      break;
    }
    case 'densityTexture': {
      if (!source) return;
      // Cells outside the survey hold 255, the top of the scale. As a texture they would
      // bleed into their neighbours as very high density, so they become the lowest value.
      const bytes = (await source.density()).slice();
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 255) bytes[i] = 0;
      post({ type: 'densityTexture', gen: m.gen, bytes }, [bytes.buffer as ArrayBuffer]);
      break;
    }
    case 'remesh': {
      if (!source || !meta?.density) return;
      const info = meta.density;
      const density = await source.density();
      const w = await wasm();
      const [nx, ny, nz] = info.dims;
      const [ox, oy, oz] = info.origin;
      const out = w.remesh(density, nx, ny, nz, ox, oy, oz, info.cell, m.threshold) as { shells: Uint8Array; voids: string; truncated: boolean };
      sendMesh(m.layerId, m.gen, out.shells.slice().buffer as ArrayBuffer);
      post({ type: 'remeshed', gen: m.gen, threshold: m.threshold, voids: JSON.parse(out.voids) as VoidEntry[], truncated: out.truncated });
      break;
    }
  }
}

scope.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    await handle(m);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    post({ type: 'error', gen: m.gen, text, request: m.type, id: m.type === 'tile' ? m.id : undefined, layerId: 'layerId' in m ? m.layerId : undefined });
  }
};
