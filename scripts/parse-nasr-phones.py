#!/usr/bin/env python3
"""
FAA NASR ATIS/AWOS/ASOS Phone Number Parser
============================================
Downloads the current FAA NASR 28-day subscription and extracts every
US airport ATIS / AWOS / ASOS phone number.

Sources parsed:
  1. AWOS.txt  — primary source for AWOS/ASOS stations (confirmed field layout)
  2. APT_BASE.csv — ICAO identifier lookup (site_no → icao_id)
  3. APT_RMK.csv  — airport remarks (catches ATIS phone numbers not in AWOS.txt)

Output: SQL INSERT statements ready to paste into Supabase SQL editor.

Usage:
    python3 scripts/parse-nasr-phones.py             # auto-detect current cycle
    python3 scripts/parse-nasr-phones.py 2026-03-19  # specify cycle date
"""

import re
import sys
import csv
import zipfile
import urllib.request
from io import BytesIO, StringIO
from datetime import datetime, timedelta
from typing import Optional, Tuple

# ── Cycle date detection ──────────────────────────────────────────────────────

# FAA NASR cycles run every 28 days. Reference point: 2024-01-25 (confirmed cycle)
REFERENCE_DATE = datetime(2024, 1, 25)

def current_cycle_date():
    today = datetime.utcnow()
    elapsed = (today - REFERENCE_DATE).days
    cycles  = elapsed // 28
    return (REFERENCE_DATE + timedelta(days=cycles * 28)).strftime('%Y-%m-%d')

def candidate_dates(base: str):
    """Return base date plus one cycle back and forward, in case of off-by-one."""
    d = datetime.strptime(base, '%Y-%m-%d')
    return [
        (d - timedelta(days=28)).strftime('%Y-%m-%d'),
        base,
        (d + timedelta(days=28)).strftime('%Y-%m-%d'),
    ]

NASR_URL = 'https://nfdc.faa.gov/webContent/28DaySub/28DaySubscription_Effective_{date}.zip'

# ── Download ──────────────────────────────────────────────────────────────────

def download_nasr(cycle: str) -> zipfile.ZipFile:
    for date in candidate_dates(cycle):
        url = NASR_URL.format(date=date)
        print(f'  Trying {url} …', file=sys.stderr)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'ATIS-Viewer/1.0'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            print(f'  ✓ Downloaded {len(data):,} bytes for cycle {date}', file=sys.stderr)
            return zipfile.ZipFile(BytesIO(data))
        except Exception as e:
            print(f'  ✗ {e}', file=sys.stderr)
    raise RuntimeError('Could not download NASR data for any candidate date.')

def read_file(zf: zipfile.ZipFile, name: str) -> Optional[bytes]:
    """Case-insensitive file lookup inside the zip."""
    names = {n.upper(): n for n in zf.namelist()}
    key = name.upper()
    if key in names:
        return zf.read(names[key])
    # Try inside subdirectories
    for n in zf.namelist():
        if n.upper().endswith('/' + key):
            return zf.read(n)
    return None

# ── AWOS.txt parser ──────────────────────────────────────────────────────────
#
# AWOS1 record layout (1-indexed, fixed-width 255 chars):
#   Cols  1-5  : Record type "AWOS1"
#   Cols  6-9  : WX Sensor Ident  (4 chars — ICAO or FAA ID)
#   Cols 10-19 : WX Sensor Type   (ASOS, AWOS-3, AWOS-3PT, etc.)
#   Col  20    : Commissioning Status ('Y' = active)
#   Cols 21-30 : Commission Date
#   Cols 83-96 : Station Telephone   (primary phone, 14 chars)
#   Cols 97-110: Second Telephone    (secondary phone, 14 chars)
#   Cols 111-121: Landing Facility Site Number (links to APT record)
#   Cols 122-161: Station City
#   Cols 162-163: State Code

def parse_awos(raw: bytes) -> dict:
    """Returns dict: site_no → {sensor_id, type, phone, city, state}"""
    results = {}
    text = raw.decode('latin-1', errors='replace')
    for line in text.splitlines():
        if not line.startswith('AWOS1'):
            continue
        if len(line) < 163:
            continue

        status = line[19]          # 'Y' = commissioned/active
        if status != 'Y':
            continue

        sensor_id = line[5:9].strip()
        wx_type   = line[9:19].strip()
        phone1    = line[82:96].strip()
        phone2    = line[96:110].strip()
        site_no   = line[110:121].strip()
        city      = line[121:161].strip()
        state     = line[161:163].strip()

        phone = normalize_phone(phone1) or normalize_phone(phone2)
        if not phone:
            continue

        results[site_no] = {
            'sensor_id': sensor_id,
            'type':      wx_type,
            'phone':     phone,
            'city':      city,
            'state':     state,
        }

    print(f'  AWOS.txt: {len(results)} active stations with phones', file=sys.stderr)
    return results

