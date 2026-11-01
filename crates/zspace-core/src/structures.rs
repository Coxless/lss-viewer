//! Famous structures: a hand-written catalog, checked against a dataset.
//!
//! The viewer colours galaxies by testing these regions in a shader, so `Geometry::contains`
//! has twins in `web/src/data/structures.ts` and `web/src/gl/renderer.ts`. A sky box is tested
//! with half-planes rather than angles, which needs no trigonometry per point and handles
//! RA 0 without a special case. That is why a box must span less than 180 degrees of RA.

use crate::cosmology::{sin_deg, to_cartesian, to_spherical, DistanceTable};
use crate::footprint::Footprint;
use libm::{cos, sqrt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::f64::consts::PI;

pub const FILE_STRUCTURES: &str = "structures.json";
pub const LAYER_ID: &str = "structures";
/// A structure is listed as visible when at least this share of its region was observed.
pub const MIN_COVERAGE: f64 = 0.5;
/// Samples along each side of a region, for coverage and expected counts.
const SAMPLE_SIDE: usize = 40;
const RADIAL_BIN: f64 = 10.0;
/// The farthest catalog entries are at z of about 2.
const MAX_REDSHIFT: f64 = 2.5;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cluster,
    Supercluster,
    Wall,
    Void,
}

/// How the viewer flies to a structure: a thin fan, or an orbit around it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Fan,
    Orbit,
}

/// A region as the literature gives it. Angles in degrees; `radius` in Mpc/h.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "shape", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Region {
    Sphere { ra: f64, dec: f64, z: f64, radius: f64 },
    /// `ra[0] > ra[1]` wraps through 0.
    SkyBox { ra: [f64; 2], dec: [f64; 2], z: [f64; 2] },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub region: Region,
    /// Only galaxies at or above this density contrast get the colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_delta: Option<f64>,
    pub color: String,
    pub view: View,
    /// Slab thickness in Mpc/h for a fan view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    pub summary: String,
    pub size: String,
    pub discovery: String,
    /// Where the region's numbers came from.
    pub basis: String,
    pub refs: Vec<Reference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub structures: Vec<CatalogEntry>,
}

/// A region in the dataset's coordinates.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "shape", rename_all = "kebab-case")]
pub enum Geometry {
    Sphere { center: [f64; 3], radius: f64 },
    SkyBox { ra: [f64; 2], dec: [f64; 2], r: [f64; 2] },
}

fn ra_width(ra: [f64; 2]) -> f64 {
    (ra[1] - ra[0]).rem_euclid(360.0)
}

fn length(p: [f64; 3]) -> f64 {
    sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    length([a[0] - b[0], a[1] - b[1], a[2] - b[2]])
}

impl Geometry {
    pub fn contains(&self, p: [f64; 3]) -> bool {
        match *self {
            Geometry::Sphere { center, radius } => distance(p, center) <= radius,
            Geometry::SkyBox { ra, dec, r } => {
                let d = length(p);
                if d < r[0] || d > r[1] {
                    return false;
                }
                // Inward normals of the two meridian planes.
                let (a0, a1) = (ra[0] * PI / 180.0, ra[1] * PI / 180.0);
                let east = -libm::sin(a0) * p[0] + cos(a0) * p[1];
                let west = libm::sin(a1) * p[0] - cos(a1) * p[1];
                east >= 0.0 && west >= 0.0 && p[2] >= d * sin_deg(dec[0]) && p[2] <= d * sin_deg(dec[1])
            }
        }
    }

    fn nominal_center(&self) -> [f64; 3] {
        match *self {
            Geometry::Sphere { center, .. } => center,
            Geometry::SkyBox { ra, dec, r } => {
                to_cartesian(ra[0] + ra_width(ra) / 2.0, (dec[0] + dec[1]) / 2.0, (r[0] + r[1]) / 2.0)
            }
        }
    }

