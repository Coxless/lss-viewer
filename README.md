# zspace

宇宙の大規模構造（銀河団・フィラメント・壁・ボイド）を、実際の観測データからブラウザで3D表示するツールです。設計は [concept.md](concept.md)、データ形式は [docs/format.md](docs/format.md)、計画と進み具合は [docs/implementation-plan.md](docs/implementation-plan.md) にあります。

## 開発環境

ツールは Ubuntu Workshop の中にあります（Rust、Wasm ツール、Node、テスト用ブラウザ）。

```sh
workshop launch dev     # 初回のみ
workshop shell          # /project がこのリポジトリ
```

## 動かす

```sh
cargo build --release -p zspace-cli
cd web
npm ci
npm run build:wasm
npm run dataset:mock    # 模擬カタログ60万件を public/dataset に作る
npm run dev             # ホストからは http://localhost:15173/
```

実データ（SDSS DR18 と VAST）を使うには、リポジトリのルートで次を実行します。

```sh
scripts/fetch-data.sh
scripts/build-demo.sh web/public/dataset
```

## テスト

```sh
cargo test --release --workspace --features zspace-core/parallel
cd web
npm test            # CLI と Wasm の出力の一致、データ形式、LOD
npm run test:e2e    # ブラウザでの操作、初回転送量、CSV、基準画像
```

## 性能の計測

GPU のある端末のブラウザで次を開くと、決まったカメラ経路を再生し、fps と転送量を画面に表示します。Workshop 内で `npm run build && npm run preview` を実行すれば、ホストから `localhost:14173` で開けます。

```
http://localhost:14173/?bench=1&budget=1000000       PC（目標 60 fps）
?bench=1&budget=250000                               中位スマホ（目標 30 fps）
```

## コマンド

`zspace-cli help` を参照してください。`mock`、`tile`、`build`、`import-vast` があります。