# ── APT_BASE.csv parser ───────────────────────────────────────────────────────
# Gives us: site_no → icao_id, and faa_id → icao_id

def parse_apt_base(raw: bytes) -> Tuple[dict, dict]:
    """Returns (site_to_icao, faa_to_icao)."""
    site_to_icao = {}
    faa_to_icao  = {}
    text = raw.decode('latin-1', errors='replace')
    reader = csv.DictReader(StringIO(text))
    for row in reader:
        site   = (row.get('SITE_NO') or '').strip()
        faa_id = (row.get('AIRPORT_ID') or '').strip().upper()
        icao   = (row.get('ICAO_ID') or '').strip().upper()
        if not icao:
            # Derive ICAO from FAA ID for CONUS airports
            icao = derive_icao(faa_id, row.get('STATE_CODE', ''))
        if site and icao:
            site_to_icao[site] = icao
        if faa_id and icao:
            faa_to_icao[faa_id] = icao

    print(f'  APT_BASE.csv: {len(site_to_icao)} site→ICAO mappings', file=sys.stderr)
    return site_to_icao, faa_to_icao

# ── APT_RMK.csv parser ────────────────────────────────────────────────────────
# Catches airports with ATIS phone in remarks but no AWOS record

ATIS_PHONE_PATTERN = re.compile(
    r'(?:ATIS|D-ATIS|ATIS PHONE|ATIS PH)\s+[\d\.]+\s*[\.\-]?\s*'
    r'(\(?\d{3}\)?\s*[\-\.\s]\s*\d{3}\s*[\-\.\s]\s*\d{4})',
    re.IGNORECASE
)
BARE_PHONE_ATIS = re.compile(
    r'ATIS[^.]{0,40}?(\(?\d{3}\)?\s*[\-\.\s]\d{3}[\-\.\s]\d{4})',
    re.IGNORECASE
)

def parse_apt_rmk(raw: bytes, faa_to_icao: dict) -> dict:
    """Returns icao → {type, phone} from ATIS entries in airport remarks."""
    results = {}
    text = raw.decode('latin-1', errors='replace')
    reader = csv.DictReader(StringIO(text))
    for row in reader:
        remark = row.get('REMARK_TXT') or row.get('REMARK') or ''
        if 'ATIS' not in remark.upper():
            continue
        m = ATIS_PHONE_PATTERN.search(remark) or BARE_PHONE_ATIS.search(remark)
        if not m:
            continue
        phone = normalize_phone(m.group(1))
        if not phone:
            continue

        faa_id = (row.get('AIRPORT_ID') or row.get('SITE_NO') or '').strip().upper()
        icao   = faa_to_icao.get(faa_id) or derive_icao(faa_id, '')
        if icao:
            results[icao] = {'type': 'atis', 'phone': phone, 'city': '', 'state': ''}

    print(f'  APT_RMK.csv: {len(results)} ATIS phone numbers in remarks', file=sys.stderr)
    return results

# ── Fallback: APT.txt fixed-width parser ─────────────────────────────────────
# Used when CSV files are not present.
#
# APT record (1531 chars):
#   Cols  1-3  : "APT"
#   Cols  4-11 : Site number (8 chars)
#   Cols 27-31 : Location identifier / FAA ID (4 chars, left-justified)

def parse_apt_txt(raw: bytes) -> dict:
    """Returns site_no → icao_id."""
    site_to_icao = {}
    faa_to_icao  = {}
    text = raw.decode('latin-1', errors='replace')
    for line in text.splitlines():
        if not line.startswith('APT'):
            continue
        if len(line) < 31:
            continue
        site   = line[3:11].strip()
        faa_id = line[27:31].strip().upper()
        state  = line[48:50].strip() if len(line) > 50 else ''
        icao   = derive_icao(faa_id, state)
        if site and icao:
            site_to_icao[site] = icao
        if faa_id and icao:
            faa_to_icao[faa_id] = icao
    print(f'  APT.txt: {len(site_to_icao)} site→ICAO mappings (fallback)', file=sys.stderr)
    return site_to_icao, faa_to_icao

# ── Helpers ───────────────────────────────────────────────────────────────────

def normalize_phone(raw: str) -> Optional[str]:
    """Convert any phone format to E.164 (+1XXXXXXXXXX)."""
    if not raw:
        return None
    digits = re.sub(r'\D', '', raw)
    if len(digits) == 10:
        return f'+1{digits}'
    if len(digits) == 11 and digits[0] == '1':
        return f'+{digits}'
    return None

