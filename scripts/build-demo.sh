#!/usr/bin/env bash
# Builds the demo dataset from data/ (see fetch-data.sh). usage: build-demo.sh [output dir]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-web/public/dataset}
CLI=${CLI:-target/release/zspace-cli}
"$CLI" build --input data/sdss/dr18.csv --out "$OUT" --attr-map petroMag_r \
  --name 'SDSS DR18' --query "$(cat data/sdss/query.sql)" --timings
"$CLI" import-vast --dataset "$OUT" \
  --holes data/vast/VoidFinder-nsa_v1_0_1_Planck2018_comoving_holes.txt \
  --maximal data/vast/VoidFinder-nsa_v1_0_1_Planck2018_comoving_maximal.txt \
  --name 'ボイド（VAST）'
du -ah "$OUT"
