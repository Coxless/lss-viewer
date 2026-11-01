//! zspace-cli: preprocesses galaxy catalogs into static dataset files.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;
use zspace_core::catalog::{self, AttrMap};
use zspace_core::dataset::{self, Dataset, Options};
use zspace_core::format::{read_hierarchy, Metadata, Source};
use zspace_core::{layers, mock, shells, vast, Galaxy};

const USAGE: &str = "\
zspace-cli <command> [options]

  mock        --out FILE [--n 600000] [--seed 7]
              Write a mock catalog as CSV.

  tile        --input CSV --out DIR [options]
              Octree only: metadata.json, hierarchy.bin, points.bin.

  build       --input CSV --out DIR [options]
              Everything: octree, footprint, density grid, void surface and list.
              Use --mock N instead of --input for a mock catalog.

  import-vast --dataset DIR --holes FILE --maximal FILE [--name NAME]
              Add VAST void surfaces and the void list to a dataset.

options for tile and build:
  --name NAME         source name in metadata.json
  --query TEXT        source query in metadata.json
  --seed N            shuffle seed (default 1)
  --k N               points per octree node (default 4096)
  --max-depth N       octree depth limit (default 14)
  --threshold D       void threshold (default -0.6)
  --attr-map SPEC     magnitude column, e.g. petroMag_r or petroMag_r:17.77:13
  --split-files       write tiles/<id>.bin for hosts without Range support
  --timings           print the time of each stage
";

struct Args(HashMap<String, String>);

impl Args {
    fn parse(items: &[String]) -> Result<Self, String> {
        let mut map = HashMap::new();
        let mut it = items.iter();
        while let Some(k) = it.next() {
            let k = k.strip_prefix("--").ok_or(format!("unexpected argument: {k}"))?;
            if matches!(k, "split-files" | "timings") {
                map.insert(k.to_string(), String::new());
            } else {
                let v = it.next().ok_or(format!("--{k} needs a value"))?;
                map.insert(k.to_string(), v.clone());
            }
        }
        Ok(Self(map))
    }

    fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(String::as_str)
    }

    fn has(&self, k: &str) -> bool {
        self.0.contains_key(k)
    }

    fn required(&self, k: &str) -> Result<&str, String> {
        self.get(k).ok_or(format!("--{k} is required"))
    }

    fn num<T: std::str::FromStr>(&self, k: &str, default: T) -> Result<T, String> {
        self.get(k).map_or(Ok(default), |v| v.parse().map_err(|_| format!("--{k}: not a number: {v}")))
    }
}

/// Prints stage durations when asked to.
struct Timer {
    on: bool,
    start: Instant,
    last: Instant,
    stage: String,
}

impl Timer {
    fn new(on: bool) -> Self {
        let now = Instant::now();
        Self { on, start: now, last: now, stage: String::new() }
    }

    fn mark(&mut self, next: &str) {
        let now = Instant::now();
        if self.on && !self.stage.is_empty() {
            eprintln!("  {:<10} {:>7.0} ms", self.stage, (now - self.last).as_secs_f64() * 1e3);
        }
        self.last = now;
        self.stage = next.to_string();
    }

    fn finish(&mut self) {
        self.mark("");
        if self.on {
            eprintln!("  {:<10} {:>7.0} ms", "total", self.start.elapsed().as_secs_f64() * 1e3);
        }
    }
}

fn attr_map(args: &Args) -> Result<AttrMap, String> {
    let Some(spec) = args.get("attr-map") else {
        return Ok(AttrMap::auto());
    };
    let parts: Vec<&str> = spec.split(':').collect();
    let mut map = AttrMap::magnitude(parts[0]);
    if parts.len() == 3 {
        let n = |s: &str| s.parse::<f64>().map_err(|_| format!("--attr-map: not a number: {s}"));
        map.mag_range = (n(parts[1])?, n(parts[2])?);
    } else if parts.len() != 1 {
        return Err("--attr-map takes COLUMN or COLUMN:FAINT:BRIGHT".into());
    }
    map.kind = Some("kind".into());
    Ok(map)
}

fn options(args: &Args) -> Result<Options, String> {
    let d = Options::default();
    Ok(Options {
        seed: args.num("seed", d.seed)?,
        leaf_k: args.num("k", d.leaf_k)?,
        max_depth: args.num("max-depth", d.max_depth)?,
        threshold: args.num("threshold", d.threshold)?,
        ..d
    })
}

fn load(args: &Args, seed: u64, timer: &mut Timer) -> Result<(Vec<Galaxy>, Source), String> {
    timer.mark("read");
    if let Some(n) = args.get("mock") {
        let n: usize = n.parse().map_err(|_| format!("--mock: not a number: {n}"))?;
        let galaxies = mock::generate(n, seed);
        let name = args.get("name").unwrap_or("模擬カタログ").to_string();
        return Ok((galaxies, Source { name, mock: true, query: None, rows: n as u64, dropped: 0 }));
    }
    let input = args.required("input")?;
    let file = fs::File::open(input).map_err(|e| format!("{input}: {e}"))?;
    let (galaxies, report) = catalog::read_csv(file, &attr_map(args)?, seed).map_err(|e| format!("{input}: {e}"))?;
    eprintln!(
        "{} rows: kept {}, dropped {} (non-numeric {}, out of range {})",
        report.rows,
        galaxies.len(),
        report.dropped(),
        report.dropped_non_numeric,
        report.dropped_out_of_range
    );
    if galaxies.is_empty() {
        return Err(format!("{input}: no usable rows"));
    }
    let source = Source {
        name: args.get("name").unwrap_or(input).to_string(),
        mock: false,
        query: args.get("query").map(str::to_string),
        rows: report.rows,
        dropped: report.dropped(),
    };
    Ok((galaxies, source))
}

fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let path = dir.join(name);
    fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_dataset(ds: &mut Dataset, dir: &Path, split: bool) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    ds.metadata.octree.split_files = split;
    if split {
        let tiles = dir.join("tiles");
        fs::create_dir_all(&tiles).map_err(|e| format!("{}: {e}", tiles.display()))?;
        let b = ds.metadata.octree.point_bytes as usize;
        for (id, n) in read_hierarchy(&ds.hierarchy).iter().enumerate() {
            let at = n.byte_offset as usize;
            write_file(&tiles, &format!("{id}.bin"), &ds.points[at..at + n.count as usize * b])?;
        }
    } else {
        write_file(dir, dataset::FILE_POINTS, &ds.points)?;
    }
    for (name, bytes) in ds.files() {
        write_file(dir, &name, &bytes)?;
    }
    Ok(())
}

fn cmd_mock(args: &Args) -> Result<(), String> {
    let n = args.num("n", 600_000usize)?;
    let seed = args.num("seed", 7u64)?;
    let out = PathBuf::from(args.required("out")?);
    let csv = mock::to_csv(&mock::generate(n, seed));
    fs::write(&out, csv).map_err(|e| format!("{}: {e}", out.display()))?;
    eprintln!("wrote {n} galaxies to {}", out.display());
    Ok(())
}

fn cmd_build(args: &Args, points_only: bool) -> Result<(), String> {
    let opts = options(args)?;
    let dir = PathBuf::from(args.required("out")?);
    let mut timer = Timer::new(args.has("timings"));
    let (mut galaxies, source) = load(args, opts.seed, &mut timer)?;
    let mut progress = |stage: &str| timer.mark(stage);
    let mut ds = if points_only {
        dataset::build_points(&mut galaxies, source, &opts, &mut progress)
    } else {
        dataset::build(&mut galaxies, source, &opts, &mut progress)
    };
    timer.mark("write");
    write_dataset(&mut ds, &dir, args.has("split-files"))?;
    timer.finish();
    if ds.shells_truncated {
        eprintln!("warning: the void surface reached {} triangles and was cut off", opts.max_triangles);
    }
    eprintln!(
        "{} galaxies, {} nodes, {} voids -> {}",
        ds.metadata.octree.points,
        ds.metadata.octree.nodes,
        ds.voids.len(),
        dir.display()
    );
    Ok(())
}

fn cmd_import_vast(args: &Args) -> Result<(), String> {
    let dir = PathBuf::from(args.required("dataset")?);
    let read = |p: &str| fs::read_to_string(p).map_err(|e| format!("{p}: {e}"));
    let holes = vast::parse_holes(&read(args.required("holes")?)?)?;
    let effective = vast::parse_effective_radii(&read(args.required("maximal")?)?)?;
    let meta_path = dir.join(dataset::FILE_METADATA);
    let text = read(meta_path.to_str().ok_or("dataset path is not UTF-8")?)?;
    let mut meta: Metadata = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", meta_path.display()))?;

    let cell = meta.density.as_ref().map_or(5.0, |d| d.cell).min(5.0);
    let spec = vast::grid_for(&holes, cell);
    let mesh = vast::surface(&holes, &spec, shells::MAX_TRIANGLES);
    let list = vast::void_list(&holes, &effective);
    if list.is_empty() {
        return Err("the catalog has no voids".into());
    }

    const SHELLS: &str = "shells-vast.bin.gz";
    const VOIDS: &str = "voids-vast.json";
    write_file(&dir, SHELLS, &dataset::gzip(&shells::encode(&mesh, 0.0)))?;
    write_file(&dir, VOIDS, &serde_json::to_vec(&list).map_err(|e| e.to_string())?)?;

    let name = args.get("name").unwrap_or("VAST VoidFinder");
    meta.layers.retain(|l| l.id != "vast" && l.id != "vast-list");
    // The viewer starts on the first surface and the first list. The VAST list comes first
    // because it is the better catalog. Its surface goes after the density surface because
    // it is several times larger, and would not fit the first-load budget.
    meta.layers.insert(0, layers::list("vast-list", name, VOIDS, vast::METHOD_VAST));
    meta.layers.push(layers::isosurface(
        "vast",
        name,
        SHELLS,
        0.0,
        shells::Polarity::Low,
        mesh.positions.len(),
        mesh.indices.len(),
    ));
    let json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    write_file(&dir, dataset::FILE_METADATA, &json)?;
    eprintln!(
        "{} holes, {} voids, {} vertices, {} indices{} -> {}",
        holes.len(),
        list.len(),
        mesh.positions.len(),
        mesh.indices.len(),
        if mesh.truncated { " (cut off at the triangle limit)" } else { "" },
        dir.display()
    );
    Ok(())
}

fn run() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = argv.split_first() else {
        return Err(USAGE.to_string());
    };
    if cmd == "help" || cmd == "--help" || cmd == "-h" {
        print!("{USAGE}");
        return Ok(());
    }
    let args = Args::parse(rest)?;
    match cmd.as_str() {
        "mock" => cmd_mock(&args),
        "tile" => cmd_build(&args, true),
        "build" => cmd_build(&args, false),
        "import-vast" => cmd_import_vast(&args),
        other => Err(format!("unknown command: {other}\n\n{USAGE}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
