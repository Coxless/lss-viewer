//! CSV catalog input: ra, dec, z plus optional attribute columns.

use crate::cosmology::{to_cartesian, DistanceTable};
use crate::{pack_attr, Galaxy, BRIGHTNESS_MAX, KIND_FIELD};
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::io::Read;

pub const Z_MIN: f64 = 0.003;
pub const Z_MAX: f64 = 0.6;
const HEADER_SEARCH_LINES: u64 = 50;

/// Optional mapping from extra CSV columns to the point attribute.
#[derive(Clone, Debug, Default)]
pub struct AttrMap {
    /// A magnitude column, e.g. `petroMag_r`.
    pub magnitude: Option<String>,
    /// Faint and bright limits of the magnitude, mapped to brightness 0 and 4095.
    pub mag_range: (f64, f64),
    /// An integer column holding the 3-bit kind, e.g. `kind`.
    pub kind: Option<String>,
    /// An integer column holding the 12-bit brightness, e.g. `brightness`.
    pub brightness: Option<String>,
}

impl AttrMap {
    pub fn magnitude(column: &str) -> Self {
        Self { magnitude: Some(column.to_string()), mag_range: (17.77, 13.0), ..Self::default() }
    }

    /// Reads the `kind` and `brightness` columns when the file has them.
    pub fn auto() -> Self {
        Self { kind: Some("kind".into()), brightness: Some("brightness".into()), ..Self::default() }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub rows: u64,
    pub dropped_non_numeric: u64,
    pub dropped_out_of_range: u64,
}

impl Report {
    pub fn dropped(&self) -> u64 {
        self.dropped_non_numeric + self.dropped_out_of_range
    }
}

#[derive(Debug, PartialEq)]
pub enum CatalogError {
    NoHeader,
    Read(String),
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogError::NoHeader => write!(
                f,
                "ra, dec, z の列見出しが見つかりません。SkyServerのSQLをそのまま使い、CSV形式で出力してください。"
            ),
            CatalogError::Read(e) => write!(f, "CSVを読み取れません: {e}"),
        }
    }
}

impl std::error::Error for CatalogError {}

struct Columns {
    ra: usize,
    dec: usize,
    z: usize,
    mag: Option<usize>,
    kind: Option<usize>,
    brightness: Option<usize>,
}

fn find_columns(rec: &csv::ByteRecord, map: &AttrMap) -> Option<Columns> {
    let names: Vec<String> = rec
        .iter()
        .map(|c| String::from_utf8_lossy(c).trim().trim_start_matches(['\u{feff}', '#']).to_lowercase())
        .collect();
    let find = |n: &str| names.iter().position(|c| c == n);
    let opt = |n: &Option<String>| n.as_ref().and_then(|n| find(&n.to_lowercase()));
    Some(Columns {
        ra: find("ra")?,
        dec: find("dec")?,
        z: find("z").or_else(|| find("redshift"))?,
        mag: opt(&map.magnitude),
        kind: opt(&map.kind),
        brightness: opt(&map.brightness),
    })
}

fn field(rec: &csv::ByteRecord, i: usize) -> Option<f64> {
    let v: f64 = std::str::from_utf8(rec.get(i)?).ok()?.trim().parse().ok()?;
    v.is_finite().then_some(v)
}

