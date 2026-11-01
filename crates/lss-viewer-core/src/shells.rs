//! Isosurfaces of the density grid, left open at the survey edge.
//!
//! The mesh is always built from the quantized grid, so a surface the browser rebuilds
//! from `density.bin` matches the one the CLI shipped in `shells.bin`.

use crate::density::{decode_table, DensityGrid, GridSpec, Q_OUTSIDE};
use fast_surface_nets::ndshape::{RuntimeShape, Shape};
use fast_surface_nets::{surface_nets, SurfaceNetsBuffer};
use libm::sqrt;

pub const DEFAULT_THRESHOLD: f32 = -0.6;
pub const MAX_TRIANGLES: usize = 700_000;
const MAGIC: &[u8; 4] = b"ZSHL";
pub const HEADER_BYTES: usize = 32;
pub const VERTEX_BYTES: usize = 8;

/// Whether the surface encloses regions below (voids) or above (clusters) the threshold.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Polarity {
    Low,
    High,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub truncated: bool,
}

/// Runs Surface Nets on a signed field and maps the result to world coordinates.
/// Triangles touching a `blocked` voxel are removed and the vertices compacted.
pub fn mesh_field(field: &[f32], spec: &GridSpec, blocked: Option<&[bool]>, max_triangles: usize) -> Mesh {
    let [nx, ny, nz] = spec.dims;
    let shape = RuntimeShape::<u32, 3>::new([nx as u32, ny as u32, nz as u32]);
    debug_assert_eq!(shape.size() as usize, field.len());
    let mut buf = SurfaceNetsBuffer::default();
    surface_nets(field, &shape, [0; 3], [nx as u32 - 1, ny as u32 - 1, nz as u32 - 1], &mut buf);

    let vertex_ok: Vec<bool> = buf
        .surface_points
        .iter()
        .map(|p| {
            blocked.is_none_or(|b| {
                let (i, j, k) = (p[0] as usize, p[1] as usize, p[2] as usize);
                // A surface vertex is placed inside the voxel spanning (i..=i+1, ...).
                (0..2).all(|dk| (0..2).all(|dj| (0..2).all(|di| !b[spec.index(i + di, j + dj, k + dk)])))
            })
        })
        .collect();

    let mut remap = vec![u32::MAX; buf.positions.len()];
    let mut mesh = Mesh::default();
    for tri in buf.indices.as_chunks::<3>().0 {
        if !tri.iter().all(|&v| vertex_ok[v as usize]) {
            continue;
        }
        if mesh.indices.len() / 3 >= max_triangles {
            mesh.truncated = true;
            break;
        }
        for &v in tri {
            let slot = &mut remap[v as usize];
            if *slot == u32::MAX {
                *slot = mesh.positions.len() as u32;
                let p = buf.positions[v as usize];
                mesh.positions.push(std::array::from_fn(|a| (spec.origin[a] + p[a] as f64 * spec.cell) as f32));
                let n = buf.normals[v as usize].map(|c| c as f64);
                let l = sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).max(1e-12);
                mesh.normals.push(n.map(|c| (c / l) as f32));
            }
            mesh.indices.push(*slot);
        }
    }
    mesh
}

/// Marks every cell within one cell (26-neighbourhood) of the outside.
fn dilated_outside(grid: &DensityGrid) -> Vec<bool> {
    let [nx, ny, nz] = grid.spec.dims;
    let mut out = vec![false; grid.q.len()];
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                if grid.q[grid.spec.index(i, j, k)] != Q_OUTSIDE {
                    continue;
                }
                for dk in k.saturating_sub(1)..=(k + 1).min(nz - 1) {
                    for dj in j.saturating_sub(1)..=(j + 1).min(ny - 1) {
                        for di in i.saturating_sub(1)..=(i + 1).min(nx - 1) {
                            out[grid.spec.index(di, dj, dk)] = true;
                        }
                    }
                }
            }
        }
    }
    out
}

/// The isosurface of the grid at `threshold`. No faces are made next to the outside, so
/// a void reaching the survey edge stays open instead of being closed by a false wall.
pub fn extract(grid: &DensityGrid, threshold: f32, polarity: Polarity, max_triangles: usize) -> Mesh {
    let table = decode_table();
    let sign = match polarity {
        Polarity::Low => 1.0,
        Polarity::High => -1.0,
    };
    // Outside cells never count as interior, for either polarity.
    let field: Vec<f32> = grid
        .q
        .iter()
        .map(|&q| if q == Q_OUTSIDE { 1.0 } else { sign * (table[q as usize] - threshold) })
        .collect();
    mesh_field(&field, &grid.spec, Some(&dilated_outside(grid)), max_triangles)
}