    /// Equal-volume sample points, with the volume each one stands for.
    fn samples(&self) -> (Vec<[f64; 3]>, f64) {
        let n = SAMPLE_SIDE;
        let mid = |i: usize| (i as f64 + 0.5) / n as f64;
        let mut out = Vec::with_capacity(n * n * n);
        match *self {
            Geometry::Sphere { center, radius } => {
                for k in 0..n {
                    for j in 0..n {
                        for i in 0..n {
                            let o = [(2.0 * mid(i) - 1.0), (2.0 * mid(j) - 1.0), (2.0 * mid(k) - 1.0)];
                            if length(o) <= 1.0 {
                                out.push(std::array::from_fn(|a| center[a] + o[a] * radius));
                            }
                        }
                    }
                }
                let total = 4.0 / 3.0 * PI * radius * radius * radius;
                let each = total / out.len() as f64;
                (out, each)
            }
            Geometry::SkyBox { ra, dec, r } => {
                let (s0, s1) = (sin_deg(dec[0]), sin_deg(dec[1]));
                let (c0, c1) = (r[0] * r[0] * r[0], r[1] * r[1] * r[1]);
                let width = ra_width(ra);
                for k in 0..n {
                    let radius = libm::cbrt(c0 + (c1 - c0) * mid(k));
                    for j in 0..n {
                        let declination = libm::asin(s0 + (s1 - s0) * mid(j)) * 180.0 / PI;
                        for i in 0..n {
                            out.push(to_cartesian(ra[0] + width * mid(i), declination, radius));
                        }
                    }
                }
                let total = width * PI / 180.0 * (s1 - s0) * (c1 - c0) / 3.0;
                let each = total / out.len() as f64;
                (out, each)
            }
        }
    }
}

impl Region {
    pub fn geometry(&self, table: &DistanceTable) -> Geometry {
        match *self {
            Region::Sphere { ra, dec, z, radius } => {
                Geometry::Sphere { center: to_cartesian(ra, dec, table.distance(z)), radius }
            }
            Region::SkyBox { ra, dec, z } => Geometry::SkyBox { ra, dec, r: [table.distance(z[0]), table.distance(z[1])] },
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Visible,
    Outside,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    TooNear,
    TooFar,
    OutOfSurvey,
}

/// One entry of `structures.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    #[serde(flatten)]
    pub entry: CatalogEntry,
    pub geometry: Geometry,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    /// Share of the region inside the survey, 0..1.
    pub coverage: f64,
    pub galaxies: u64,
    /// Galaxies over the number expected at the mean density for that distance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ratio: Option<f64>,
    /// Centre of the observed part, where a label goes and a flight ends.
    pub center: [f64; 3],
    /// Radius around `center` that holds the observed part.
    pub extent: f64,
    /// Distance from the observer in Mpc/h.
    pub distance: f64,
}

pub fn parse_catalog(text: &str) -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_str(text).map_err(|e| format!("カタログを読めません: {e}"))?;
    validate(&catalog)?;
    Ok(catalog)
}

fn validate(catalog: &Catalog) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for e in &catalog.structures {
        let fail = |what: &str| Err(format!("{}: {what}", e.id));
        // Ids travel in the URL, separated by commas.
        if e.id.is_empty() || !e.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return fail("id は英小文字、数字、ハイフンだけにしてください");
        }
        if !seen.insert(e.id.as_str()) {
            return fail("id が重複しています");
        }
        if e.refs.is_empty() {
            return fail("出典がありません");
        }
        let hex = e.color.len() == 7 && e.color.starts_with('#') && e.color[1..].chars().all(|c| c.is_ascii_hexdigit());
        if !hex {
            return fail("color は #rrggbb で書いてください");
        }
        match e.region {
            Region::Sphere { radius, z, .. } => {
                if radius <= 0.0 || z < 0.0 || z > MAX_REDSHIFT {
                    return fail("radius か z が範囲外です");
                }
            }
            Region::SkyBox { ra, dec, z } => {
                let width = ra_width(ra);
                if width <= 0.0 || width >= 180.0 {
                    return fail("sky-box の赤経の幅は 0° より大きく 180° 未満にしてください");
                }
                if dec[0] >= dec[1] || z[0] >= z[1] || z[0] < 0.0 || z[1] > MAX_REDSHIFT {
                    return fail("sky-box の dec か z の範囲が正しくありません");
                }
                // A void is drawn as a sphere, because it has no galaxies to colour.
                if e.kind == Kind::Void {
                    return fail("ボイドの領域は sphere にしてください");
                }
            }
        }
    }
    Ok(())
}

/// Galaxies per unit volume by distance, over the observed sky.
struct RadialDensity {
    start: f64,
    density: Vec<f64>,
}