/// Parses a catalog. Rows without usable numbers or outside the redshift range are
/// dropped and counted. Without a brightness source, brightness comes from a seeded
/// stream so the result stays reproducible.
pub fn read_csv<R: Read>(input: R, map: &AttrMap, seed: u64) -> Result<(Vec<Galaxy>, Report), CatalogError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .buffer_capacity(1 << 20)
        .from_reader(input);
    let mut rec = csv::ByteRecord::new();
    let mut columns = None;
    let mut seen = 0;
    while seen < HEADER_SEARCH_LINES {
        if !reader.read_byte_record(&mut rec).map_err(|e| CatalogError::Read(e.to_string()))? {
            break;
        }
        seen += 1;
        columns = find_columns(&rec, map);
        if columns.is_some() {
            break;
        }
    }
    let cols = columns.ok_or(CatalogError::NoHeader)?;

    let table = DistanceTable::new(Z_MAX);
    let mut rng = ChaCha8Rng::seed_from_u64(seed ^ 0x5a5a);
    let (faint, bright) = map.mag_range;
    let mut out = Vec::new();
    let mut report = Report::default();
    while reader.read_byte_record(&mut rec).map_err(|e| CatalogError::Read(e.to_string()))? {
        report.rows += 1;
        let (ra, dec, z) = match (field(&rec, cols.ra), field(&rec, cols.dec), field(&rec, cols.z)) {
            (Some(a), Some(d), Some(z)) => (a, d, z),
            _ => {
                report.dropped_non_numeric += 1;
                continue;
            }
        };
        if !(Z_MIN..=Z_MAX).contains(&z) || !(-90.0..=90.0).contains(&dec) {
            report.dropped_out_of_range += 1;
            continue;
        }
        let random_brightness = (rng.next_u32() & BRIGHTNESS_MAX as u32) as u16;
        let brightness = if let Some(m) = cols.mag.and_then(|i| field(&rec, i)) {
            (((m - faint) / (bright - faint)).clamp(0.0, 1.0) * BRIGHTNESS_MAX as f64) as u16
        } else if let Some(b) = cols.brightness.and_then(|i| field(&rec, i)) {
            b.clamp(0.0, BRIGHTNESS_MAX as f64) as u16
        } else {
            random_brightness
        };
        let kind = cols.kind.and_then(|i| field(&rec, i)).map_or(KIND_FIELD, |k| k.clamp(0.0, 7.0) as u16);
        out.push(Galaxy { pos: to_cartesian(ra, dec, table.distance(z)), attr: pack_attr(kind, brightness) });
    }
    Ok((out, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_the_skyserver_title_and_ignores_header_case() {
        let csv = "#Table1\nRA,Dec,Z\n185.0,30.0,0.05\n186.0,31.0,0.06\n";
        let (g, r) = read_csv(csv.as_bytes(), &AttrMap::default(), 1).unwrap();
        assert_eq!(g.len(), 2);
        assert_eq!(r.rows, 2);
        assert_eq!(r.dropped(), 0);
    }

    #[test]
    fn drops_and_counts_bad_rows() {
        let csv = "ra,dec,z\n1,2,0.05\nx,2,0.05\n1,2,\n1,2,0.001\n1,2,0.9\n1,95,0.1\n";
        let (g, r) = read_csv(csv.as_bytes(), &AttrMap::default(), 1).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(r.rows, 6);
        assert_eq!(r.dropped_non_numeric, 2);
        assert_eq!(r.dropped_out_of_range, 3);
    }

    #[test]
    fn accepts_redshift_as_a_column_name() {
        let (g, _) = read_csv("ra,dec,redshift\n1,2,0.05\n".as_bytes(), &AttrMap::default(), 1).unwrap();
        assert_eq!(g.len(), 1);
    }

    #[test]
    fn reports_a_missing_header() {
        let e = read_csv("a,b\n1,2\n".as_bytes(), &AttrMap::default(), 1).unwrap_err();
        assert_eq!(e, CatalogError::NoHeader);
    }

    #[test]
    fn maps_magnitude_to_brightness() {
        let map = AttrMap::magnitude("petroMag_r");
        let csv = "ra,dec,z,petroMag_r\n1,2,0.05,13.0\n1,2,0.05,17.77\n1,2,0.05,99\n";
        let (g, _) = read_csv(csv.as_bytes(), &map, 1).unwrap();
        assert_eq!(g[0].attr & BRIGHTNESS_MAX, BRIGHTNESS_MAX);
        assert_eq!(g[1].attr & BRIGHTNESS_MAX, 0);
        assert_eq!(g[2].attr & BRIGHTNESS_MAX, 0);
    }

    #[test]
    fn same_seed_same_result() {
        let csv = "ra,dec,z\n1,2,0.05\n3,4,0.06\n";
        let a = read_csv(csv.as_bytes(), &AttrMap::default(), 9).unwrap();
        let b = read_csv(csv.as_bytes(), &AttrMap::default(), 9).unwrap();
        assert_eq!(a.0, b.0);
    }
}
