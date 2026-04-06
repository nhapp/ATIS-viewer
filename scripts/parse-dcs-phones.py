#!/usr/bin/env python3
"""
FAA Digital Chart Supplement (DCS) Parser
==========================================
Downloads the current FAA DCS zip and produces two SQL files:

  airports.sql  — all ~6,000 US airports (icao, name, city, state)
                  for use in the `airports` Supabase table (powers search)

  dcs_phones.sql — ATIS phone numbers extracted from individual airport
                  PDFs inside the DCS zip (fills gaps in NASR data)

Requirements:
    pip install pdfminer.six

Usage:
    python3 scripts/parse-dcs-phones.py              # auto-detect cycle
    python3 scripts/parse-dcs-phones.py 20260319     # specify YYYYMMDD date
"""

import re
import sys
import xml.etree.ElementTree as ET
import zipfile
import urllib.request
from io import BytesIO
from datetime import datetime, timedelta
from typing import Optional

# ── Cycle date detection ──────────────────────────────────────────────────────
# DCS (Chart Supplement) updates on the same 28-day AIRAC cycle as NASR.
# Reference: 2026-03-19 is a confirmed cycle date.
REFERENCE_DATE = datetime(2026, 3, 19)

def current_cycle_yyyymmdd() -> str:
    today = datetime.utcnow()
    delta = (today - REFERENCE_DATE).days
    cycles = delta // 28
    d = REFERENCE_DATE + timedelta(days=cycles * 28)
    return d.strftime('%Y%m%d')

DCS_URL = 'https://aeronav.faa.gov/Upload_313-d/supplements/DCS_{date}.zip'

# ── Download ──────────────────────────────────────────────────────────────────

def download_dcs(date_str: str) -> zipfile.ZipFile:
    """Try the given date and one cycle back/forward."""
    d = datetime.strptime(date_str, '%Y%m%d')
    candidates = [
        (d - timedelta(days=28)).strftime('%Y%m%d'),
        date_str,
        (d + timedelta(days=28)).strftime('%Y%m%d'),
    ]
    for c in candidates:
        url = DCS_URL.format(date=c)
        print(f'  Trying {url} …', file=sys.stderr)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'ATIS-Viewer/1.0'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            print(f'  ✓ {len(data):,} bytes for cycle {c}', file=sys.stderr)
            return zipfile.ZipFile(BytesIO(data))
        except Exception as e:
            print(f'  ✗ {e}', file=sys.stderr)
    raise RuntimeError('Could not download DCS data.')

# ── XML parser ────────────────────────────────────────────────────────────────

def parse_xml(zf: zipfile.ZipFile) -> list[dict]:
    """
    Parse the afd_DDMMMYYYY.xml index.
    Returns list of dicts: {faa_id, name, city, state, pdfs:[filename, ...]}
    """
    xml_name = next(
        (n for n in zf.namelist() if re.match(r'afd_.*\.xml$', n, re.IGNORECASE)),
        None
    )
    if not xml_name:
        raise RuntimeError('afd_*.xml not found in DCS zip')

    raw  = zf.read(xml_name)
    root = ET.fromstring(raw.decode('latin-1', errors='replace'))

    airports: list = []
    for location in root.findall('location'):
        state = location.get('state', '')
        for apt in location.findall('airport'):
            faa_id  = (apt.findtext('aptid')   or '').strip().upper()
            name    = (apt.findtext('aptname') or '').strip()
            city    = (apt.findtext('aptcity') or '').strip()
            pages   = apt.find('pages')
            pdfs    = [p.text.strip() for p in pages.findall('pdf')] if pages is not None else []
            if faa_id and name:
                airports.append({
                    'faa_id': faa_id,
                    'name':   name,
                    'city':   city,
                    'state':  state,
                    'pdfs':   pdfs,
                })

    print(f'  XML: {len(airports)} airports indexed', file=sys.stderr)
    return airports

# ── ICAO derivation ───────────────────────────────────────────────────────────

STATE_ABBR = {
    'ALASKA': 'AK', 'HAWAII': 'HI', 'PUERTO RICO': 'PR',
    'VIRGIN ISLANDS': 'VI', 'GUAM': 'GU', 'AMERICAN SAMOA': 'AS',
    'NORTHERN MARIANA ISLANDS': 'MP',
}

def derive_icao(faa_id: str, state: str) -> Optional[str]:
    """Convert FAA 3-letter ID → 4-letter ICAO where possible."""
    if not faa_id:
        return None
    if len(faa_id) == 4:
        return faa_id   # already ICAO
    if len(faa_id) != 3:
        return None

    state_up = state.upper()
    abbr = STATE_ABBR.get(state_up, state_up[:2] if len(state_up) >= 2 else '')

    if abbr == 'AK':
        return None   # Alaska identifiers are complex (PA*, PO*, etc.)
    if abbr == 'HI':
        return f'PH{faa_id[1:]}' if faa_id.startswith('H') else f'K{faa_id}'
    if abbr in ('PR', 'VI'):
        return f'TJ{faa_id[1:]}' if faa_id.startswith('T') else f'K{faa_id}'

    return f'K{faa_id}'