impl RadialDensity {
    fn new(positions: &[[f64; 3]], footprint: &Footprint, r_range: [f64; 2]) -> Self {
        let pixels: u32 = footprint.bits.iter().map(|b| b.count_ones()).sum();
        let sky = pixels as f64 / (12u64 << (2 * footprint.depth as u64)) as f64;
        let bins = ((r_range[1] - r_range[0]) / RADIAL_BIN).ceil().max(1.0) as usize;
        let mut count = vec![0u64; bins];
        for &p in positions {
            let k = ((length(p) - r_range[0]) / RADIAL_BIN).max(0.0) as usize;
            count[k.min(bins - 1)] += 1;
        }
        let density = count
            .iter()
            .enumerate()
            .map(|(k, &c)| {
                let (a, b) = (r_range[0] + k as f64 * RADIAL_BIN, r_range[0] + (k + 1) as f64 * RADIAL_BIN);
                c as f64 / (4.0 / 3.0 * PI * (b * b * b - a * a * a) * sky)
            })
            .collect();
        Self { start: r_range[0], density }
    }

    fn at(&self, r: f64) -> f64 {
        let k = ((r - self.start) / RADIAL_BIN).max(0.0) as usize;
        self.density[k.min(self.density.len() - 1)]
    }
}

fn round(v: f64, k: f64) -> f64 {
    (v * k).round() / k
}

/// Measures every entry against the dataset's galaxies and survey mask.
pub fn assess(catalog: &Catalog, positions: &[[f64; 3]], footprint: &Footprint, r_range: [f64; 2]) -> Vec<Structure> {
    let table = DistanceTable::new(MAX_REDSHIFT);
    let radial = RadialDensity::new(positions, footprint, r_range);
    catalog
        .structures
        .iter()
        .map(|entry| {
            let geometry = entry.region.geometry(&table);
            let (samples, each) = geometry.samples();
            let in_range = |p: [f64; 3]| (r_range[0]..=r_range[1]).contains(&length(p));
            let observed: Vec<[f64; 3]> = samples.iter().copied().filter(|&p| in_range(p) && footprint.contains(p)).collect();
            let range_share = samples.iter().filter(|&&p| in_range(p)).count() as f64 / samples.len() as f64;
            let coverage = observed.len() as f64 / samples.len() as f64;

            let galaxies = positions.iter().filter(|&&p| geometry.contains(p)).count() as u64;
            let expected: f64 = observed.iter().map(|&p| each * radial.at(length(p))).sum();
            let ratio = (expected > 0.0).then(|| round(galaxies as f64 / expected, 100.0));

            let visible = coverage >= MIN_COVERAGE && galaxies > 0;
            let nominal = geometry.nominal_center();
            let reason = (!visible).then(|| {
                if range_share >= MIN_COVERAGE {
                    Reason::OutOfSurvey
                } else if to_spherical(nominal).2 < r_range[0] {
                    Reason::TooNear
                } else {
                    Reason::TooFar
                }
            });

            let from = if observed.is_empty() { &samples } else { &observed };
            let mut center = [0.0; 3];
            for p in from {
                for a in 0..3 {
                    center[a] += p[a] / from.len() as f64;
                }
            }
            // One sample spacing of margin, because samples stop short of the true edge.
            let spacing = libm::cbrt(each);
            let extent = from.iter().map(|&p| distance(p, center)).fold(0.0, f64::max) + spacing;

            Structure {
                entry: entry.clone(),
                geometry: rounded_geometry(geometry),
                status: if visible { Status::Visible } else { Status::Outside },
                reason,
                coverage: round(coverage, 1000.0),
                galaxies,
                ratio,
                center: center.map(|v| round(v, 100.0)),
                extent: round(extent, 100.0),
                distance: round(length(center), 10.0),
            }
        })
        .collect()
}