def derive_icao(faa_id: str, state: str = '') -> Optional[str]:
    """
    Derive 4-letter ICAO from FAA identifier.
    - CONUS airports (3 chars): prepend K → KXXX
    - Alaska airports: many start with P → PA/PF/PG/PH/PO
    - Hawaii: PHXX pattern
    - Caribbean: TJXX, MKXX
    - Some already have 4 chars
    """
    if not faa_id or len(faa_id) > 4:
        return None
    faa_id = faa_id.strip()
    if len(faa_id) == 4:
        return faa_id  # Already looks like ICAO
    if len(faa_id) == 3:
        state = state.strip().upper()
        if state == 'AK':
            return None  # Alaska is complex; skip
        if state == 'HI':
            return f'PH{faa_id[1:]}' if faa_id.startswith('H') else f'K{faa_id}'
        return f'K{faa_id}'
    return None

# ── SQL generation ────────────────────────────────────────────────────────────

TYPE_LABEL = {
    'ASOS':      'asos',
    'AWOS-A':    'awos-a',
    'AWOS-AV':   'awos-av',
    'AWOS-B':    'awos-b',
    'AWOS-C':    'awos-c',
    'AWOS-1':    'awos-1',
    'AWOS-2':    'awos-2',
    'AWOS-3':    'awos-3',
    'AWOS-3P':   'awos-3p',
    'AWOS-3PT':  'awos-3pt',
    'AWOS-4':    'awos-4',
    'atis':      'atis',
}

def sql_escape(s: str) -> str:
    return s.replace("'", "''")

def generate_sql(records: dict[str, dict]) -> str:
    if not records:
        return '-- No records found\n'

    lines = [
        '-- FAA NASR ATIS/AWOS/ASOS Phone Numbers',
        f'-- Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}',
        f'-- Total airports: {len(records)}',
        '',
        '-- Clear existing seeded data and reload',
        "DELETE FROM atis_phones;",
        '',
        'INSERT INTO atis_phones (icao, phone_number, type, notes) VALUES',
    ]

    rows = []
    for icao in sorted(records):
        r = records[icao]
        t = TYPE_LABEL.get(r.get('type', '').upper(), r.get('type', 'unknown'))
        note = sql_escape(f"{r.get('city', '')} {r.get('state', '')}".strip())
        rows.append(f"  ('{icao}', '{r['phone']}', '{t}', '{note}')")

    lines.append(',\n'.join(rows) + ';')
    lines.append('')
    lines.append(f'-- {len(records)} airports loaded')
    return '\n'.join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    cycle = sys.argv[1] if len(sys.argv) > 1 else current_cycle_date()
    print(f'FAA NASR Phone Parser — cycle {cycle}', file=sys.stderr)

    print('Downloading NASR zip…', file=sys.stderr)
    zf = download_nasr(cycle)

    filenames = zf.namelist()
    print(f'  Zip contains {len(filenames)} files', file=sys.stderr)

    # ── Build ICAO lookup (prefer CSV, fall back to APT.txt) ──────────────────
    site_to_icao: dict = {}
    faa_to_icao:  dict = {}

    apt_base_raw = read_file(zf, 'APT_BASE.csv')
    if apt_base_raw:
        site_to_icao, faa_to_icao = parse_apt_base(apt_base_raw)
    else:
        apt_txt_raw = read_file(zf, 'APT.txt')
        if apt_txt_raw:
            site_to_icao, faa_to_icao = parse_apt_txt(apt_txt_raw)
        else:
            print('  WARNING: Neither APT_BASE.csv nor APT.txt found — ICAO lookup unavailable', file=sys.stderr)

    # ── Parse AWOS.txt ────────────────────────────────────────────────────────
    all_records: dict = {}

    awos_raw = read_file(zf, 'AWOS.txt')
    if awos_raw:
        awos_stations = parse_awos(awos_raw)
        for site_no, info in awos_stations.items():
            # Try site_no → ICAO mapping first
            icao = site_to_icao.get(site_no)
            # Fall back to sensor_id
            if not icao:
                sid = info['sensor_id']
                icao = faa_to_icao.get(sid) or derive_icao(sid, info.get('state', ''))
            if icao:
                all_records[icao] = info
    else:
        print('  WARNING: AWOS.txt not found', file=sys.stderr)

    # ── Parse APT_RMK.csv for ATIS phone numbers ──────────────────────────────
    rmk_raw = read_file(zf, 'APT_RMK.csv')
    if rmk_raw:
        rmk_records = parse_apt_rmk(rmk_raw, faa_to_icao)
        # Merge: AWOS records take priority (more structured)
        for icao, info in rmk_records.items():
            if icao not in all_records:
                all_records[icao] = info
    else:
        print('  APT_RMK.csv not found — skipping remarks ATIS search', file=sys.stderr)

    print(f'\nTotal unique airports with phone numbers: {len(all_records)}', file=sys.stderr)

    # ── Output SQL ────────────────────────────────────────────────────────────
    print(generate_sql(all_records))

if __name__ == '__main__':
    main()
