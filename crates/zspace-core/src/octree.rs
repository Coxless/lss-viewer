//! LOD octree: shuffle once, then each node keeps the first K of its points and passes
//! the rest to its children with a stable split. Because the input is shuffled and the
//! split is stable, every node is a uniform random sample of its region, so clustering
//! survives thinning (which Poisson-disk sampling would erase).

use crate::format::HierarchyNode;
use crate::par;
use crate::quantize::{self, POINT_BYTES};
use crate::Galaxy;
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

pub const DEFAULT_K: usize = 4096;
pub const DEFAULT_MAX_DEPTH: u8 = 14;
const PARALLEL_MIN_POINTS: usize = 50_000;

struct Tmp {
    center: [f64; 3],
    half: f64,
    depth: u8,
    own: std::ops::Range<usize>,
    children: Vec<(u8, Tmp)>,
}

pub struct Octree {
    pub nodes: Vec<HierarchyNode>,
    /// All quantized points, in the same breadth-first order as `nodes`.
    pub points: Vec<u8>,
}

/// Fisher-Yates with a seeded stream.
pub fn shuffle(galaxies: &mut [Galaxy], seed: u64) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    for i in (1..galaxies.len()).rev() {
        let j = (((rng.next_u32() as u64) * (i as u64 + 1)) >> 32) as usize;
        galaxies.swap(i, j);
    }
}

fn octant(p: &[f64; 3], c: &[f64; 3]) -> usize {
    (p[0] >= c[0]) as usize | ((p[1] >= c[1]) as usize) << 1 | ((p[2] >= c[2]) as usize) << 2
}

/// Builds one subtree. `items` starts `base` entries into the whole array.
fn build_node(
    items: &mut [Galaxy],
    base: usize,
    center: [f64; 3],
    half: f64,
    depth: u8,
    k: usize,
    max_depth: u8,
) -> Tmp {
    let own_len = if depth >= max_depth { items.len() } else { k.min(items.len()) };
    let mut node = Tmp { center, half, depth, own: base..base + own_len, children: Vec::new() };
    if own_len == items.len() {
        return node;
    }
    let (_, rest) = items.split_at_mut(own_len);

    // Stable 8-way split.
    let mut counts = [0usize; 8];
    for g in rest.iter() {
        counts[octant(&g.pos, &center)] += 1;
    }
    let mut start = [0usize; 8];
    for o in 1..8 {
        start[o] = start[o - 1] + counts[o - 1];
    }
    let mut next = start;
    let mut sorted = vec![rest[0]; rest.len()];
    for g in rest.iter() {
        let o = octant(&g.pos, &center);
        sorted[next[o]] = *g;
        next[o] += 1;
    }
    rest.copy_from_slice(&sorted);
    drop(sorted);

    // Hand each non-empty octant to a child.
    let mut parts: Vec<(u8, usize, &mut [Galaxy])> = Vec::new();
    let mut remaining = rest;
    let mut offset = base + own_len;
    for o in 0..8u8 {
        let (head, tail) = remaining.split_at_mut(counts[o as usize]);
        remaining = tail;
        if !head.is_empty() {
            parts.push((o, offset, head));
        }
        offset += counts[o as usize];
    }
    node.children = build_children(parts, center, half, depth, k, max_depth);
    node
}

fn build_children(
    mut parts: Vec<(u8, usize, &mut [Galaxy])>,
    center: [f64; 3],
    half: f64,
    depth: u8,
    k: usize,
    max_depth: u8,
) -> Vec<(u8, Tmp)> {
    let build = |o: u8, base: usize, items: &mut [Galaxy]| {
        let h = half / 2.0;
        let c = std::array::from_fn(|a| center[a] + if o >> a & 1 == 1 { h } else { -h });
        (o, build_node(items, base, c, h, depth + 1, k, max_depth))
    };
    let total: usize = parts.iter().map(|p| p.2.len()).sum();
    if parts.len() > 1 && total >= PARALLEL_MIN_POINTS {
        let tail = parts.split_off(parts.len() / 2);
        let (mut a, b) = par::join(
            || build_children(parts, center, half, depth, k, max_depth),
            || build_children(tail, center, half, depth, k, max_depth),
        );
        a.extend(b);
        a
    } else {
        parts.into_iter().map(|(o, base, items)| build(o, base, items)).collect()
    }
}

/// Node centres are stored as f32, so the stored half size is grown just enough that
/// every point in the node still fits inside the quantization range after rounding.
fn stored_box(center: [f64; 3], half: f64) -> ([f32; 3], f32) {
    let c: [f32; 3] = center.map(|v| v as f32);
    let slip = (0..3).map(|a| (c[a] as f64 - center[a]).abs()).fold(0.0, f64::max);
    let h = (half + slip) as f32;
    let h = if (h as f64) < half + slip { h.next_up() } else { h };
    (c, h)
}

