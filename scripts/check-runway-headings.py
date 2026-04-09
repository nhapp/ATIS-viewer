#!/usr/bin/env python3
"""
Validate RUNWAY_DATA headings in index.html against OurAirports runways.csv.

Usage:
  python3 scripts/check-runway-headings.py [--tolerance 20]

Downloads (or uses cached) runways.csv from OurAirports and compares each
airport's headings in the hardcoded RUNWAY_DATA block against the database.

Flags:
  --tolerance N   Acceptable heading deviation in degrees (default: 20)
  --missing       Also list airports in RUNWAY_DATA not found in OurAirports

Output: one line per discrepancy or missing runway.
"""

import csv, os, re, sys, math, urllib.request

RUNWAYS_CSV = os.path.join(os.path.dirname(__file__), 'runways.csv')
INDEX_HTML  = os.path.join(os.path.dirname(__file__), '..', 'index.html')
TOLERANCE   = 20   # degrees
SHOW_MISSING = '--missing' in sys.argv

for arg in sys.argv[1:]:
    if arg.startswith('--tolerance='):
        TOLERANCE = int(arg.split('=')[1])
    elif arg == '--tolerance' and sys.argv.index(arg)+1 < len(sys.argv):
        TOLERANCE = int(sys.argv[sys.argv.index(arg)+1])

# ── Download runways.csv if not present ───────────────────────────────────────
if not os.path.exists(RUNWAYS_CSV):
    print("Downloading runways.csv from OurAirports…")
    urllib.request.urlretrieve(
        'https://ourairports.com/data/runways.csv', RUNWAYS_CSV)
    print(f"Saved to {RUNWAYS_CSV}")

# ── Load OurAirports runway headings ─────────────────────────────────────────
# Build: { airport_ident: [heading, ...] }
db = {}
with open(RUNWAYS_CSV, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        if row.get('closed','0') == '1':
            continue
        ident = row.get('airport_ident','').strip()
        for col in ('le_heading_degT', 'he_heading_degT'):
            try:
                h = float(row[col])
                if 0 <= h <= 360:
                    db.setdefault(ident, []).append(round(h))
            except (ValueError, KeyError):
                pass

# ── Parse RUNWAY_DATA block from index.html ───────────────────────────────────
with open(INDEX_HTML, encoding='utf-8') as f:
    src = f.read()

start = src.find('const RUNWAY_DATA = {')
end   = src.find('};', start) + 2
block = src[start:end]

# Extract entries like  KPAO:[130,310]  or  KALB:[190,10,100,280]
entries = {}
for m in re.finditer(r"([A-Z]{3,4})\s*:\s*\[([^\]]+)\]", block):
    icao = m.group(1)
    headings = [int(x.strip()) for x in m.group(2).split(',') if x.strip()]
    entries[icao] = headings

# ── Helper: angular difference ────────────────────────────────────────────────
def ang_diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)

def closest_db(h, db_list):
    return min(db_list, key=lambda x: ang_diff(h, x))

# ── Compare ───────────────────────────────────────────────────────────────────
ok = skipped = wrong = missing_airport = 0

print(f"\nValidating {len(entries)} airports  (tolerance ±{TOLERANCE}°)\n")
print(f"{'ICAO':<6} {'Our heading':>11} {'DB closest':>10} {'Δ':>5}  {'Status'}")
print('─' * 55)

for icao, our_headings in sorted(entries.items()):
    if icao not in db:
        missing_airport += 1
        if SHOW_MISSING:
            print(f"{icao:<6} {'(not in OurAirports)':>32}")
        continue

    db_headings = db[icao]
    any_bad = False
    for h in our_headings:
        closest = closest_db(h, db_headings)
        diff = ang_diff(h, closest)
        if diff > TOLERANCE:
            marker = '⚠  MISMATCH'
            wrong += 1
            any_bad = True
            print(f"{icao:<6} {h:>11}° {closest:>10}°  {diff:>4}°  {marker}  (DB has {sorted(db_headings)})")
        else:
            ok += 1

    if not any_bad:
        skipped  # silently ok

print()
print(f"✓ {ok} headings OK   ⚠ {wrong} mismatches   "
      f"{'?' if SHOW_MISSING else '(run --missing to see)'} {missing_airport} airports not in OurAirports")