fn rounded_geometry(g: Geometry) -> Geometry {
    match g {
        Geometry::Sphere { center, radius } => Geometry::Sphere { center: center.map(|v| round(v, 1000.0)), radius },
        Geometry::SkyBox { ra, dec, r } => Geometry::SkyBox { ra, dec, r: r.map(|v| round(v, 1000.0)) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, kind: Kind, region: Region) -> CatalogEntry {
        CatalogEntry {
            id: id.into(),
            name: id.into(),
            kind,
            region,
            min_delta: None,
            color: "#ffaa00".into(),
            view: View::Orbit,
            thickness: None,
            summary: String::new(),
            size: String::new(),
            discovery: String::new(),
            basis: String::new(),
            refs: vec![Reference { label: "x".into(), url: "https://example.org".into() }],
        }
    }

    /// Every pixel with a galaxy in it counts as observed, so a dense uniform cloud
    /// over one patch of sky gives a footprint of that patch. The points follow a
    /// low-discrepancy sequence, because a regular grid would leave holes in the mask.
    fn cloud(ra: [f64; 2], dec: [f64; 2], r: [f64; 2]) -> (Vec<[f64; 3]>, Footprint) {
        const STEPS: [f64; 3] = [0.8191725133961645, 0.6710436067037893, 0.5497004779019703];
        let (s0, s1) = (sin_deg(dec[0]), sin_deg(dec[1]));
        let (c0, c1) = (r[0] * r[0] * r[0], r[1] * r[1] * r[1]);
        let positions: Vec<[f64; 3]> = (1..=300_000)
            .map(|i| {
                let t = STEPS.map(|s| (i as f64 * s).fract());
                let d = libm::asin(s0 + (s1 - s0) * t[1]) * 180.0 / PI;
                to_cartesian(ra[0] + ra_width(ra) * t[0], d, libm::cbrt(c0 + (c1 - c0) * t[2]))
            })
            .collect();
        let galaxies: Vec<crate::Galaxy> = positions.iter().map(|&pos| crate::Galaxy { pos, attr: 0 }).collect();
        (positions, Footprint::from_galaxies(&galaxies))
    }

    #[test]
    fn sky_box_contains_points_on_the_right_side_of_ra_zero() {
        let g = Geometry::SkyBox { ra: [350.0, 10.0], dec: [-5.0, 5.0], r: [90.0, 110.0] };
        assert!(g.contains(to_cartesian(355.0, 0.0, 100.0)));
        assert!(g.contains(to_cartesian(5.0, 0.0, 100.0)));
        assert!(!g.contains(to_cartesian(20.0, 0.0, 100.0)));
        assert!(!g.contains(to_cartesian(340.0, 0.0, 100.0)));
        assert!(!g.contains(to_cartesian(180.0, 0.0, 100.0)));
        assert!(!g.contains(to_cartesian(355.0, 6.0, 100.0)));
        assert!(!g.contains(to_cartesian(355.0, 0.0, 120.0)));
    }

    #[test]
    fn sky_box_samples_fall_inside_and_add_up_to_its_volume() {
        let g = Geometry::SkyBox { ra: [350.0, 10.0], dec: [-5.0, 5.0], r: [90.0, 110.0] };
        let (samples, each) = g.samples();
        assert!(samples.iter().all(|&p| g.contains(p)));
        let want = 20f64.to_radians() * 2.0 * sin_deg(5.0) * (110f64.powi(3) - 90f64.powi(3)) / 3.0;
        assert!((each * samples.len() as f64 - want).abs() / want < 1e-9);
    }

    #[test]
    fn sphere_samples_add_up_to_its_volume() {
        let g = Geometry::Sphere { center: [1.0, 2.0, 3.0], radius: 10.0 };
        let (samples, each) = g.samples();
        assert!(samples.iter().all(|&p| g.contains(p)));
        assert!((each * samples.len() as f64 - 4.0 / 3.0 * PI * 1000.0).abs() < 1.0);
    }

    fn sphere(ra: f64, dec: f64, z: f64, radius: f64) -> Region {
        Region::Sphere { ra, dec, z, radius }
    }

    #[test]
    fn status_says_why_a_structure_cannot_be_seen() {
        let table = DistanceTable::new(1.0);
        let r = [table.distance(0.02), table.distance(0.1)];
        let (positions, footprint) = cloud([170.0, 200.0], [0.0, 30.0], r);
        let catalog = Catalog {
            structures: vec![
                entry("inside", Kind::Cluster, sphere(185.0, 15.0, 0.06, 5.0)),
                entry("near", Kind::Cluster, sphere(185.0, 15.0, 0.002, 3.0)),
                entry("far", Kind::Wall, sphere(185.0, 15.0, 0.47, 50.0)),
                entry("elsewhere", Kind::Supercluster, sphere(20.0, -40.0, 0.06, 10.0)),
            ],
        };
        let out = assess(&catalog, &positions, &footprint, r);
        assert_eq!(out[0].status, Status::Visible);
        assert_eq!(out[0].reason, None);
        assert!(out[0].coverage > 0.99);
        assert_eq!(out[1].reason, Some(Reason::TooNear));
        assert_eq!(out[2].reason, Some(Reason::TooFar));
        assert_eq!(out[3].reason, Some(Reason::OutOfSurvey));
        assert_eq!(out[3].status, Status::Outside);
    }

    #[test]
    fn a_uniform_catalog_has_a_ratio_near_one_and_a_clump_has_more() {
        let table = DistanceTable::new(1.0);
        let r = [table.distance(0.02), table.distance(0.1)];
        let (mut positions, footprint) = cloud([170.0, 200.0], [0.0, 30.0], r);
        let region = sphere(185.0, 15.0, 0.06, 12.0);
        let catalog = Catalog { structures: vec![entry("a", Kind::Supercluster, region)] };
        let uniform = assess(&catalog, &positions, &footprint, r)[0].ratio.unwrap();
        assert!((uniform - 1.0).abs() < 0.2, "{uniform}");

        let center = region.geometry(&table);
        let Geometry::Sphere { center, .. } = center else { unreachable!() };
        positions.extend(std::iter::repeat_n(center, 5000));
        let clumped = assess(&catalog, &positions, &footprint, r)[0].ratio.unwrap();
        assert!(clumped > 2.0 * uniform, "{clumped}");
    }

    #[test]
    fn the_centre_follows_the_observed_part_of_a_region() {
        let table = DistanceTable::new(1.0);
        let r = [table.distance(0.02), table.distance(0.1)];
        let (positions, footprint) = cloud([170.0, 200.0], [0.0, 30.0], r);
        // Half of this box lies beyond the survey's western edge.
        let region = Region::SkyBox { ra: [185.0, 215.0], dec: [5.0, 25.0], z: [0.04, 0.08] };
        let catalog = Catalog { structures: vec![entry("edge", Kind::Wall, region)] };
        let out = &assess(&catalog, &positions, &footprint, r)[0];
        let (ra, _, _) = to_spherical(out.center);
        assert!(ra < 197.0, "{ra}");
    }

    #[test]
    fn catalog_rules_are_enforced() {
        let good = entry("a", Kind::Cluster, sphere(10.0, 0.0, 0.05, 5.0));
        let check = |structures: Vec<CatalogEntry>| validate(&Catalog { structures });
        assert!(check(vec![good.clone()]).is_ok());
        assert!(check(vec![good.clone(), good.clone()]).is_err());
        assert!(check(vec![CatalogEntry { refs: vec![], ..good.clone() }]).is_err());
        assert!(check(vec![CatalogEntry { id: "A,b".into(), ..good.clone() }]).is_err());
        assert!(check(vec![CatalogEntry { color: "red".into(), ..good.clone() }]).is_err());
        let wide = Region::SkyBox { ra: [0.0, 200.0], dec: [0.0, 1.0], z: [0.01, 0.02] };
        assert!(check(vec![entry("wide", Kind::Wall, wide)]).is_err());
        let void_box = Region::SkyBox { ra: [0.0, 20.0], dec: [0.0, 1.0], z: [0.01, 0.02] };
        assert!(check(vec![entry("v", Kind::Void, void_box)]).is_err());
    }

    #[test]
    fn output_uses_the_documented_field_names() {
        let table = DistanceTable::new(1.0);
        let r = [table.distance(0.02), table.distance(0.1)];
        let (positions, footprint) = cloud([170.0, 200.0], [0.0, 30.0], r);
        let e = CatalogEntry { min_delta: Some(0.5), ..entry("a", Kind::Wall, Region::SkyBox { ra: [175.0, 195.0], dec: [5.0, 25.0], z: [0.04, 0.08] }) };
        let out = assess(&Catalog { structures: vec![e] }, &positions, &footprint, r);
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v[0]["type"], "wall");
        assert_eq!(v[0]["minDelta"], 0.5);
        assert_eq!(v[0]["region"]["shape"], "sky-box");
        assert_eq!(v[0]["geometry"]["shape"], "sky-box");
        assert_eq!(v[0]["status"], "visible");
        assert!(v[0].get("reason").is_none());
    }
}
