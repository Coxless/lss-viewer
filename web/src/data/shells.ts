import type { MeshData } from './types';

const HEADER = 32;
const VERTEX = 8;

/** Parses a decompressed shells file. The vertices are kept as stored, for direct GPU upload. */
export function decodeShells(buffer: ArrayBuffer): MeshData {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'ZSHL') throw new Error('輪郭ファイルの形式が正しくありません。');
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const threshold = view.getFloat32(12, true);
  const center: [number, number, number] = [view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)];
  const half = view.getFloat32(28, true);

  const indexStart = HEADER + vertexCount * VERTEX;
  const bytes = new Uint8Array(buffer, indexStart);
  const indices = new Uint32Array(indexCount);
  let at = 0;
  let prev = 0;
  for (let n = 0; n < indexCount; n++) {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[at++];
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    const delta = value % 2 === 1 ? -(value + 1) / 2 : value / 2;
    prev += delta;
    indices[n] = prev;
  }
  return { vertices: buffer.slice(HEADER, indexStart), indices, center, half, threshold };
}