/// Shuffles `galaxies` in place and builds the tree. The root is the cube around their bounds.
pub fn build(galaxies: &mut [Galaxy], seed: u64, k: usize, max_depth: u8) -> Octree {
    assert!(!galaxies.is_empty(), "empty catalog");
    assert!(k > 0);
    let b = crate::bounds(galaxies);
    let center = [(b[0] + b[3]) / 2.0, (b[1] + b[4]) / 2.0, (b[2] + b[5]) / 2.0];
    let half = ((b[3] - b[0]).max(b[4] - b[1]).max(b[5] - b[2]) / 2.0 * 1.000_001).max(1e-3);
    shuffle(galaxies, seed);
    let root = build_node(galaxies, 0, center, half, 0, k, max_depth);

    // Breadth-first numbering and output.
    let mut nodes = Vec::new();
    let mut points = Vec::with_capacity(galaxies.len() * POINT_BYTES);
    let mut level: Vec<&Tmp> = vec![&root];
    let mut next_first = 1u32;
    while !level.is_empty() {
        let mut next_level = Vec::new();
        for t in &level {
            let (c, h) = stored_box(t.center, t.half);
            let own = &galaxies[t.own.clone()];
            let byte_offset = points.len() as u32;
            for g in own {
                quantize::encode(g, c, h, &mut points);
            }
            let mut child_mask = 0u8;
            for (o, child) in &t.children {
                child_mask |= 1 << o;
                next_level.push(child);
            }
            nodes.push(HierarchyNode {
                center: c,
                half: h,
                byte_offset,
                count: own.len() as u32,
                child_mask,
                depth: t.depth,
                first_child: if t.children.is_empty() { 0 } else { next_first },
            });
            next_first += t.children.len() as u32;
        }
        level = next_level;
    }
    Octree { nodes, points }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock;
    use crate::quantize::decode;
    use std::collections::HashMap;

    fn tree(n: usize, k: usize, depth: u8) -> (Vec<Galaxy>, Octree) {
        let mut g = mock::generate(n, 11);
        let t = build(&mut g, 2, k, depth);
        (g, t)
    }

    #[test]
    fn every_point_lands_in_exactly_one_node() {
        let (g, t) = tree(50_000, 512, 14);
        assert_eq!(t.nodes.iter().map(|n| n.count as usize).sum::<usize>(), g.len());
        assert_eq!(t.points.len(), g.len() * POINT_BYTES);
        // Each galaxy's attribute count matches between input and output.
        let mut want: HashMap<u16, i64> = HashMap::new();
        for x in &g {
            *want.entry(x.attr).or_default() += 1;
        }
        for chunk in t.points.chunks(8) {
            *want.entry(i16::from_le_bytes([chunk[6], chunk[7]]) as u16).or_default() -= 1;
        }
        assert!(want.values().all(|&v| v == 0));
    }

    #[test]
    fn nodes_hold_at_most_k_except_at_the_deepest_level() {
        let (_, t) = tree(50_000, 256, 3);
        assert!(t.nodes.iter().any(|n| n.depth == 3 && n.count > 256));
        for n in &t.nodes {
            assert!(n.count <= 256 || n.depth == 3);
        }
    }

    #[test]
    fn quantization_error_is_within_the_stored_half_size() {
        let (_, t) = tree(30_000, 128, 14);
        let mut sorted = mock::generate(30_000, 11);
        // Same seed, same shuffle, so the decoded set must match the input closely.
        let c = build(&mut sorted, 2, 128, 14);
        assert_eq!(c.points, t.points);
        let mut input: Vec<[f64; 3]> = mock::generate(30_000, 11).iter().map(|g| g.pos).collect();
        input.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for n in &t.nodes {
            let bytes = &t.points[n.byte_offset as usize..(n.byte_offset + n.count * 8) as usize];
            for p in bytes.chunks(8) {
                let d = decode(p, n.center, n.half);
                let tol = n.half as f64 / 32767.0;
                let at = input.partition_point(|v| v[0] < d.pos[0] - tol);
                let hit = input[at..].iter().take_while(|v| v[0] <= d.pos[0] + tol).any(|v| {
                    (v[1] - d.pos[1]).abs() <= tol && (v[2] - d.pos[2]).abs() <= tol
                });
                assert!(hit, "no input point within {tol} of {:?}", d.pos);
            }
        }
    }

    #[test]
    fn child_index_follows_the_mask() {
        let (_, t) = tree(50_000, 256, 14);
        for n in &t.nodes {
            let mut idx = n.first_child as usize;
            for o in 0..8u8 {
                if n.child_mask >> o & 1 == 0 {
                    continue;
                }
                let c = &t.nodes[idx];
                assert_eq!(c.depth, n.depth + 1);
                for a in 0..3 {
                    let expect_above = o >> a & 1 == 1;
                    assert_eq!(c.center[a] > n.center[a], expect_above);
                }
                idx += 1;
            }
        }
    }

    #[test]
    fn upper_levels_are_an_unbiased_sample() {
        // The radial distribution of the root must match that of the whole catalog.
        let (g, t) = tree(100_000, 4096, 14);
        let frac_near = |pts: &mut dyn Iterator<Item = [f64; 3]>| {
            let (mut near, mut all) = (0.0f64, 0.0f64);
            for p in pts {
                all += 1.0;
                if p[0] * p[0] + p[1] * p[1] + p[2] * p[2] < 300.0 * 300.0 {
                    near += 1.0;
                }
            }
            near / all
        };
        let root = &t.nodes[0];
        let whole = frac_near(&mut g.iter().map(|g| g.pos));
        let top = frac_near(&mut t.points[..root.count as usize * 8].chunks(8).map(|p| decode(p, root.center, root.half).pos));
        assert!((whole - top).abs() < 0.03, "{whole} vs {top}");
    }

    #[test]
    fn parallel_split_is_deterministic() {
        let (_, a) = tree(120_000, 1024, 14);
        let (_, b) = tree(120_000, 1024, 14);
        assert_eq!(a.points, b.points);
    }
}
