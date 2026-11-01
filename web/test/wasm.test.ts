import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { buildFromCsv, remesh } from '../src/wasm/zspace_wasm.js';

const CLI = new URL('../../target/release/zspace-cli', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'zspace-wasm-'));
const csvPath = join(dir, 'mock.csv');
const outDir = join(dir, 'cli');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Result = { hierarchy: Uint8Array; points: Uint8Array; shells: Uint8Array; density: Uint8Array; voids: string; metadata: string };
let wasm: Result;

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL('../src/wasm/zspace_wasm_bg.wasm', import.meta.url)) });
  execFileSync(CLI, ['mock', '--n', '40000', '--seed', '11', '--out', csvPath], { stdio: 'ignore' });
  execFileSync(CLI, ['build', '--input', csvPath, '--out', outDir, '--name', 'x'], { stdio: 'ignore' });
  wasm = buildFromCsv(readFileSync(csvPath), 'x', -0.6, 1, () => {}) as Result;
});

describe('the Wasm build and the native CLI', () => {
  const file = (name: string) => readFileSync(join(outDir, name));

  it('write the same octree', () => {
    expect(sha(wasm.hierarchy)).toBe(sha(file('hierarchy.bin')));
    expect(sha(wasm.points)).toBe(sha(file('points.bin')));
  });

  it('write the same density grid and surface', () => {
    expect(sha(wasm.density)).toBe(sha(gunzipSync(file('density.bin.gz'))));
    expect(sha(wasm.shells)).toBe(sha(gunzipSync(file('shells.bin.gz'))));
  });

  it('find the same voids and metadata', () => {
    expect(wasm.voids).toBe(file('voids.json').toString());
    expect(JSON.parse(wasm.metadata)).toEqual(JSON.parse(file('metadata.json').toString()));
  });

  it('rebuilds the shipped surface from the stored grid', () => {
    const meta = JSON.parse(wasm.metadata);
    const [nx, ny, nz] = meta.density.dims;
    const [ox, oy, oz] = meta.density.origin;
    const out = remesh(wasm.density, nx, ny, nz, ox, oy, oz, meta.density.cell, -0.6) as { shells: Uint8Array; voids: string };
    expect(sha(out.shells)).toBe(sha(wasm.shells));
    expect(out.voids).toBe(wasm.voids);
  });

  it('rejects a grid of the wrong size', () => {
    expect(() => remesh(new Uint8Array(10), 4, 4, 4, 0, 0, 0, 1, -0.6)).toThrow();
  });
});

describe('CSV errors', () => {
  it('names the missing columns', () => {
    expect(() => buildFromCsv(new TextEncoder().encode('a,b\n1,2\n'), 'x', -0.6, 1, () => {})).toThrow(/列見出し/);
  });

  it('refuses too few rows', () => {
    expect(() => buildFromCsv(new TextEncoder().encode('ra,dec,z\n1,2,0.05\n'), 'x', -0.6, 1, () => {})).toThrow(/有効な行が 1 行/);
  });
});
