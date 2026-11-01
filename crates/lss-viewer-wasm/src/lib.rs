//! Browser bindings for lss-viewer-core: CSV import (U9), mock catalogs, and rebuilding the
//! surface when the threshold changes (U5). Runs in a Web Worker on one thread, because
//! static hosts such as GitHub Pages cannot set the headers that shared memory needs.

use js_sys::{Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use lss_viewer_core::catalog::{read_csv, AttrMap};
use lss_viewer_core::dataset::{self, Dataset, Options};
use lss_viewer_core::density::{DensityGrid, GridSpec};
use lss_viewer_core::format::Source;
use lss_viewer_core::{mock, shells, voids};

/// Fewer rows than this cannot show large-scale structure.
const MIN_ROWS: usize = 5000;

fn set(obj: &Object, key: &str, value: &JsValue) -> Result<(), JsError> {
    Reflect::set(obj, &JsValue::from_str(key), value).map_err(|_| JsError::new("failed to build the result"))?;
    Ok(())
}

fn bytes(b: &[u8]) -> JsValue {
    Uint8Array::from(b).into()
}

fn json<T: serde::Serialize>(v: &T) -> Result<JsValue, JsError> {
    Ok(JsValue::from_str(&serde_json::to_string(v).map_err(|e| JsError::new(&e.to_string()))?))
}

fn dataset_object(ds: &Dataset) -> Result<JsValue, JsError> {
    let out = Object::new();
    set(&out, "metadata", &json(&ds.metadata)?)?;
    set(&out, "hierarchy", &bytes(&ds.hierarchy))?;
    set(&out, "points", &bytes(&ds.points))?;
    set(&out, "shells", &bytes(ds.shells.as_deref().unwrap_or(&[])))?;
    set(&out, "density", &bytes(ds.density_q.as_deref().unwrap_or(&[])))?;
    set(&out, "voids", &json(&ds.voids)?)?;
    Ok(out.into())
}

fn reporter(progress: &Function) -> impl FnMut(&str) + '_ {
    move |stage: &str| {
        let _ = progress.call1(&JsValue::NULL, &JsValue::from_str(stage));
    }
}

fn options(threshold: f32, seed: u32) -> Options {
    Options { threshold, seed: seed as u64, ..Options::default() }
}

/// Builds a whole dataset from CSV bytes. `progress` receives stage names.
#[wasm_bindgen(js_name = buildFromCsv)]
pub fn build_from_csv(csv: &[u8], name: &str, threshold: f32, seed: u32, progress: &Function) -> Result<JsValue, JsError> {
    let (mut galaxies, report) =
        read_csv(csv, &AttrMap::auto(), seed as u64).map_err(|e| JsError::new(&e.to_string()))?;
    if galaxies.len() < MIN_ROWS {
        return Err(JsError::new(&format!(
            "有効な行が {} 行しかありません（z 0.003〜0.6）。もっと広い範囲で取得してください。",
            galaxies.len()
        )));
    }
    let source = Source { name: name.into(), mock: false, query: None, rows: report.rows, dropped: report.dropped() };
    let ds = dataset::build(&mut galaxies, source, &options(threshold, seed), &mut reporter(progress));
    dataset_object(&ds)
}

/// Builds a whole dataset from a generated mock catalog.
#[wasm_bindgen(js_name = buildMock)]
pub fn build_mock(n: u32, mock_seed: u32, threshold: f32, seed: u32, progress: &Function) -> Result<JsValue, JsError> {
    let mut galaxies = mock::generate(n as usize, mock_seed as u64);
    let source = Source { name: "模擬カタログ".into(), mock: true, query: None, rows: n as u64, dropped: 0 };
    let ds = dataset::build(&mut galaxies, source, &options(threshold, seed), &mut reporter(progress));
    dataset_object(&ds)
}

/// Rebuilds the surface and the simple void list from the stored grid.
/// Returns `{ shells: Uint8Array, voids: string, truncated: boolean }`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn remesh(
    q: &[u8],
    nx: u32,
    ny: u32,
    nz: u32,
    ox: f64,
    oy: f64,
    oz: f64,
    cell: f64,
    threshold: f32,
) -> Result<JsValue, JsError> {
    let spec = GridSpec { dims: [nx as usize, ny as usize, nz as usize], origin: [ox, oy, oz], cell };
    if q.len() != spec.len() {
        return Err(JsError::new("密度格子の大きさが metadata と一致しません。"));
    }
    let grid = DensityGrid { spec, q: q.to_vec() };
    let (encoded, _, _, truncated) = dataset::shell_bytes(&grid, threshold, shells::MAX_TRIANGLES);
    let list = voids::find_simple(&grid, threshold, voids::DEFAULT_MAX_VOIDS);
    let out = Object::new();
    set(&out, "shells", &bytes(&encoded))?;
    set(&out, "voids", &json(&list)?)?;
    set(&out, "truncated", &JsValue::from_bool(truncated))?;
    Ok(out.into())
}
