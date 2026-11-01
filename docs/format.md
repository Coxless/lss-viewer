# データ形式 `zspace/1`

データセットは静的ファイルの集まりです。数値はすべてリトルエンディアン。ビューアは `metadata.json` を最初に読みます。
Rust 側の実装は `crates/zspace-core/src/format.rs`、`shells.rs`、`density.rs`、TypeScript 側は `web/src/data/` です。

| ファイル | 取得方法 | 内容 |
|---|---|---|
| `metadata.json` | 丸ごと | 全体の情報 |
| `hierarchy.bin` | 丸ごと | 八分木のノード |
| `points.bin` | HTTP Range | 量子化した銀河 |
| `tiles/<id>.bin` | 丸ごと | `--split-files` のときの `points.bin` の代わり |
| `shells.bin.gz` など | 丸ごと、クライアントで展開 | 等値面メッシュ |
| `density.bin.gz` | 丸ごと、しきい値を初めて動かしたとき | 密度格子 |
| `voids.json` など | 丸ごと | 構造の一覧 |
| `footprint.bin` | 実行時は読まない | 観測範囲のビットマップ |

## metadata.json

```json
{
  "format": "zspace/1",
  "source": { "name": "SDSS DR18", "mock": false, "query": "...", "rows": 612345, "dropped": 1203 },
  "cosmology": { "Om": 0.31, "OL": 0.69, "units": "Mpc/h" },
  "bbox": [0, 0, 0, 1, 1, 1],
  "rRange": [30.0, 450.0],
  "octree": { "root": [0, 0, 0, 225], "leafK": 4096, "nodes": 712, "pointBytes": 8, "points": 612345, "splitFiles": false },
  "density": { "file": "density.bin.gz", "dims": [78, 125, 69], "origin": [0, 0, 0], "cell": 6.09, "sigmaCells": 1.4, "encoding": "uint8-log" },
  "layers": [
    { "id": "voids", "kind": "isosurface", "name": "ボイド", "file": "shells.bin.gz",
      "params": { "threshold": -0.6, "polarity": "low", "color": "#8ce0f7", "vertices": 18402, "indices": 97638 } },
    { "id": "void-list", "kind": "list", "name": "見つかったボイド", "file": "voids.json", "params": { "method": "simple", "surface": "voids" } }
  ],
  "footprint": { "healpixNside": 128, "file": "footprint.bin", "raRange": [130, 240], "decRange": [0, 60], "fullSky": false,
                 "rectangular": true, "centroid": [-200, 50, 180] }
}
```

- `density`、`footprint` は `zspace-cli tile` の出力にはありません。`layers` は空になります。
- `layers` の順序に意味があります。ビューアは最初の `isosurface` と、それに対応する `list` を初期表示にします。
- `params.color` は等値面の色、`params.surface` は一覧に対応する等値面の `id` です。ビューアは表示中の等値面に合わせて一覧を切り替えます。
- `kind` は `isosurface`、`list`、`polyline`、`markers`、`regions`。UI の文言は `name` から作ります。
- `raRange[0] > raRange[1]` は赤経 0° をまたぐ範囲です。
- `rectangular` が偽のとき（領域が飛び地のときなど）は、`outline` に境界線分を `[ra0, dec0, ra1, dec1, ...]`（度）で持ちます。ビューアはこれを枠として描きます。
- `centroid` は銀河の平均位置で、初期視点の注視点に使います。
- `zspace-cli import-vast` は、一覧とメッシュを `layers` の末尾に追加します。VAST のメッシュは 1 MB を超えるので、表示をオンにしたときに取得します。
- `zspace-cli import-structures` は、`regions` レイヤーと `structures.json` を追加します。
- `source.mock` が真のデータは、画面で模擬データと明示します。

## hierarchy.bin

ノードを幅優先順に並べた 32 バイトの固定長レコードです。

| オフセット | 型 | 内容 |
|---|---|---|
| 0 | float32 ×3 | ノード中心 |
| 12 | float32 | 半辺長（量子化に使う値。丸め分だけ真の値より大きい） |
| 16 | uint32 | `points.bin` 内のバイト位置 |
| 20 | uint32 | 点数 |
| 24 | uint8 | 子の有無（bit i = 八分体 i。bit 0 が x、bit 1 が y、bit 2 が z の正側） |
| 25 | uint8 | 深さ |
| 26 | uint16 | 予約（0） |
| 28 | uint32 | 最初の子の番号（子なしは 0） |

子は連続して並びます。八分体 i の子の番号は `firstChild + popcount(childMask & ((1 << i) - 1))` です。

## points.bin

1 銀河 8 バイト：`int16 x, y, z, attr`。

