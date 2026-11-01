//! The dataset format (`zspace/1`). `docs/format.md` is the written contract; this
//! module is its only implementation on the Rust side.

use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "zspace/1";
pub const HIERARCHY_RECORD: usize = 32;

/// One fixed 32-byte record in `hierarchy.bin`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HierarchyNode {
    pub center: [f32; 3],
    pub half: f32,
    pub byte_offset: u32,
    pub count: u32,
    pub child_mask: u8,
    pub depth: u8,
    pub first_child: u32,
}

impl HierarchyNode {
    pub fn write(&self, out: &mut Vec<u8>) {
        for v in self.center {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.half.to_le_bytes());
        out.extend_from_slice(&self.byte_offset.to_le_bytes());
        out.extend_from_slice(&self.count.to_le_bytes());
        out.push(self.child_mask);
        out.push(self.depth);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.first_child.to_le_bytes());
    }

    pub fn read(b: &[u8]) -> Self {
        let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        let u = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
        Self {
            center: [f(0), f(4), f(8)],
            half: f(12),
            byte_offset: u(16),
            count: u(20),
            child_mask: b[24],
            depth: b[25],
            first_child: u(28),
        }
    }
}

pub fn write_hierarchy(nodes: &[HierarchyNode]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nodes.len() * HIERARCHY_RECORD);
    for n in nodes {
        n.write(&mut out);
    }
    out
}

pub fn read_hierarchy(bytes: &[u8]) -> Vec<HierarchyNode> {
    bytes.as_chunks::<HIERARCHY_RECORD>().0.iter().map(|c| HierarchyNode::read(c)).collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub format: String,
    pub source: Source,
    pub cosmology: Cosmology,
    pub bbox: [f64; 6],
    pub r_range: [f64; 2],
    pub octree: OctreeInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<DensityInfo>,
    pub layers: Vec<Layer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footprint: Option<FootprintInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    /// Marks a synthetic catalog so the viewer can say so.
    #[serde(default)]
    pub mock: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    pub rows: u64,
    pub dropped: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cosmology {
    #[serde(rename = "Om")]
    pub om: f64,
    #[serde(rename = "OL")]
    pub ol: f64,
    pub units: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OctreeInfo {
    /// `[cx, cy, cz, half]` of the root node.
    pub root: [f64; 4],
    pub leaf_k: u32,
    pub nodes: u32,
    pub point_bytes: u32,
    pub points: u64,
    /// Set when the dataset was written with `--split-files`.
    #[serde(default)]
    pub split_files: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DensityInfo {
    pub file: String,
    pub dims: [u32; 3],
    pub origin: [f64; 3],
    pub cell: f64,
    pub sigma_cells: f64,
    pub encoding: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LayerKind {
    Isosurface,
    List,
    Polyline,
    Markers,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub kind: LayerKind,
    /// Display name; the viewer builds its labels from this.
    pub name: String,
    pub file: String,
    pub params: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FootprintInfo {
    pub healpix_nside: u32,
    pub file: String,
    /// Survey edges used for the frame. `raRange[0] > raRange[1]` wraps through 0.
    pub ra_range: [f64; 2],
    pub dec_range: [f64; 2],
    pub full_sky: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoidEntry {
    pub id: String,
    pub center: [f64; 3],
    pub radius: f64,
    pub delta_min: f64,
    pub method: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hierarchy_record_is_32_bytes_and_round_trips() {
        let n = HierarchyNode {
            center: [1.5, -2.5, 3.25],
            half: 64.0,
            byte_offset: 123456,
            count: 4096,
            child_mask: 0b1010_0101,
            depth: 7,
            first_child: 99,
        };
        let bytes = write_hierarchy(&[n, n]);
        assert_eq!(bytes.len(), 64);
        assert_eq!(read_hierarchy(&bytes), vec![n, n]);
    }
}
