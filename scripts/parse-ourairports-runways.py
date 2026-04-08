#!/usr/bin/env python3
"""
Generate runways.sql from OurAirports runways.csv.

Usage:
  1. Download runways.csv from https://ourairports.com/data/runways.csv
  2. Place it in this directory (scripts/) or the project root
  3. Run:  python3 scripts/parse-ourairports-runways.py

Output: runways.sql  (gitignored — re-run to regenerate)

OurAirports runway CSV columns relevant to us:
  airport_ident, le_ident, le_heading_degT, he_ident, he_heading_degT, closed
"""

import csv
import os
import sys

SEARCH_PATHS = [
    os.path.join(os.path.dirname(__file__), 'runways.csv'),
    os.path.join(os.path.dirname(__file__), '..', 'runways.csv'),
    'runways.csv',
]

src = None
for p in SEARCH_PATHS:
    if os.path.exists(p):
        src = p
        break

if not src:
    print("ERROR: runways.csv not found. Download from https://ourairports.com/data/runways.csv", file=sys.stderr)
    sys.exit(1)

out_path = os.path.join(os.path.dirname(__file__), '..', 'runways.sql')

rows = []
skipped = 0

with open(src, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        # Skip closed runways
        if row.get('closed', '0') == '1':
            skipped += 1
            continue

        ident = row.get('airport_ident', '').strip()
        le    = row.get('le_ident', '').strip()
        he    = row.get('he_ident', '').strip()

        le_hdg_raw = row.get('le_heading_degT', '').strip()
        he_hdg_raw = row.get('he_heading_degT', '').strip()

        # Skip rows with no heading data at all
        if not le_hdg_raw and not he_hdg_raw:
            skipped += 1
            continue

        def parse_hdg(s):
            try:
                v = float(s)
                return v if 0 <= v <= 360 else None
            except (ValueError, TypeError):
                return None

        le_hdg = parse_hdg(le_hdg_raw)
        he_hdg = parse_hdg(he_hdg_raw)

        # If one end missing, derive from the other (opposite heading)
        if le_hdg is None and he_hdg is not None:
            le_hdg = (he_hdg + 180) % 360
        if he_hdg is None and le_hdg is not None:
            he_hdg = (le_hdg + 180) % 360

        def esc(s):
            return s.replace("'", "''")

        le_val = str(round(le_hdg, 1)) if le_hdg is not None else 'NULL'
        he_val = str(round(he_hdg, 1)) if he_hdg is not None else 'NULL'

        rows.append(
            f"('{esc(ident)}','{esc(le)}','{esc(he)}',{le_val},{he_val})"
        )

CHUNK = 500
with open(out_path, 'w', encoding='utf-8') as out:
    out.write("-- Auto-generated from OurAirports runways.csv — do not edit by hand\n")
    out.write("-- Run scripts/parse-ourairports-runways.py to regenerate\n\n")
    out.write("TRUNCATE runways;\n\n")
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i+CHUNK]
        out.write(
            "INSERT INTO runways (airport_ident, le_ident, he_ident, le_heading, he_heading) VALUES\n"
            + ',\n'.join(chunk)
            + "\nON CONFLICT (airport_ident, le_ident) DO UPDATE\n"
            + "  SET he_ident=EXCLUDED.he_ident, le_heading=EXCLUDED.le_heading, he_heading=EXCLUDED.he_heading;\n\n"
        )

print(f"Written {len(rows):,} runways to {out_path}  (skipped {skipped} closed/no-heading)")