- 位置：`center + q / 32767 * half`
- 属性：`kind << 12 | brightness`。`kind` は 3 bit、`brightness` は 12 bit、bit 15 は 0
- `kind`：0 = 散在、1 = フィラメント／実データの標準、2 = 壁、3 = 銀河団

各ノードの点は、その領域の一様ランダム抽出です（シャッフル後に安定な振り分けをするため）。

## density.bin.gz

gzip を展開すると `dims[0] * dims[1] * dims[2]` バイトの uint8 配列です。x が最速で、添字は `i + nx * (j + ny * k)`。セル (i, j, k) の位置は `origin + (i, j, k) * cell` です。

```
q = round((ln(1+δ) − ln 0.05) / (ln 10 − ln 0.05) × 254)     1+δ は [0.05, 10] に丸める
δ = exp(ln 0.05 + q / 254 × (ln 10 − ln 0.05)) − 1
q = 255 は観測範囲外
```

## shells.bin.gz

gzip を展開した形式です。

| オフセット | 型 | 内容 |
|---|---|---|
| 0 | char[4] | `ZSHL` |
| 4 | uint32 | 頂点数 V |
| 8 | uint32 | インデックス数 I |
| 12 | float32 | しきい値 |
| 16 | float32 ×3 | 中心 |
| 28 | float32 | 半辺長 |
| 32 | 8 バイト × V | 頂点 |
| 32 + 8V | 可変長 | インデックス |

- 頂点：`int16 x, y, z`（`center + q / 32767 * half`）、`int8 nx, ny`（oct 符号化した単位法線）
- インデックス：前の値との差を zigzag 符号化して、LEB128 の可変長で並べます。最初の差は 0 からです

## voids.json

```json
[{ "id": "V-01", "center": [0, 0, 0], "radius": 24.5, "deltaMin": -0.97, "method": "simple" }]
```

大きい順です。`method` は `simple`（簡易検出）または `vast-voidfinder`。VAST の場合、`deltaMin` は −1 で意味を持ちません。

## structures.json

有名な構造の一覧で、`kind: "regions"` のレイヤーから参照します。`zspace-cli import-structures --dataset DIR --catalog structures/catalog.json` が、カタログをデータセットと照合して書き出します。配列の順序がそのまま画面の順序です。

```json
[{
  "id": "sgw", "name": "Sloan Great Wall", "type": "wall",
  "region": { "shape": "sky-box", "ra": [130.5, 210], "dec": [-4, 8], "z": [0.065, 0.095] },
  "minDelta": 0.3, "color": "#ffa630", "view": "fan", "thickness": 30,
  "summary": "...", "size": "...", "discovery": "...", "basis": "...",
  "refs": [{ "label": "Gott et al. 2005", "url": "https://arxiv.org/abs/astro-ph/0310571" }],
  "geometry": { "shape": "sky-box", "ra": [130.5, 210], "dec": [-4, 8], "r": [192.2, 277.5] },
  "status": "visible", "coverage": 0.873, "galaxies": 21504, "ratio": 1.27,
  "center": [-200, 40, 10], "extent": 187, "distance": 221.8
}]
```

- `id` から `refs` まではカタログの値です。`id` は英小文字、数字、ハイフンだけで、URL の `s=` に入ります。`refs` は 1 件以上必要です。
- `type` は `cluster`、`supercluster`、`wall`、`void`。`void` は銀河を塗らず、境界を線で描きます。領域は `sphere` に限ります。
- `region.shape` は `sphere`（`ra`、`dec`、`z`、`radius`。半径は Mpc/h）か `sky-box`（`ra`、`dec`、`z` の範囲）。`ra[0] > ra[1]` は赤経 0° をまたぎます。`sky-box` の赤経の幅は 180° 未満です。
- `geometry` は `region` をこのデータの座標に直したものです。ビューアはこれだけで判定します。
- `minDelta` があると、領域の中で δ がこの値以上の銀河だけに色を付けます。
- `view` は飛び方です。`fan` は厚さ `thickness`（Mpc/h）の薄い板、`orbit` は周りを回れる距離です。
- `status` は `visible` か `outside`。領域の 50% 以上が観測範囲に入り、銀河が 1 個以上あれば `visible` です。`outside` には `reason`（`too-near`、`too-far`、`out-of-survey`）が付きます。
- `coverage` は領域のうち観測範囲に入る割合、`ratio` は銀河数を同じ距離の平均密度から期待される数で割った値です。期待数が 0 のときは `ratio` がありません。
- `center`、`extent` は観測された部分の中心と、それを含む半径です。`distance` は中心までの距離（Mpc/h）です。

## footprint.bin

HEALPix NESTED の `12 * nside^2` ビット。ピクセル h はバイト `h / 8` のビット `h % 8`（下位から）です。