# ── PDF text extraction ───────────────────────────────────────────────────────

try:
    from pdfminer.high_level import extract_text_to_fp
    from pdfminer.layout import LAParams
    import io as _io
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False

def pdf_to_text(raw_bytes: bytes) -> str:
    """Extract plain text from a PDF byte string using pdfminer.six."""
    if not PDF_AVAILABLE:
        return ''
    buf = _io.StringIO()
    try:
        extract_text_to_fp(
            _io.BytesIO(raw_bytes),
            buf,
            laparams=LAParams(line_margin=0.5),
            output_type='text',
            codec='utf-8',
        )
        return buf.getvalue()
    except Exception:
        return ''

# ── ATIS phone extraction ─────────────────────────────────────────────────────
#
# DCS Chart Supplement COMMUNICATIONS line patterns (pdfminer preserves en-dashes):
#
#   ATIS 127.75 562–608–4144/4145/4146          (freq then phone)
#   D–ATIS 118.85 115.8 113.7 650–821–0677      (multiple freqs then phone)
#   D–ATIS ARR 119.65 (404) 763–7988.           (ARR/DEP qualifier)
#   ATIS 135.275 650–858–0606                   (freq then phone)
#
# The phone always follows one or more decimal frequencies (e.g. 127.75).
# If the ATIS frequency is shared with ASOS, the phone is in WEATHER DATA SOURCES.

# Broad "separator" char class: space, hyphen, en-dash, period
SEP = r'[\s.\u2013\-]'

# Phone pattern: (NXX) NXX-XXXX  or  NXX-NXX-XXXX  (with any separator)
PHONE_PAT = r'(\(?\d{3}\)?' + SEP + r'?\d{3}' + SEP + r'\d{4})'

# Pattern A: ATIS/D-ATIS + optional qualifier + freq(s with decimal) + phone
# "ATIS 127.75 562–608–4144"  or  "D–ATIS ARR 119.65 (404) 763–7988"
_COMM_ATIS = re.compile(
    r'(?:D[\u2013\-])?ATIS\s+'        # ATIS or D–ATIS
    r'(?:ARR\s+|DEP\s+|ARR/DEP\s+)?'  # optional qualifier
    r'(?:\d+\.\d+\s+)+'               # one or more decimal frequencies
    + PHONE_PAT,
    re.IGNORECASE,
)

# Pattern B: WEATHER DATA SOURCES when ATIS shares ASOS/AWOS frequency
# "WEATHER DATA SOURCES: ASOS 132.625 (406) 233–0175"
# Used only when Pattern A fails — the ASOS phone IS the ATIS at these airports.
_WX_SOURCE = re.compile(
    r'WEATHER\s+DATA\s+SOURCES[^\n]*?'
    r'(?:ASOS|AWOS[^\s]*)\s+\d+\.\d+\s+'
    + PHONE_PAT,
    re.IGNORECASE,
)


def normalize_phone(raw: str) -> Optional[str]:
    digits = re.sub(r'\D', '', raw)
    if len(digits) == 10:
        return f'+1{digits}'
    if len(digits) == 11 and digits[0] == '1':
        return f'+{digits}'
    return None


def extract_atis_phone(text: str, faa_id: str = '') -> Optional[str]:
    """
    Extract ATIS phone from DCS PDF text.
    Isolates the target airport's section before searching, so airports that
    share a PDF page with others don't bleed phone numbers across sections.
    """
    lines = text.splitlines()

    # Locate the target airport's section start
    start_idx = 0
    if faa_id:
        pat = re.compile(r'\(' + re.escape(faa_id) + r'\)', re.IGNORECASE)
        for i, line in enumerate(lines):
            if pat.search(line):
                start_idx = i
                break

    # Locate the section end: next airport identifier or 100-line cap
    end_idx = min(start_idx + 100, len(lines))
    if faa_id:
        # A new airport header contains "(XXX)(KXXX)" or "(KXXX)" with a different ID
        next_apt = re.compile(r'\([A-Z0-9]{2,5}\)\([A-Z]{1}[A-Z0-9]{2,4}\)')
        for i, line in enumerate(lines[start_idx + 1:end_idx], start_idx + 1):
            if next_apt.search(line) and faa_id not in line:
                end_idx = i
                break

    section = '\n'.join(lines[start_idx:end_idx])

    # Pattern A: phone on the same COMMUNICATIONS line as ATIS/D-ATIS + frequency
    m = _COMM_ATIS.search(section)
    if m:
        p = normalize_phone(m.group(1))
        if p:
            return p

    # Pattern B: ATIS freq = ASOS/AWOS freq → use the weather-source phone
    # Only cross-reference when ATIS freq appears in WEATHER DATA SOURCES line
    atis_freq: Optional[str] = None
    for line in lines[start_idx:end_idx]:
        if 'COMMUNICATIONS' in line.upper() and 'ATIS' in line.upper():
            mf = re.search(r'ATIS\s+([\d.]+)', line, re.IGNORECASE)
            if mf:
                atis_freq = mf.group(1)
            break

    if atis_freq:
        for line in lines[start_idx:end_idx]:
            if 'WEATHER' in line.upper() and atis_freq in line:
                m = re.search(PHONE_PAT, line)
                if m:
                    p = normalize_phone(m.group(1))
                    if p:
                        return p

    return None

