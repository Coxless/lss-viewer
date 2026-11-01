// Runs the prototype's compiled gen_mock and prints the statistics that the
// Rust mock generator (crates/lss-viewer-core/src/mock.rs) is compared against.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../../prototype/lss-viewer-prototype.html', import.meta.url), 'utf8');
const b64 = /WASM_B64 = "([^"]+)"/.exec(html)[1];
const { instance } = await WebAssembly.instantiate(Buffer.from(b64, 'base64'), {});
const e = instance.exports;
const n = +(process.argv[2] ?? 600000), seed = +(process.argv[3] ?? 7);
e.reset();
const t0 = performance.now();
e.gen_mock(n, seed);
console.log('gen ms', Math.round(performance.now() - t0));
const P = new Float32Array(e.memory.buffer, e.points_ptr(), n * 4);
const rH = new Array(10).fill(0), cls = {}, br = new Array(8).fill(0);
let raMin = 1e9, raMax = -1e9, decMin = 1e9, decMax = -1e9, rMin = 1e9, rMax = 0;
for (let i = 0; i < n; i++) {
  const x = P[4*i], y = P[4*i+1], z = P[4*i+2], a = P[4*i+3];
  const r = Math.hypot(x, y, z); let ra = Math.atan2(y, x) * 180 / Math.PI; if (ra < 0) ra += 360;
  const dec = Math.asin(z / r) * 180 / Math.PI;
  raMin = Math.min(raMin, ra); raMax = Math.max(raMax, ra); decMin = Math.min(decMin, dec); decMax = Math.max(decMax, dec); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
  rH[Math.min(9, Math.floor(r / 50))]++;
  const c = Math.floor(a / 4096); cls[c] = (cls[c] || 0) + 1; br[Math.floor((a - c * 4096) / 512)]++;
}
console.log({ raMin, raMax, decMin, decMax, rMin, rMax }); console.log('r per 50', rH.join(' ')); console.log('class', cls); console.log('brightness/8', br.join(' '));
const nn = e.build(4096, 120, 1.4);
const dims = e.grid_dims(); console.log('nodes', nn, 'grid_dims', dims);
const bb = new Float32Array(e.memory.buffer, e.bbox_ptr(), 6); console.log('bbox', [...bb].map(v => +v.toFixed(1)), 'stats', [...new Float32Array(e.memory.buffer, e.stats_ptr(), 4)]);
const ni = e.mesh(-0.6, 700000); console.log('mesh idx', ni, 'verts', e.mesh_vcount());
const nv = e.find_voids(-0.6, 40); const V = new Float32Array(e.memory.buffer, e.voids_ptr(), nv * 5);
const rs = []; for (let i = 0; i < nv; i++) rs.push(V[5*i+3]); console.log('voids', nv, 'radii', rs.map(r => r.toFixed(0)).join(' '), 'dmin', V[4]);
const D = e.delta_ptr(); console.log('delta_ptr', D);
const memo = [...new Float32Array(e.memory.buffer, D, 2000000 / 4 > 0 ? 8 : 0)]; console.log('head', memo);