fn oct_encode(n: [f32; 3]) -> [i8; 2] {
    let l1 = n[0].abs() + n[1].abs() + n[2].abs();
    let (mut x, mut y) = if l1 > 0.0 { (n[0] / l1, n[1] / l1) } else { (0.0, 0.0) };
    if n[2] < 0.0 {
        let (ox, oy) = (x, y);
        x = (1.0 - oy.abs()) * if ox >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - ox.abs()) * if oy >= 0.0 { 1.0 } else { -1.0 };
    }
    [(x * 127.0).round() as i8, (y * 127.0).round() as i8]
}

fn oct_decode(e: [i8; 2]) -> [f32; 3] {
    let (x, y) = (e[0] as f32 / 127.0, e[1] as f32 / 127.0);
    let z = 1.0 - x.abs() - y.abs();
    let t = (-z).max(0.0);
    let n = [x + if x >= 0.0 { -t } else { t }, y + if y >= 0.0 { -t } else { t }, z];
    let l = sqrt((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) as f64) as f32;
    n.map(|c| c / l.max(1e-6))
}

fn put_varint(mut v: u32, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// Serializes a mesh: 32-byte header, 8-byte vertices, then zigzag-delta varint indices.
pub fn encode(mesh: &Mesh, threshold: f32) -> Vec<u8> {
    let mut lo = [f32::MAX; 3];
    let mut hi = [f32::MIN; 3];
    for p in &mesh.positions {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let center: [f32; 3] = if mesh.positions.is_empty() { [0.0; 3] } else { std::array::from_fn(|a| (lo[a] + hi[a]) / 2.0) };
    let half = (0..3).map(|a| (hi[a] - lo[a]) / 2.0).fold(1e-3f32, f32::max).next_up();

    let mut out = Vec::with_capacity(HEADER_BYTES + mesh.positions.len() * VERTEX_BYTES + mesh.indices.len() * 2);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(mesh.positions.len() as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.indices.len() as u32).to_le_bytes());
    out.extend_from_slice(&threshold.to_le_bytes());
    for v in center {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&half.to_le_bytes());
    for (p, n) in mesh.positions.iter().zip(&mesh.normals) {
        for a in 0..3 {
            let q = ((p[a] - center[a]) / half * 32767.0).round() as i16;
            out.extend_from_slice(&q.to_le_bytes());
        }
        let e = oct_encode(*n);
        out.push(e[0] as u8);
        out.push(e[1] as u8);
    }
    let mut prev = 0i64;
    for &i in &mesh.indices {
        let d = i as i64 - prev;
        prev = i as i64;
        put_varint(((d << 1) ^ (d >> 63)) as u32, &mut out);
    }
    out
}

/// Parses [`encode`]'s output. The viewer has an equivalent in `web/src/data/shells.ts`.
pub fn decode(bytes: &[u8]) -> Option<(Mesh, f32)> {
    if bytes.len() < HEADER_BYTES || &bytes[..4] != MAGIC {
        return None;
    }
    let u = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let f = |i: usize| f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let (nv, ni) = (u(4) as usize, u(8) as usize);
    let (threshold, center, half) = (f(12), [f(16), f(20), f(24)], f(28));
    let index_at = HEADER_BYTES + nv * VERTEX_BYTES;
    let verts = bytes.get(HEADER_BYTES..index_at)?;
    let mut mesh = Mesh::default();
    for v in verts.as_chunks::<VERTEX_BYTES>().0 {
        let q = |a: usize| i16::from_le_bytes([v[2 * a], v[2 * a + 1]]) as f32 / 32767.0;
        mesh.positions.push(std::array::from_fn(|a| center[a] + q(a) * half));
        mesh.normals.push(oct_decode([v[6] as i8, v[7] as i8]));
    }
    let mut at = index_at;
    let mut prev = 0i64;
    for _ in 0..ni {
        let (mut value, mut shift) = (0u32, 0);
        loop {
            let b = *bytes.get(at)?;
            at += 1;
            value |= ((b & 0x7f) as u32) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                break;
            }
        }
        let d = (value >> 1) as i64 ^ -((value & 1) as i64);
        prev += d;
        mesh.indices.push(prev as u32);
    }
    Some((mesh, threshold))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::density::{encode_q, GridSpec};

    fn cube_grid(n: usize) -> GridSpec {
        GridSpec { dims: [n, n, n], origin: [0.0; 3], cell: 1.0 }
    }

    fn grid_from(spec: GridSpec, f: impl Fn([f64; 3]) -> f32) -> DensityGrid {
        let mut q = vec![0u8; spec.len()];
        for k in 0..spec.dims[2] {
            for j in 0..spec.dims[1] {
                for i in 0..spec.dims[0] {
                    q[spec.index(i, j, k)] = encode_q(f(spec.position(i, j, k)));
                }
            }
        }
        DensityGrid { spec, q }
    }

    fn dist(p: [f64; 3], c: [f64; 3]) -> f64 {
        sqrt((0..3).map(|a| (p[a] - c[a]) * (p[a] - c[a])).sum())
    }

    /// A smooth low-density sphere: delta falls below -0.6 inside radius `r`.
    fn sphere_delta(p: [f64; 3], c: [f64; 3], r: f64) -> f32 {
        ((dist(p, c) - r) * 0.1 - 0.6) as f32
    }

    #[test]
    fn uniform_field_has_no_surface() {
        let g = grid_from(cube_grid(24), |_| 0.0);
        let m = extract(&g, DEFAULT_THRESHOLD, Polarity::Low, MAX_TRIANGLES);
        assert!(m.indices.is_empty() && m.positions.is_empty());
    }

    #[test]
    fn low_density_sphere_gives_a_sphere_of_that_radius() {
        let c = [20.0, 20.0, 20.0];
        let g = grid_from(cube_grid(41), |p| sphere_delta(p, c, 10.0));
        let m = extract(&g, DEFAULT_THRESHOLD, Polarity::Low, MAX_TRIANGLES);
        assert!(m.indices.len() > 300);
        for p in &m.positions {
            let d = dist(p.map(|v| v as f64), c);
            assert!((d - 10.0).abs() < 0.5, "{d}");
        }
        for (p, n) in m.positions.iter().zip(&m.normals) {
            let radial: [f64; 3] = std::array::from_fn(|a| p[a] as f64 - c[a]);
            let l = dist(p.map(|v| v as f64), c);
            let cos: f64 = (0..3).map(|a| radial[a] / l * n[a] as f64).sum();
            assert!(cos > 0.9, "normal off the radial direction: {cos}");
        }
    }

    #[test]
    fn high_polarity_finds_overdensities_only() {
        let c = [15.0, 15.0, 15.0];
        let g = grid_from(cube_grid(31), |p| (3.0 - dist(p, c) * 0.5) as f32);
        let high = extract(&g, 1.0, Polarity::High, MAX_TRIANGLES);
        assert!(high.indices.len() > 100);
        for p in &high.positions {
            assert!((dist(p.map(|v| v as f64), c) - 4.0).abs() < 0.5);
        }
    }

    /// Regression test for the false wall: a void cut by the survey edge must stay open.
    #[test]
    fn no_faces_near_the_outside() {
        let c = [20.0, 20.0, 20.0];
        // Everything with x > 22 is outside, right through the middle of the void.
        let g = grid_from(cube_grid(41), |p| if p[0] > 22.0 { f32::NAN } else { sphere_delta(p, c, 10.0) });
        let m = extract(&g, DEFAULT_THRESHOLD, Polarity::Low, MAX_TRIANGLES);
        assert!(!m.indices.is_empty());
        for p in &m.positions {
            assert!(p[0] <= 22.0 - 1.0 + 1e-3, "vertex at x={} is within one cell of the outside", p[0]);
        }
        // Nothing on the cut plane: all that remains is the sphere's own surface.
        for p in &m.positions {
            assert!((dist(p.map(|v| v as f64), c) - 10.0).abs() < 0.5);
        }
    }

    #[test]
    fn outside_cells_do_not_make_high_surfaces() {
        // The old +3 fill value would have produced a shell here; the mask must not.
        let g = grid_from(cube_grid(24), |p| if p[0] > 12.0 { f32::NAN } else { 0.0 });
        let m = extract(&g, 1.0, Polarity::High, MAX_TRIANGLES);
        assert!(m.indices.is_empty());
    }

    #[test]
    fn triangle_cap_truncates_and_reports() {
        let c = [20.0, 20.0, 20.0];
        let g = grid_from(cube_grid(41), |p| sphere_delta(p, c, 10.0));
        let m = extract(&g, DEFAULT_THRESHOLD, Polarity::Low, 10);
        assert!(m.truncated);
        assert_eq!(m.indices.len(), 30);
    }

    #[test]
    fn encoding_round_trips() {
        let c = [20.0, 20.0, 20.0];
        let g = grid_from(cube_grid(41), |p| sphere_delta(p, c, 10.0));
        let m = extract(&g, DEFAULT_THRESHOLD, Polarity::Low, MAX_TRIANGLES);
        let bytes = encode(&m, DEFAULT_THRESHOLD);
        let (back, thr) = decode(&bytes).unwrap();
        assert_eq!(thr, DEFAULT_THRESHOLD);
        assert_eq!(back.indices, m.indices);
        for a in 0..m.positions.len() {
            for ax in 0..3 {
                assert!((back.positions[a][ax] - m.positions[a][ax]).abs() < 0.01);
            }
            let cos: f32 = (0..3).map(|ax| back.normals[a][ax] * m.normals[a][ax]).sum();
            assert!(cos > 0.995, "{cos}");
        }
    }

    #[test]
    fn empty_mesh_encodes() {
        let (m, _) = decode(&encode(&Mesh::default(), -0.5)).unwrap();
        assert!(m.positions.is_empty());
    }
}
