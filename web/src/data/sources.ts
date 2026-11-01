import type { DataSource, Metadata } from './types';

const GZIP_MAGIC = [0x1f, 0x8b];

/** Hosts may already have undone the gzip through Content-Encoding, so check the bytes. */
export async function gunzipIfNeeded(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head[0] !== GZIP_MAGIC[0] || head[1] !== GZIP_MAGIC[1]) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** A dataset on a static host. Tiles use HTTP Range, or tiles/<id>.bin when the dataset has them. */
export class HttpSource implements DataSource {
  private meta: Metadata | null = null;
  private wholePoints: ArrayBuffer | null = null;
  private densityBytes: Promise<Uint8Array> | null = null;

  constructor(
    private readonly base: string,
    private readonly onBytes: (n: number) => void,
  ) {}

  private url(name: string): string {
    return new URL(name, this.base).href;
  }

  private async get(name: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(this.url(name), init);
    if (!res.ok) throw new Error(`${name} を取得できません（HTTP ${res.status}）。`);
    return res;
  }

  private async bytes(name: string): Promise<ArrayBuffer> {
    const buf = await (await this.get(name)).arrayBuffer();
    this.onBytes(buf.byteLength);
    return buf;
  }

  async metadata(): Promise<Metadata> {
    const buf = await this.bytes('metadata.json');
    let meta: Metadata;
    try {
      meta = JSON.parse(new TextDecoder().decode(buf)) as Metadata;
    } catch {
      // Hosts with a single-page fallback answer a missing file with HTML and status 200.
      throw new Error('metadata.json を取得できません（データセットのURLを確認してください）。');
    }
    if (meta.format !== 'lss-viewer/1') throw new Error(`対応していないデータ形式です: ${meta.format}`);
    this.meta = meta;
    return meta;
  }

  hierarchy(): Promise<ArrayBuffer> {
    return this.bytes('hierarchy.bin');
  }

  async tile(id: number, byteOffset: number, count: number): Promise<ArrayBuffer> {
    const length = count * 8;
    if (this.meta?.octree.splitFiles) return this.bytes(`tiles/${id}.bin`);
    if (this.wholePoints) return this.wholePoints.slice(byteOffset, byteOffset + length);
    const res = await this.get('points.bin', { headers: { Range: `bytes=${byteOffset}-${byteOffset + length - 1}` } });
    const buf = await res.arrayBuffer();
    this.onBytes(buf.byteLength);
    if (res.status === 206) {
      if (buf.byteLength !== length) throw new Error(`タイル ${id} の長さが一致しません。`);
      return buf;
    }
    // The server ignored Range and sent the whole file. Keep it and serve from memory.
    this.wholePoints = buf;
    return buf.slice(byteOffset, byteOffset + length);
  }

  async file(name: string): Promise<ArrayBuffer> {
    return gunzipIfNeeded(await this.bytes(name));
  }

  /** Fetched once: every later threshold change reuses it. A failed fetch can be retried. */
  density(): Promise<Uint8Array> {
    const info = this.meta?.density;
    if (!info) return Promise.reject(new Error('このデータには密度格子がありません。'));
    this.densityBytes ??= this.file(info.file).then((b) => new Uint8Array(b));
    this.densityBytes.catch(() => {
      this.densityBytes = null;
    });
    return this.densityBytes;
  }
}

/** A dataset built in the browser from a user's CSV or a mock catalog. */
export class MemorySource implements DataSource {
  constructor(
    private readonly meta: Metadata,
    private readonly hierarchyBytes: Uint8Array,
    private readonly points: Uint8Array,
    private readonly files: Map<string, ArrayBuffer>,
    private readonly densityBytes: Uint8Array,
  ) {}

  async metadata(): Promise<Metadata> {
    return this.meta;
  }

  async hierarchy(): Promise<ArrayBuffer> {
    return copy(this.hierarchyBytes);
  }

  async tile(_id: number, byteOffset: number, count: number): Promise<ArrayBuffer> {
    return copy(this.points.subarray(byteOffset, byteOffset + count * 8));
  }

  async file(name: string): Promise<ArrayBuffer> {
    const f = this.files.get(name);
    if (!f) throw new Error(`${name} がありません。`);
    return f.slice(0);
  }

  async density(): Promise<Uint8Array> {
    return this.densityBytes;
  }
}

function copy(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}
