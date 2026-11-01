import type { Hierarchy } from '../data/hierarchy';
import type { MeshData } from '../data/types';
import { TileCache } from '../lod/cache';
import type { Slab } from '../lod/select';
import type { Vec3 } from '../math';

const SLAB = `uniform vec4 uSlab; uniform vec3 uSlabC; bool outSlab(vec3 p){ return uSlab.w > 0.0 && abs(dot(p - uSlabC, uSlab.xyz)) > uSlab.w; }`;

const POINT_VS = `#version 300 es
layout(location=0) in vec4 aQ;
uniform mat4 uVP; uniform vec3 uC; uniform float uH; uniform vec3 uEye; uniform float uProj, uDpr, uFog, uFogD, uAlpha, uWorld;
${SLAB}
out vec4 vCol;
void main(){
  vec3 p = uC + aQ.xyz * uH;
  if (outSlab(p)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); return; }
  float d = distance(p, uEye);
  float v = aQ.w * 32767.0; float cls = floor(v / 4096.0 + 0.001); float br = clamp((v - cls * 4096.0) / 4095.0, 0.0, 1.0);
  vec3 col = mix(vec3(0.70, 0.78, 1.0), vec3(1.0, 0.88, 0.70), br);
  if (cls > 2.5) col = vec3(1.0, 0.70, 0.42);
  if (cls < 0.5) col = vec3(0.62, 0.74, 1.0);
  float px = uWorld * uProj / d;
  gl_PointSize = clamp(px, 1.0, 5.0) * uDpr;
  float fog = clamp(1.0 - (d - uFogD) / uFog, 0.18, 1.0);
  float a = uAlpha * (0.45 + 0.55 * br) * fog * clamp(px * 1.6, 0.35, 1.0);
  vCol = vec4(col * a, a);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const POINT_FS = `#version 300 es
precision mediump float; in vec4 vCol; out vec4 o;
void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard; o = vCol * (1.0 - r * 2.6); }`;

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aQ; layout(location=1) in vec2 aOct;
uniform mat4 uVP; uniform vec3 uC; uniform float uH; out vec3 vN; out vec3 vW;
vec3 octDecode(vec2 e){
  vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return n;
}
void main(){ vN = octDecode(aOct); vW = uC + aQ * uH; gl_Position = uVP * vec4(vW, 1.0); }`;
const MESH_FS = `#version 300 es
precision highp float; in vec3 vN; in vec3 vW; out vec4 o;
uniform vec3 uEye; uniform float uOp, uFog, uFogD;
${SLAB}
void main(){
  if (outSlab(vW)) discard;
  vec3 v = normalize(uEye - vW); float f = 1.0 - abs(dot(normalize(vN), v));
  float d = distance(vW, uEye); float fog = clamp(1.0 - (d - uFogD) / uFog, 0.12, 1.0);
  float a = uOp * (0.025 + 0.75 * pow(f, 3.5)) * fog;
  vec3 c = mix(vec3(0.30, 0.62, 0.78), vec3(0.55, 0.88, 0.97), f);
  o = vec4(c * a, a);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aP; uniform mat4 uVP; void main(){ gl_Position = uVP * vec4(aP, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; uniform vec4 uCol; out vec4 o; void main(){ o = vec4(uCol.rgb * uCol.a, uCol.a); }`;

type Uniforms = Record<string, WebGLUniformLocation>;
interface Program { p: WebGLProgram; u: Uniforms }
interface Lines { vao: WebGLVertexArrayObject; vb: WebGLBuffer; n: number }
interface Tile { vao: WebGLVertexArrayObject; buf: WebGLBuffer; points: number }
interface Mesh { vao: WebGLVertexArrayObject; vb: WebGLBuffer; ib: WebGLBuffer; n: number; bytes: number; center: Vec3; half: number }

export interface FrameParams {
  vp: Float32Array;
  eye: Vec3;
  projection: number;
  dpr: number;
  fog: number;
  fogStart: number;
  slab: Slab | null;
  pointAlpha: number;
  showFrame: boolean;
  visible: number[];
  hierarchy: Hierarchy | null;
  /** Layer id to effective opacity. */
  meshes: { id: string; opacity: number }[];
  frameNumber: number;
}

