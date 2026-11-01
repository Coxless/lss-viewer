/** See docs/format.md. */
export interface Metadata {
  format: string;
  source: { name: string; mock?: boolean; query?: string; rows: number; dropped: number };
  cosmology: { Om: number; OL: number; units: string };
  bbox: [number, number, number, number, number, number];
  rRange: [number, number];
  octree: { root: [number, number, number, number]; leafK: number; nodes: number; pointBytes: number; points: number; splitFiles?: boolean };
  density?: { file: string; dims: [number, number, number]; origin: [number, number, number]; cell: number; sigmaCells: number; encoding: string };
  layers: Layer[];
  footprint?: { healpixNside: number; file: string; raRange: [number, number]; decRange: [number, number]; fullSky: boolean; rectangular: boolean; outline?: number[]; centroid: [number, number, number] };
}

export interface Layer {
  id: string;
  kind: 'isosurface' | 'list' | 'polyline' | 'markers';
  name: string;
  file: string;
  params: { threshold?: number; polarity?: 'low' | 'high'; vertices?: number; indices?: number; method?: string };
}

export interface VoidEntry {
  id: string;
  center: [number, number, number];
  radius: number;
  deltaMin: number;
  method: string;
}

export interface MeshData {
  vertices: ArrayBuffer;
  indices: Uint32Array;
  center: [number, number, number];
  half: number;
  threshold: number;
}

/** Everything the viewer reads from a dataset, wherever it lives. */
export interface DataSource {
  metadata(): Promise<Metadata>;
  hierarchy(): Promise<ArrayBuffer>;
  tile(id: number, byteOffset: number, count: number): Promise<ArrayBuffer>;
  /** A whole file, decompressed when it is gzipped. */
  file(name: string): Promise<ArrayBuffer>;
  /** The density grid, one byte per cell. */
  density(): Promise<Uint8Array>;
}
