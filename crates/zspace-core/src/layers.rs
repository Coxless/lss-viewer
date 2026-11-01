//! Structure layers: voids today, and the same shape for clusters, filaments and markers later.

use crate::format::{Layer, LayerKind};
use crate::shells::Polarity;
use serde_json::json;

pub fn isosurface(id: &str, name: &str, file: &str, threshold: f32, polarity: Polarity, vertices: usize, indices: usize) -> Layer {
    Layer {
        id: id.into(),
        kind: LayerKind::Isosurface,
        name: name.into(),
        file: file.into(),
        params: json!({
            "threshold": threshold,
            "polarity": match polarity { Polarity::Low => "low", Polarity::High => "high" },
            "vertices": vertices,
            "indices": indices,
        }),
    }
}

pub fn list(id: &str, name: &str, file: &str, method: &str) -> Layer {
    Layer { id: id.into(), kind: LayerKind::List, name: name.into(), file: file.into(), params: json!({ "method": method }) }
}