export class Renderer {
  readonly tiles: TileCache<Tile>;
  private readonly points: Program;
  private readonly mesh: Program;
  private readonly line: Program;
  private readonly frameLines: Lines;
  private readonly selectionLines: Lines;
  private readonly observerLines: Lines;
  private readonly meshes = new Map<string, Mesh>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.points = this.program(POINT_VS, POINT_FS);
    this.mesh = this.program(MESH_VS, MESH_FS);
    this.line = this.program(LINE_VS, LINE_FS);
    this.frameLines = this.lineObject();
    this.selectionLines = this.lineObject();
    this.observerLines = this.lineObject();
    const s = 6;
    this.setLines(this.observerLines, [-s, 0, 0, s, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, -s, 0, 0, s]);
    this.tiles = new TileCache<Tile>((t) => {
      gl.deleteBuffer(t.buf);
      gl.deleteVertexArray(t.vao);
    });
  }

  private program(vs: string, fs: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    const u: Uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      u[info.name] = gl.getUniformLocation(p, info.name)!;
    }
    return { p, u };
  }

  private lineObject(): Lines {
    const gl = this.gl;
    const o: Lines = { vao: gl.createVertexArray()!, vb: gl.createBuffer()!, n: 0 };
    gl.bindVertexArray(o.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, o.vb);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
    return o;
  }

  private setLines(o: Lines, data: number[]) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, o.vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    o.n = data.length / 3;
  }

  setFrame(data: number[]) {
    this.setLines(this.frameLines, data);
  }

  setSelection(data: number[]) {
    this.setLines(this.selectionLines, data);
  }

  addTile(id: number, buffer: ArrayBuffer, frame: number) {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    const buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.SHORT, true, 8, 0);
    gl.bindVertexArray(null);
    const points = buffer.byteLength / 8;
    this.tiles.add(id, { vao, buf, points }, points, frame);
  }

  setMesh(id: string, data: MeshData) {
    const gl = this.gl;
    let m = this.meshes.get(id);
    if (!m) {
      m = { vao: gl.createVertexArray()!, vb: gl.createBuffer()!, ib: gl.createBuffer()!, n: 0, bytes: 0, center: [0, 0, 0], half: 1 };
      gl.bindVertexArray(m.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.SHORT, true, 8, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.BYTE, true, 8, 6);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      gl.bindVertexArray(null);
      this.meshes.set(id, m);
    }
    gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    m.n = data.indices.length;
    m.bytes = data.vertices.byteLength + data.indices.byteLength;
    m.center = data.center;
    m.half = data.half;
  }

  hasMesh(id: string) {
    return this.meshes.has(id);
  }

  /** Drops everything that belongs to the current dataset. */
  reset() {
    const gl = this.gl;
    this.tiles.clear();
    for (const m of this.meshes.values()) {
      gl.deleteBuffer(m.vb);
      gl.deleteBuffer(m.ib);
      gl.deleteVertexArray(m.vao);
    }
    this.meshes.clear();
    this.setSelection([]);
    this.setFrame([]);
  }

  gpuBytes(): number {
    let b = this.tiles.points * 8;
    for (const m of this.meshes.values()) b += m.bytes;
    return b;
  }

  draw(f: FrameParams) {
    const gl = this.gl;
    const { vp, eye, slab } = f;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const slabVec: [number, number, number, number] = slab
      ? [slab.normal[0], slab.normal[1], slab.normal[2], slab.thickness / 2]
      : [0, 0, 1, 0];
    const slabCenter: Vec3 = slab ? slab.center : [0, 0, 0];

    const line = this.line;
    gl.useProgram(line.p);
    gl.uniformMatrix4fv(line.u.uVP, false, vp);
    if (f.showFrame && this.frameLines.n) {
      gl.uniform4f(line.u.uCol, 0.55, 0.62, 0.78, 0.16);
      gl.bindVertexArray(this.frameLines.vao);
      gl.drawArrays(gl.LINES, 0, this.frameLines.n);
    }
    gl.uniform4f(line.u.uCol, 1.0, 0.83, 0.6, 0.9);
    gl.bindVertexArray(this.observerLines.vao);
    gl.drawArrays(gl.LINES, 0, this.observerLines.n);

    const mesh = this.mesh;
    gl.useProgram(mesh.p);
    gl.uniformMatrix4fv(mesh.u.uVP, false, vp);
    gl.uniform3fv(mesh.u.uEye, eye);
    gl.uniform1f(mesh.u.uFog, f.fog);
    gl.uniform1f(mesh.u.uFogD, f.fogStart);
    gl.uniform4fv(mesh.u.uSlab, slabVec);
    gl.uniform3fv(mesh.u.uSlabC, slabCenter);
    for (const { id, opacity } of f.meshes) {
      const m = this.meshes.get(id);
      if (!m || !m.n || opacity <= 0.001) continue;
      gl.uniform1f(mesh.u.uOp, opacity);
      gl.uniform3fv(mesh.u.uC, m.center);
      gl.uniform1f(mesh.u.uH, m.half);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_INT, 0);
    }

    if (f.visible.length && f.hierarchy) {
      const h = f.hierarchy;
      const pts = this.points;
      const u = pts.u;
      gl.useProgram(pts.p);
      gl.uniformMatrix4fv(u.uVP, false, vp);
      gl.uniform3fv(u.uEye, eye);
      gl.uniform1f(u.uProj, f.projection);
      gl.uniform1f(u.uDpr, f.dpr);
      gl.uniform1f(u.uFog, f.fog);
      gl.uniform1f(u.uFogD, f.fogStart);
      gl.uniform1f(u.uWorld, 0.9);
      gl.uniform1f(u.uAlpha, f.pointAlpha);
      gl.uniform4fv(u.uSlab, slabVec);
      gl.uniform3fv(u.uSlabC, slabCenter);
      for (const id of f.visible) {
        const t = this.tiles.get(id);
        if (!t) continue;
        gl.uniform3f(u.uC, h.cx(id), h.cy(id), h.cz(id));
        gl.uniform1f(u.uH, h.half(id));
        gl.bindVertexArray(t.vao);
        gl.drawArrays(gl.POINTS, 0, t.points);
      }
    }

    if (this.selectionLines.n) {
      gl.useProgram(line.p);
      gl.uniformMatrix4fv(line.u.uVP, false, vp);
      gl.uniform4f(line.u.uCol, 0.5, 0.83, 0.9, 0.55);
      gl.bindVertexArray(this.selectionLines.vao);
      gl.drawArrays(gl.LINES, 0, this.selectionLines.n);
    }
    gl.bindVertexArray(null);
  }
}
