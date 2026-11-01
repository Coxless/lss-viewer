import type { MeshData, Metadata, VoidEntry } from './types';

export type ToWorker =
  | { type: 'openUrl'; gen: number; url: string }
  | { type: 'openCsv'; gen: number; file: File; threshold: number }
  | { type: 'openMock'; gen: number; n: number; seed: number; threshold: number }
  | { type: 'tile'; gen: number; id: number; byteOffset: number; count: number }
  | { type: 'layerMesh'; gen: number; layerId: string; file: string }
  | { type: 'layerList'; gen: number; layerId: string; file: string }
  | { type: 'remesh'; gen: number; layerId: string; threshold: number };

export type ToMain =
  | { type: 'opened'; gen: number; meta: Metadata; hierarchy: ArrayBuffer }
  | { type: 'progress'; gen: number; text: string }
  | { type: 'bytes'; gen: number; n: number }
  | { type: 'tile'; gen: number; id: number; buffer: ArrayBuffer }
  | { type: 'mesh'; gen: number; layerId: string; mesh: MeshData }
  | { type: 'list'; gen: number; layerId: string; items: VoidEntry[] }
  | { type: 'remeshed'; gen: number; threshold: number; voids: VoidEntry[]; truncated: boolean }
  | { type: 'error'; gen: number; text: string; request: ToWorker['type']; id?: number; layerId?: string };
