#!/usr/bin/env bash
# Downloads the SDSS galaxies and the VAST void catalog into data/. Raw data stays out of git.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/sdss data/vast

# No TOP: truncating with TOP 300000 keeps 54-77% of the rows depending on the RA band.
QUERY="SELECT s.ra, s.dec, s.z, s.petroMag_r FROM SpecPhoto AS s WHERE s.class = 'GALAXY' AND s.survey = 'sdss' AND s.sciencePrimary = 1 AND s.zWarning = 0 AND s.z BETWEEN 0.01 AND 0.12"
echo "$QUERY" > data/sdss/query.sql
curl -fsS --retry 3 --max-time 280 -G 'https://skyserver.sdss.org/dr18/SkyServerWS/SearchTools/SqlSearch' \
  --data-urlencode "cmd=$QUERY" --data-urlencode 'format=csv' -o data/sdss/dr18.csv

RECORD=https://zenodo.org/api/records/11043278/files
for f in VoidFinder-nsa_v1_0_1_Planck2018_comoving_holes.txt VoidFinder-nsa_v1_0_1_Planck2018_comoving_maximal.txt; do
  curl -fsSL --retry 3 --max-time 120 -o "data/vast/$f" "$RECORD/$f/content"
done
wc -l data/sdss/dr18.csv data/vast/*
