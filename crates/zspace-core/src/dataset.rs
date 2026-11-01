//! The whole preprocessing pipeline, from galaxies to dataset files in memory.

use crate::cosmology::{to_spherical, OMEGA_L, OMEGA_M};
use crate::density::{self, DensityGrid, GridSpec};
use crate::footprint::{angular_range, Footprint, RECTANGULAR_MIN_FILL};
use crate::format::{
    write_hierarchy, Cosmology, DensityInfo, FootprintInfo, Metadata, OctreeInfo, Source, VoidEntry, FORMAT,
};
use crate::octree;
use crate::quantize::POINT_BYTES;
use crate::shells::{self, Polarity};
use crate::voids;
use crate::{bounds, layers, Galaxy};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;

pub const FILE_METADATA: &str = "metadata.json";
pub const FILE_HIERARCHY: &str = "hierarchy.bin";
pub const FILE_POINTS: &str = "points.bin";
pub const FILE_DENSITY: &str = "density.bin.gz";
pub const FILE_SHELLS: &str = "shells.bin.gz";
pub const FILE_VOIDS: &str = "voids.json";
pub const FILE_FOOTPRINT: &str = "footprint.bin";
pub const VOID_LAYER: &str = "voids";
pub const VOID_LIST_LAYER: &str = "void-list";

#[derive(Clone, Debug)]
pub struct Options {
    pub seed: u64,
    pub leaf_k: usize,
    pub max_depth: u8,
    pub threshold: f32,
    pub divisions: f64,
    pub sigma_cells: f64,
    pub max_triangles: usize,
    pub max_voids: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            seed: 1,
            leaf_k: octree::DEFAULT_K,
            max_depth: octree::DEFAULT_MAX_DEPTH,
            threshold: shells::DEFAULT_THRESHOLD,
            divisions: density::DEFAULT_DIVISIONS,
            sigma_cells: density::DEFAULT_SIGMA_CELLS,
            max_triangles: shells::MAX_TRIANGLES,
            max_voids: voids::DEFAULT_MAX_VOIDS,
        }
    }
}

/// A dataset in memory. `shells` and `density_q` are raw here and gzipped on writing.
pub struct Dataset {
    pub metadata: Metadata,
    pub hierarchy: Vec<u8>,
    pub points: Vec<u8>,
    pub density_q: Option<Vec<u8>>,
    pub shells: Option<Vec<u8>>,
    pub voids: Vec<VoidEntry>,
    pub footprint: Option<Vec<u8>>,
    pub shells_truncated: bool,
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::with_capacity(bytes.len() / 2), Compression::best());
    e.write_all(bytes).expect("writing to a Vec cannot fail");
    e.finish().expect("writing to a Vec cannot fail")
}

fn r_range(galaxies: &[Galaxy]) -> [f64; 2] {
    let mut r = [f64::MAX, f64::MIN];
    for g in galaxies {
        let d = to_spherical(g.pos).2;
        r = [r[0].min(d), r[1].max(d)];
    }
    r
}

/// Points only: the octree, its hierarchy and the metadata.
pub fn build_points(galaxies: &mut [Galaxy], source: Source, opts: &Options, progress: &mut dyn FnMut(&str)) -> Dataset {
    progress("octree");
    let bbox = bounds(galaxies);
    let radial = r_range(galaxies);
    let tree = octree::build(galaxies, opts.seed, opts.leaf_k, opts.max_depth);
    let root = &tree.nodes[0];
    let metadata = Metadata {
        format: FORMAT.into(),
        source,
        cosmology: Cosmology { om: OMEGA_M, ol: OMEGA_L, units: "Mpc/h".into() },
        bbox,
        r_range: radial,
        octree: OctreeInfo {
            root: [root.center[0] as f64, root.center[1] as f64, root.center[2] as f64, root.half as f64],
            leaf_k: opts.leaf_k as u32,
            nodes: tree.nodes.len() as u32,
            point_bytes: POINT_BYTES as u32,
            points: galaxies.len() as u64,
            split_files: false,
        },
        density: None,
        layers: Vec::new(),
        footprint: None,
    };
    Dataset {
        metadata,
        hierarchy: write_hierarchy(&tree.nodes),
        points: tree.points,
        density_q: None,
        shells: None,
        voids: Vec::new(),
        footprint: None,
        shells_truncated: false,
    }
}

