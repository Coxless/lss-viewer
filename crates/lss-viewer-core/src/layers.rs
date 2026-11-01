//! Structure layers: voids today, and the same shape for clusters, filaments and markers later.

use crate::format::{Layer, LayerKind};
use crate::shells::Polarity;
use serde_json::json;

/// Display colours. Cyan and magenta stay apart from the blue-white and amber galaxies.
pub const COLOR_DENSITY: &str = "#8ce0f7";
pub const COLOR_VAST: &str = "#f28ad0";

#[allow(clippy::too_many_arguments)]
pub fn isosurface(
    id: &str,
    name: &str,
    file: &str,
    threshold: f32,
    polarity: Polarity,
    color: &str,
    vertices: usize,
    indices: usize,
) -> Layer {
    Layer {
        id: id.into(),
        kind: LayerKind::Isosurface,
        name: name.into(),
        file: file.into(),
        params: json!({
            "threshold": threshold,
            "polarity": match polarity { Polarity::Low => "low", Polarity::High => "high" },
            "color": color,
            "vertices": vertices,
            "indices": indices,
        }),
    }
}

/// `surface` is the id of the isosurface layer that shows the same structures.
pub fn list(id: &str, name: &str, file: &str, method: &str, surface: &str) -> Layer {
    Layer {
        id: id.into(),
        kind: LayerKind::List,
        name: name.into(),
        file: file.into(),
        params: json!({ "method": method, "surface": surface }),
    }
}

/// Named regions of the sky that the viewer can highlight.
pub fn regions(id: &str, name: &str, file: &str) -> Layer {
    Layer { id: id.into(), kind: LayerKind::Regions, name: name.into(), file: file.into(), params: json!({}) }
}
