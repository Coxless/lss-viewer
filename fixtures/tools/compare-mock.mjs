// Compares the delta distribution of a dataset with the prototype's mock at the same size.
// usage: node compare-mock.mjs <dataset dir> [n]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const dir = process.argv[2], n = +(process.argv[3] ?? 600000);
const html = readFileSync(new URL('../../prototype/lss-viewer-prototype.html', import.meta.url), 'utf8');
const { instance } = await WebAssembly.instantiate(Buffer.from(/WASM_B64 = "([^"]+)"/.exec(html)[1], 'base64'), {});
const e = instance.exports;
e.reset(); e.gen_mock(n, 7); e.build(4096, 120, 1.4);
const meta = JSON.parse(readFileSync(`${dir}/metadata.json`));
const edges = [-1, -0.85, -0.6, -0.3, 0, 0.5, 1, 2, 4, 8, 1e9];
const hist = vals => { const h = new Array(edges.length - 1).fill(0); let c = 0; for (const v of vals) { let b = edges.findIndex((x, i) => v >= x && v < edges[i + 1]); if (b >= 0) { h[b]++; c++; } } return { c, f: h.map(x => +(x / c).toFixed(3)) }; };
// prototype: inside cells exclude the fill value +3 (dims about 76x125x68)
const protoCells = 76 * 125 * 68;
const pd = new Float32Array(e.memory.buffer, e.delta_ptr(), protoCells);
console.log('edges    ', edges.slice(0, -1).join(' '));
console.log('prototype', JSON.stringify(hist([...pd].filter(v => v !== 3))));
const q = gunzipSync(readFileSync(`${dir}/${meta.density.file}`));
const a = Math.log(0.05), b = Math.log(10);
const mine = []; for (const v of q) if (v !== 255) mine.push(Math.exp(a + v / 254 * (b - a)) - 1);
console.log('rust     ', JSON.stringify(hist(mine)));
const ni = e.mesh(-0.6, 700000); console.log('proto verts', e.mesh_vcount(), 'indices', ni);
const nv = e.find_voids(-0.6, 40), V = new Float32Array(e.memory.buffer, e.voids_ptr(), nv * 5);
const rs = []; for (let i = 0; i < nv; i++) rs.push(Math.round(V[5*i+3])); console.log('proto radii', rs.sort((x, y) => y - x).join(' '));
const l = meta.layers[0].params; console.log('rust verts', l.vertices, 'indices', l.indices);
console.log('rust radii', JSON.parse(readFileSync(`${dir}/voids.json`)).map(v => Math.round(v.radius)).join(' '));
