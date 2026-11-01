const RECORD = 32;

/** Read access to hierarchy.bin without allocating per node. */
export class Hierarchy {
  readonly count: number;
  private readonly f: Float32Array;
  private readonly u: Uint32Array;
  private readonly b: Uint8Array;

  constructor(buffer: ArrayBuffer) {
    this.count = Math.floor(buffer.byteLength / RECORD);
    this.f = new Float32Array(buffer);
    this.u = new Uint32Array(buffer);
    this.b = new Uint8Array(buffer);
  }

  cx(i: number) { return this.f[i * 8]; }
  cy(i: number) { return this.f[i * 8 + 1]; }
  cz(i: number) { return this.f[i * 8 + 2]; }
  half(i: number) { return this.f[i * 8 + 3]; }
  byteOffset(i: number) { return this.u[i * 8 + 4]; }
  points(i: number) { return this.u[i * 8 + 5]; }
  childMask(i: number) { return this.b[i * RECORD + 24]; }
  depth(i: number) { return this.b[i * RECORD + 25]; }
  firstChild(i: number) { return this.u[i * 8 + 7]; }

  childCount(i: number): number {
    let m = this.childMask(i);
    let n = 0;
    while (m) {
      m &= m - 1;
      n++;
    }
    return n;
  }
}