/// Everything: octree, footprint, density grid, void surface and void list.
pub fn build(galaxies: &mut [Galaxy], source: Source, opts: &Options, progress: &mut dyn FnMut(&str)) -> Dataset {
    let mut ds = build_points(galaxies, source, opts, progress);

    progress("footprint");
    let footprint = Footprint::from_galaxies(galaxies);
    let range = angular_range(galaxies);
    let rectangular = !range.full_sky && footprint.box_fill(&range) >= RECTANGULAR_MIN_FILL;
    let count = galaxies.len().max(1) as f64;
    let centroid = std::array::from_fn(|a| galaxies.iter().map(|g| g.pos[a]).sum::<f64>() / count);
    ds.metadata.footprint = Some(FootprintInfo {
        healpix_nside: footprint.nside(),
        file: FILE_FOOTPRINT.into(),
        ra_range: range.ra,
        dec_range: range.dec,
        full_sky: range.full_sky,
        rectangular,
        outline: if range.full_sky || rectangular { Vec::new() } else { footprint.outline() },
        centroid,
    });

    progress("density");
    let spec = GridSpec::around(ds.metadata.bbox, opts.divisions);
    let field = density::compute(galaxies, &footprint, ds.metadata.r_range, spec, opts.sigma_cells);
    let grid = density::quantize(&field);
    drop(field);
    ds.metadata.density = Some(DensityInfo {
        file: FILE_DENSITY.into(),
        dims: [spec.dims[0] as u32, spec.dims[1] as u32, spec.dims[2] as u32],
        origin: spec.origin,
        cell: spec.cell,
        sigma_cells: opts.sigma_cells,
        encoding: density::ENCODING.into(),
    });

    progress("shells");
    let (shell_bytes, vertices, indices, truncated) = shell_bytes(&grid, opts.threshold, opts.max_triangles);
    ds.metadata.layers.push(layers::isosurface(
        VOID_LAYER,
        "ボイド（独自計算）",
        FILE_SHELLS,
        opts.threshold,
        Polarity::Low,
        layers::COLOR_DENSITY,
        vertices,
        indices,
    ));
    ds.shells_truncated = truncated;
    ds.shells = Some(shell_bytes);

    progress("voids");
    ds.voids = voids::find_simple(&grid, opts.threshold, opts.max_voids);
    ds.metadata.layers.push(layers::list(VOID_LIST_LAYER, "見つかったボイド", FILE_VOIDS, voids::METHOD_SIMPLE, VOID_LAYER));

    ds.density_q = Some(grid.q);
    ds.footprint = Some(footprint.bits);
    ds
}

/// Encodes the low-density surface at a threshold.
pub fn shell_bytes(grid: &DensityGrid, threshold: f32, max_triangles: usize) -> (Vec<u8>, usize, usize, bool) {
    let mesh = shells::extract(grid, threshold, Polarity::Low, max_triangles);
    (shells::encode(&mesh, threshold), mesh.positions.len(), mesh.indices.len(), mesh.truncated)
}

impl Dataset {
    /// The files to write, as `(name, bytes)`; shells and density are gzipped.
    pub fn files(&self) -> Vec<(String, Vec<u8>)> {
        let mut out = vec![(
            FILE_METADATA.to_string(),
            serde_json::to_vec(&self.metadata).expect("metadata always serializes"),
        )];
        out.push((FILE_HIERARCHY.to_string(), self.hierarchy.clone()));
        if let Some(b) = &self.density_q {
            out.push((FILE_DENSITY.to_string(), gzip(b)));
        }
        if let Some(b) = &self.shells {
            out.push((FILE_SHELLS.to_string(), gzip(b)));
        }
        if self.metadata.layers.iter().any(|l| l.id == VOID_LIST_LAYER) {
            out.push((FILE_VOIDS.to_string(), serde_json::to_vec(&self.voids).expect("voids always serialize")));
        }
        if let Some(b) = &self.footprint {
            out.push((FILE_FOOTPRINT.to_string(), b.clone()));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::read_hierarchy;
    use crate::mock;

    fn run(n: usize) -> Dataset {
        let mut g = mock::generate(n, 7);
        let source = Source { name: "test".into(), mock: true, query: None, rows: n as u64, dropped: 0 };
        build(&mut g, source, &Options::default(), &mut |_| {})
    }

    #[test]
    fn produces_every_file_with_consistent_metadata() {
        let d = run(60_000);
        let names: Vec<String> = d.files().into_iter().map(|f| f.0).collect();
        for want in [FILE_METADATA, FILE_HIERARCHY, FILE_DENSITY, FILE_SHELLS, FILE_VOIDS, FILE_FOOTPRINT] {
            assert!(names.iter().any(|n| n == want), "{want} missing from {names:?}");
        }
        let nodes = read_hierarchy(&d.hierarchy);
        assert_eq!(nodes.len() as u32, d.metadata.octree.nodes);
        assert_eq!(d.points.len() as u64, d.metadata.octree.points * 8);
        let info = d.metadata.density.as_ref().unwrap();
        assert_eq!(
            d.density_q.as_ref().unwrap().len(),
            (info.dims[0] * info.dims[1] * info.dims[2]) as usize
        );
    }

    #[test]
    fn metadata_round_trips_through_json() {
        let d = run(20_000);
        let text = serde_json::to_string(&d.metadata).unwrap();
        assert!(text.contains("\"rRange\"") && text.contains("\"Om\"") && !text.contains("\"voids\":"));
        let back: Metadata = serde_json::from_str(&text).unwrap();
        assert_eq!(back, d.metadata);
    }

    #[test]
    fn output_is_byte_identical_for_the_same_input() {
        let (a, b) = (run(30_000), run(30_000));
        assert_eq!(a.files(), b.files());
    }

    #[test]
    fn shipped_surface_matches_one_rebuilt_from_the_stored_grid() {
        let d = run(60_000);
        let info = d.metadata.density.as_ref().unwrap();
        let spec = GridSpec {
            dims: info.dims.map(|v| v as usize),
            origin: info.origin,
            cell: info.cell,
        };
        let grid = DensityGrid { spec, q: d.density_q.clone().unwrap() };
        let (again, ..) = shell_bytes(&grid, shells::DEFAULT_THRESHOLD, shells::MAX_TRIANGLES);
        assert_eq!(&again, d.shells.as_ref().unwrap());
    }

    #[test]
    fn mock_foam_produces_voids() {
        let d = run(300_000);
        assert!(d.voids.len() >= 10, "{}", d.voids.len());
        assert!(d.voids[0].radius > 15.0, "{}", d.voids[0].radius);
    }
}