# ── SQL generation ────────────────────────────────────────────────────────────

def sql_esc(s: str) -> str:
    return s.replace("'", "''")

def generate_airports_sql(airports: list) -> str:
    lines = [
        '-- FAA DCS Airport Index',
        f'-- Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}',
        f'-- {len(airports)} airports',
        '',
        'INSERT INTO airports (icao, faa_id, name, city, state)',
        'VALUES',
    ]
    rows = []
    for a in airports:
        rows.append(
            f"  ('{sql_esc(a['icao'])}', '{sql_esc(a['faa_id'])}', "
            f"'{sql_esc(a['name'])}', '{sql_esc(a['city'])}', '{sql_esc(a['state'])}')"
        )
    lines.append(',\n'.join(rows))
    lines.append('ON CONFLICT (icao) DO UPDATE SET')
    lines.append('  name  = EXCLUDED.name,')
    lines.append('  city  = EXCLUDED.city,')
    lines.append('  state = EXCLUDED.state,')
    lines.append('  faa_id = EXCLUDED.faa_id;')
    return '\n'.join(lines)

def generate_phones_sql(phones: dict) -> str:
    if not phones:
        return '-- No DCS ATIS phone numbers found\n'
    lines = [
        '-- DCS ATIS Phone Numbers',
        f'-- Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}',
        f'-- {len(phones)} airports',
        '',
        'INSERT INTO atis_phones (icao, phone_number, type, notes)',
        'VALUES',
    ]
    rows = []
    for icao, phone in sorted(phones.items()):
        rows.append(f"  ('{icao}', '{phone}', 'atis', 'DCS')")
    lines.append(',\n'.join(rows))
    lines.append('ON CONFLICT (icao) DO UPDATE SET')
    lines.append('  phone_number = EXCLUDED.phone_number,')
    lines.append('  type = EXCLUDED.type,')
    lines.append('  notes = EXCLUDED.notes;')
    return '\n'.join(lines)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    date_str = sys.argv[1] if len(sys.argv) > 1 else current_cycle_yyyymmdd()
    print(f'FAA DCS Parser — cycle {date_str}', file=sys.stderr)

    if not PDF_AVAILABLE:
        print('WARNING: pdfminer.six not installed — PDF phone extraction skipped',
              file=sys.stderr)
        print('  Install with: pip install pdfminer.six', file=sys.stderr)

    print('Downloading DCS zip…', file=sys.stderr)
    zf = download_dcs(date_str)

    # Build zip filename index (case-insensitive)
    zip_names = {n.lower(): n for n in zf.namelist()}

    # Parse airport index
    raw_airports = parse_xml(zf)

    # Derive ICAO codes and deduplicate
    airport_records = []
    seen_icao = set()
    for a in raw_airports:
        icao = derive_icao(a['faa_id'], a['state'])
        if not icao:
            continue
        if icao in seen_icao:
            continue
        seen_icao.add(icao)
        airport_records.append({**a, 'icao': icao})

    print(f'  Resolved {len(airport_records)} unique ICAO codes', file=sys.stderr)

    # Extract ATIS phones from PDFs
    phone_records: dict[str, str] = {}
    if PDF_AVAILABLE:
        total = len(airport_records)
        found = 0
        print(f'Extracting ATIS phones from {total} PDFs…', file=sys.stderr)
        for i, a in enumerate(airport_records, 1):
            if i % 250 == 0 or i == total:
                print(f'  {i}/{total} processed, {found} phones found', file=sys.stderr)
            for pdf_name in a['pdfs']:
                key = pdf_name.lower()
                if key not in zip_names:
                    continue
                raw_pdf = zf.read(zip_names[key])
                text = pdf_to_text(raw_pdf)
                phone = extract_atis_phone(text, a['faa_id'])
                if phone:
                    phone_records[a['icao']] = phone
                    found += 1
                break   # only one PDF per airport

        print(f'  Done. {len(phone_records)} ATIS phone numbers extracted', file=sys.stderr)

    # Write outputs
    airports_sql = 'airports.sql'
    phones_sql   = 'dcs_phones.sql'

    with open(airports_sql, 'w') as f:
        f.write(generate_airports_sql(airport_records))
    print(f'\nWrote {airports_sql} ({len(airport_records)} airports)', file=sys.stderr)

    with open(phones_sql, 'w') as f:
        f.write(generate_phones_sql(phone_records))
    print(f'Wrote {phones_sql} ({len(phone_records)} ATIS phones)', file=sys.stderr)

    print('\nNext steps:', file=sys.stderr)
    print('  1. Run airports_table.sql in Supabase to create the airports table', file=sys.stderr)
    print('  2. Paste airports.sql into Supabase SQL editor', file=sys.stderr)
    print('  3. Paste dcs_phones.sql into Supabase SQL editor', file=sys.stderr)

if __name__ == '__main__':
    main()
