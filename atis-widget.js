// atis-widget.js — Shared ATIS, runway-wind, and weather visual functions

// ── Exclusive audio playback ───────────────────────────────────────────────────
// Ensures only one airport's audio plays at a time across both pages.
window._activeAtisAudio = null;
function _atisAudioPlay(el) {
  if (window._activeAtisAudio && window._activeAtisAudio !== el) {
    window._activeAtisAudio.pause();
  }
  window._activeAtisAudio = el;
}
// Include with <script src="atis-widget.js"></script> in index.html and tripatis.html.
//
// ATIS widget entry point:
//   atisWidgetHtml({ job, stationType, flightCat, onFetch, timerId }) → HTML string
//
// Runway/wind visuals:
//   runwayWindViz(icao, wind, confirmedRwy, forceConfirmed) → HTML string
//   airportLayoutSvg(icao, activeRwyHeading) → HTML string
//   compassSvg(dir) → HTML string
//   windHtml(wind) → HTML string
//
// Each page must define:
//   _onMissingRunwayData(icao) — called when ICAO not in RUNWAY_DATA; should fetch & re-render

// ── Runway headings database ───────────────────────────────────────────────────
const RUNWAY_DATA = {
  // Bay Area
  KPAO:[130,310], KSFO:[10,100,190,280], KOAK:[100,280], KSJC:[120,300],
  KSQL:[120,300], KNUQ:[140,320], KRHV:[130,310], KLVK:[91,271],
  KCCR:[20,200], KHAF:[120,300], KAPC:[60,240,180,360], KSTS:[140,320,20,200],
  KWVI:[20,200,80,260], KMRY:[100,280], KSCK:[110,290], KMOD:[124,304],
  KFAT:[120,300], KSMF:[160,340], KSBA:[70,250], KSBP:[120,300],
  // Pacific NW
  KSEA:[160,340], KBFI:[130,310], KPAE:[160,340], KPDX:[100,280,30,210],
  KGEG:[45,70,225,270], KEUG:[160,340], KMFR:[50,230,140,320],
  // Southern CA
  KLAX:[70,83,250,263], KVNY:[160,340], KBUR:[150,330], KLGB:[120,300],
  KSNA:[200,20], KONT:[70,250], KPSP:[130,310], KSAN:[270,90], KSMO:[210,30],
  // Nevada / Arizona
  KLAS:[70,190,250,10], KRNO:[160,340,70,250], KTRK:[100,280], KPHX:[80,260], KTUS:[135,315,30,210],
  KSDL:[210,30],
  // Mountain
  KDEN:[70,160,250,340], KCOS:[120,300], KSLC:[160,340], KBOI:[115,295],
  KBZN:[120,300],
  // Northeast
  KJFK:[40,130,220,310], KLGA:[40,130,220,310], KEWR:[40,110,220,290],
  KTEB:[190,10], KBOS:[40,90,150,220,270,330], KPHL:[90,270,350,170],
  KBWI:[100,280,150,330], KDCA:[40,220,30,210], KIAD:[120,300,190,10],
  KPIT:[100,280,140,320], KBUF:[140,320,230,50], KSYR:[100,280,150,330],
  KALB:[190,10,100,280], KRIC:[160,340], KPVD:[160,340], KMHT:[170,350], KBDL:[60,240],
  KBDR:[60,240,110,290], KHVN:[20,200], KGON:[50,230], KORH:[110,290], KEEN:[140,320],
  // Southeast
  KATL:[80,90,260,270], KMIA:[90,80,270,260], KFLL:[90,270], KPBI:[90,270],
  KMCO:[180,360,170,350], KTPA:[190,100,10,280], KRSW:[60,240],
  KJAX:[70,250,130,310], KPNS:[170,350], KCLT:[180,360], KRDU:[140,320],
  KCHS:[150,330], KMSY:[110,290,180,360], KMEM:[180,360,270,90],
  KBNA:[130,310,20,200], KTYS:[230,50],
  // Midwest
  KORD:[40,90,100,220,270,280], KMDW:[130,310], KMSP:[120,170,300,350],
  KDTW:[29,89,209,269], KCVG:[90,180,270,360], KSTL:[120,110,300,290],
  KMCI:[90,180,270,360], KGRR:[80,260], KMKE:[80,260,130,310], KIND:[50,230],
  KCMH:[100,280], KCLE:[60,240], KDSM:[130,310],
  // South Central
  KDFW:[130,180,310,360], KDAL:[136,316], KADS:[150,330],
  KIAH:[90,80,270,260,140,320], KHOU:[130,310], KSAT:[130,310,30,210],
  KAUS:[180,360], KELP:[260,80], KABQ:[210,30,80,260],
  KOKC:[180,360,130,310], KTUL:[180,360],
  // Alaska / Hawaii
  PANC:[70,150,250,330], PAFA:[200,20], PAJN:[80,260],
  PHNL:[80,40,260,220], PHKO:[180,360], PHOG:[50,230],
  // Canada
  CYVR:[80,120,260,300], CYYC:[170,280,350,100], CYYZ:[60,150,240,330],
  CYUL:[60,240], CYOW:[140,320], CYHZ:[150,60,330,240],
  // Europe
  EGLL:[90,270], EGKK:[80,260], EGCC:[50,230], EGPH:[60,240],
  LFPG:[90,80,270,260], LFPO:[80,260], EDDF:[80,70,260,250],
  EDDM:[80,260], EDDB:[80,260], EHAM:[90,180,270,360,40,220],
  EBBR:[80,260,30,210], LSZH:[140,320,100,280], LIRF:[160,70,340,250],
  LEMD:[180,140,360,320], LEBL:[70,200,250,20], ESSA:[80,260],
  EKCH:[40,220], ENGM:[180,360], EFHK:[150,330], EPWA:[150,330],
  LOWW:[110,160,290,340],
  // Middle East / Asia
  OMDB:[120,300,130,310], OMAA:[130,310], OTBD:[160,340], LLBG:[80,260],
  RJTT:[160,340], RJAA:[160,340], RKSI:[150,330], VHHH:[70,250],
  WSSS:[20,200], ZBAA:[173,180,353,360],
  // Aus / NZ
  YSSY:[160,70,340,250], YMML:[160,270,340,90], YBBN:[140,10,320,190],
  NZAA:[72,252], FAOR:[30,10,210,190],
};

// ── Runway geometry helpers ────────────────────────────────────────────────────

function normalizeAngle(a) { return ((a % 360) + 540) % 360 - 180; }

function rwyDesignatorToHeading(icao, designator) {
  const runways = RUNWAY_DATA[icao];
  if (!runways || !designator) return null;
  const num = parseInt(designator);
  if (!num) return null;
  const target = (num * 10) % 360 || 360;
  let best = null, bestDiff = Infinity;
  for (const h of runways) {
    const diff = Math.abs(normalizeAngle(h - target));
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  return bestDiff <= 25 ? best : null;
}

// ── North-up airport layout SVG ────────────────────────────────────────────────

function airportLayoutSvg(icao, activeRwyHeading) {
  const runways = RUNWAY_DATA[icao];
  if (!runways) {
    if (icao && typeof _onMissingRunwayData === 'function') _onMissingRunwayData(icao);
    return '';
  }

  const cx = 100, cy = 100;
  const L = 58, W = 5;

  const lines = [];
  for (const h of runways) {
    const low = h > 180 ? h - 180 : h;
    const dupe = lines.find(l =>
      Math.abs(normalizeAngle(l.low - h)) < 5 ||
      Math.abs(normalizeAngle(l.low - h + 180)) < 5 ||
      Math.abs(normalizeAngle(l.low - h - 180)) < 5
    );
    if (dupe) dupe.originals.push(h);
    else lines.push({ low, originals: [h] });
  }

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (Math.abs(lines[i].low - lines[j].low) < 20) {
        lines[i].lateralOffset = -14;
        lines[j].lateralOffset = 14;
      }
    }
  }

  const parts = [];
  for (const { low, originals, lateralOffset = 0 } of lines) {
    const rad  = low * Math.PI / 180;
    const sinL = Math.sin(rad), cosL = Math.cos(rad);
    const ocx = cx + lateralOffset * cosL;
    const ocy = cy + lateralOffset * sinL;
    const lowNum  = Math.round(low / 10) || 36;
    const highH   = (low + 180) % 360;
    const highNum = Math.round(highH / 10) || 36;
    const isHighActive = activeRwyHeading != null && Math.abs(normalizeAngle(activeRwyHeading - highH)) <= 15;
    const isLowActive  = activeRwyHeading != null && Math.abs(normalizeAngle(activeRwyHeading - low)) <= 15;
    const isActive = isHighActive || isLowActive;
    const fill   = isActive ? '#1a3d28' : '#111a11';
    const stroke = isActive ? '#52b788' : '#243824';
    const tAct   = '#7dffc0';
    const tBase  = isActive ? '#8892b0' : '#4a5468';

    parts.push(`<g transform="translate(${ocx.toFixed(1)},${ocy.toFixed(1)}) rotate(${low})">
      <rect x="${-W}" y="${-L}" width="${W*2}" height="${L*2}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
      <line x1="0" y1="${(-L*0.55).toFixed(1)}" x2="0" y2="${(-L*0.15).toFixed(1)}" stroke="#ffffff15" stroke-width="1" stroke-dasharray="3,4"/>
      <line x1="0" y1="${(L*0.15).toFixed(1)}"  x2="0" y2="${(L*0.55).toFixed(1)}"  stroke="#ffffff15" stroke-width="1" stroke-dasharray="3,4"/>
      ${isHighActive ? `<polygon points="0,${-L+3} -4,${-L+10} 4,${-L+10}" fill="#52b788"/>` : ''}
      ${isLowActive  ? `<polygon points="0,${L-3}  -4,${L-10}  4,${L-10}"  fill="#52b788"/>` : ''}
    </g>`);

    const LBL = L + 13;
    const lx1 = (ocx + LBL * Math.sin(rad)).toFixed(1);
    const ly1 = (ocy - LBL * Math.cos(rad)).toFixed(1);
    const lx2 = (ocx - LBL * Math.sin(rad)).toFixed(1);
    const ly2 = (ocy + LBL * Math.cos(rad)).toFixed(1);
    parts.push(`<text x="${lx1}" y="${ly1}" text-anchor="middle" dominant-baseline="middle" fill="${isHighActive ? tAct : tBase}" font-size="13" font-family="monospace" font-weight="bold">${String(highNum).padStart(2,'0')}</text>`);
    parts.push(`<text x="${lx2}" y="${ly2}" text-anchor="middle" dominant-baseline="middle" fill="${isLowActive ? tAct : tBase}" font-size="13" font-family="monospace" font-weight="bold">${String(lowNum).padStart(2,'0')}</text>`);
  }

  return `<svg width="130" height="130" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
    <circle cx="100" cy="100" r="97" fill="#090e18" stroke="#1e2d45" stroke-width="1"/>
    <text x="100" y="11"  text-anchor="middle" fill="#ffffffb0" font-size="15" font-family="monospace" font-weight="bold">N</text>
    <line x1="100" y1="14" x2="100" y2="22" stroke="#ffffff70" stroke-width="1.5"/>
    <text x="100" y="197" text-anchor="middle" fill="#ffffff50" font-size="13" font-family="monospace">S</text>
    <text x="5"   y="103" text-anchor="start" fill="#ffffff50" font-size="13" font-family="monospace">W</text>
    <text x="196" y="103" text-anchor="end"   fill="#ffffff50" font-size="13" font-family="monospace">E</text>
    ${parts.join('\n    ')}
  </svg>`;
}

// ── Runway + wind component SVG ────────────────────────────────────────────────

function runwayWindSvg(uid, rwyNum, rwyHeading, windDir, windSpd, confirmed = false, runwayData = null) {
  const alpha = windSpd > 0 ? normalizeAngle(windDir - rwyHeading) : 0;
  const rad   = alpha * Math.PI / 180;
  const xw    = windSpd * Math.sin(rad);
  const hw    = windSpd * Math.cos(rad);
  const xwAbs = Math.abs(xw), hwAbs = Math.abs(hw);
  const calm  = windSpd < 0.5;

  const xwColor = xwAbs < 5 ? '#64ffda' : xwAbs < 10 ? '#ffb347' : '#ff6b6b';
  const hwColor = hw < 0 ? '#ff6b6b' : '#64ffda';

  const cx = 100, ac_y = 88;
  const hwBarLen = hwAbs >= 0.5 ? Math.max(14, Math.min(hwAbs * 3, 50)) : 0;
  const hwRefY   = 55;
  const hwTipX   = Math.sin(rad) >= 0 ? 128 : 72;
  const hwTipY   = hwRefY;
  const hwTailX  = hwTipX + hwBarLen * Math.sin(rad);
  const hwTailY  = hwRefY - hwBarLen * Math.cos(rad);
  const hwMarkId = `hwarr-${uid.toLowerCase().replace(/\W/g,'')}`;

  const barY  = 82;
  const fromR = xw > 0;
  const bsx   = cx + (fromR ? 70 : -70);
  const bex   = cx + (fromR ? 26 : -26);
  const markId = `xwarr-${uid.toLowerCase().replace(/\W/g,'')}`;

  const rwyLabel = String(rwyNum).padStart(2, '0');
  const oppNum   = rwyNum > 18 ? rwyNum - 18 : rwyNum + 18;
  const oppLabel = String(oppNum).padStart(2, '0');

  return `
  <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0;">
    <div style="align-self:flex-start;margin-bottom:4px">
      ${(() => {
        const chk = `<span style="font-size:14px;margin-left:4px;opacity:0.9">✓</span>`;
        if (runwayData && confirmed && (runwayData.arr.length || runwayData.dep.length)) {
          const { arr, dep } = runwayData;
          const isCombined = arr.length === dep.length && arr.every(r => dep.includes(r));
          let h = `<div class="data-label" style="margin-bottom:5px">RUNWAY IN USE</div>`;
          if (isCombined) {
            h += `<div style="display:flex;flex-wrap:wrap;gap:4px">${arr.map(r => `<span class="runway-tag combined" style="font-size:13px;padding:3px 9px">${r}${chk}</span>`).join('')}</div>`;
          } else {
            if (arr.length) h += `<div style="font-size:10px;color:var(--text-dim);letter-spacing:.5px;margin-bottom:3px">ARR</div><div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px">${arr.map(r => `<span class="runway-tag" style="font-size:12px;padding:3px 8px">${r}${chk}</span>`).join('')}</div>`;
            if (dep.length) h += `<div style="font-size:10px;color:var(--text-dim);letter-spacing:.5px;margin-bottom:3px">DEP</div><div style="display:flex;flex-wrap:wrap;gap:3px">${dep.map(r => `<span class="runway-tag dep" style="font-size:12px;padding:3px 8px">${r}${chk}</span>`).join('')}</div>`;
          }
          return h;
        }
        return `<div class="data-label" style="margin-bottom:2px">${confirmed ? 'RUNWAY IN USE' : 'SUGGESTED RUNWAY'}</div>
          <div style="color:var(--accent);font-size:32px;font-weight:900;letter-spacing:5px;line-height:1">${String(rwyNum).padStart(2,'0')}</div>`;
      })()}
    </div>
    <svg width="150" height="122" viewBox="0 0 200 163" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="${markId}" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0,7 2.5,0 5" fill="${xwColor}"/>
        </marker>
        <marker id="${hwMarkId}" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
          <polygon points="0 0,7 2.5,0 5" fill="${hwColor}"/>
        </marker>
      </defs>

      <!-- Runway surface -->
      <rect x="87" y="12" width="26" height="100" rx="3" fill="#1c2a1c" stroke="#3d5c3d" stroke-width="1.5"/>
      ${[24,38,52,66,80,94].map(y=>`<line x1="100" y1="${y}" x2="100" y2="${y+8}" stroke="#ffffff22" stroke-width="1.5"/>`).join('')}
      <rect x="90" y="104" width="5" height="5" rx="1" fill="#ffffff40"/>
      <rect x="97" y="104" width="5" height="5" rx="1" fill="#ffffff40"/>
      <rect x="104" y="104" width="5" height="5" rx="1" fill="#ffffff40"/>
      <text x="100" y="24" text-anchor="middle" fill="#ffffffa0" font-size="13" font-family="monospace" font-weight="bold">${oppLabel}</text>
      <text x="100" y="126" text-anchor="middle" fill="#ffffffa0" font-size="13" font-family="monospace" font-weight="bold">RWY ${rwyLabel}${confirmed ? `<tspan fill="#64ffda" font-size="11"> ✓</tspan>` : ''}</text>

      <!-- Aircraft -->
      <rect  x="98"  y="72"  width="4"  height="20" rx="2"   fill="#ddeeff"/>
      <polygon points="100,67 96,76 104,76"                   fill="#ddeeff"/>
      <rect  x="80"  y="80"  width="40" height="4"  rx="2"   fill="#ddeeff"/>
      <rect  x="91"  y="91"  width="18" height="3"  rx="1.5" fill="#ddeeff"/>

      <!-- Crosswind arrow -->
      ${!calm && xwAbs >= 0.5 ? `
      <line x1="${bsx}" y1="${barY}" x2="${bex}" y2="${barY}"
            stroke="${xwColor}" stroke-width="3" stroke-linecap="round" opacity="0.9"
            marker-end="url(#${markId})"/>
      <text x="${fromR ? bsx - 5 : bsx + 5}" y="${barY - 8}"
            text-anchor="${fromR ? 'end' : 'start'}"
            fill="${xwColor}" font-size="12" font-family="monospace" font-weight="700">${Math.round(xwAbs)}kt</text>
      ` : ''}

      <!-- Headwind / tailwind arrow -->
      ${!calm && hwAbs >= 0.5 ? (() => {
        const dx = hwTailX - hwTipX, dy = hwTailY - hwTipY;
        const mag = Math.sqrt(dx*dx + dy*dy) || 1;
        const lx = (hwTailX + dx/mag * 9).toFixed(1);
        const ly = (hwTailY + dy/mag * 9).toFixed(1);
        return `<line x1="${hwTailX.toFixed(1)}" y1="${hwTailY.toFixed(1)}" x2="${hwTipX}" y2="${hwTipY}"
              stroke="${hwColor}" stroke-width="3" stroke-linecap="round" opacity="0.9"
              marker-end="url(#${hwMarkId})"/>
        <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle"
              fill="${hwColor}" font-size="12" font-family="monospace" font-weight="700">${Math.round(hwAbs)}kt</text>`;
      })() : ''}
    </svg>
  </div>`;
}

function runwayWindViz(icao, wind, confirmedRwy = null, forceConfirmed = false) {
  const runways = RUNWAY_DATA[icao];
  if (!runways) {
    if (wind && typeof _onMissingRunwayData === 'function') _onMissingRunwayData(icao);
    return '';
  }
  if (!wind) return '';
  if (wind.dir === null) {
    return runwayWindSvg(icao, Math.round(runways[0] / 10), runways[0], 0, 0, !!confirmedRwy || forceConfirmed);
  }
  if (wind.dir === 'VRB') return `<div style="font-size:12px;color:var(--text-dim);padding:6px 0">Variable wind — runway not deterministic</div>`;

  const wDir = parseInt(wind.dir);
  const wSpd = wind.spd || 0;

  if (confirmedRwy) {
    const confirmedH = rwyDesignatorToHeading(icao, confirmedRwy)
      ?? (() => { const n = parseInt(confirmedRwy); return n ? (n * 10) % 360 || 360 : null; })();
    if (confirmedH !== null) {
      return runwayWindSvg(icao, parseInt(confirmedRwy) || Math.round(confirmedH / 10) || 36, confirmedH, wDir, wSpd, true);
    }
  }

  let bestRwy = runways[0], bestHW = -Infinity;
  for (const rh of runways) {
    const hw = wSpd * Math.cos(normalizeAngle(wDir - rh) * Math.PI / 180);
    if (hw > bestHW) { bestHW = hw; bestRwy = rh; }
  }
  return runwayWindSvg(icao, Math.round(bestRwy / 10) || 36, bestRwy, wDir, wSpd, forceConfirmed);
}

// ── Compass rose ───────────────────────────────────────────────────────────────

function compassSvg(dir) {
  const deg = parseInt(dir);
  if (isNaN(deg)) return '';
  const rad = (deg - 90) * Math.PI / 180;
  const cx = 23, cy = 23, r = 18;
  const tipX  = (cx + r * Math.cos(rad)).toFixed(1);
  const tipY  = (cy + r * Math.sin(rad)).toFixed(1);
  const lx1   = (cx + (r-10) * Math.cos(rad - 0.4)).toFixed(1);
  const ly1   = (cy + (r-10) * Math.sin(rad - 0.4)).toFixed(1);
  const lx2   = (cx + (r-10) * Math.cos(rad + 0.4)).toFixed(1);
  const ly2   = (cy + (r-10) * Math.sin(rad + 0.4)).toFixed(1);
  return `
    <div class="compass">
      <svg viewBox="0 0 46 46" xmlns="http://www.w3.org/2000/svg">
        <circle cx="23" cy="23" r="20" fill="rgba(0,180,216,0.07)" stroke="rgba(0,180,216,0.25)" stroke-width="1.5"/>
        <line x1="23" y1="5" x2="23" y2="9" stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/>
        <polygon points="${tipX},${tipY} ${lx1},${ly1} ${lx2},${ly2}" fill="var(--green)" opacity="0.9"/>
        <circle cx="23" cy="23" r="2.5" fill="rgba(255,255,255,0.3)"/>
      </svg>
    </div>`;
}

// ── Wind HTML block ────────────────────────────────────────────────────────────

function windHtml(wind) {
  if (!wind) return `<span style="color:var(--text-dim)">N/A</span>`;
  const compass = (wind.dir && wind.dir !== 'VRB') ? compassSvg(wind.dir) : '';
  const dirStr = wind.dir === null ? 'CALM' : wind.dir === 'VRB' ? 'VRB' : `${wind.dir}°`;
  const spdStr = wind.dir === null ? '' : ` @ ${wind.spd}KT`;
  const gustStr = wind.gust ? `<span class="wind-gust">Gusts ${wind.gust}KT</span>` : '';
  return `
    <div class="wind-display">
      ${compass}
      <div class="wind-text">
        <span class="wind-main">${dirStr}${spdStr}</span>
        ${gustStr}
      </div>
    </div>`;
}

// ── ATIS retrieve/display widget ───────────────────────────────────────────────
// atisWidgetHtml({ job, stationType, flightCat, onFetch, timerId }) → HTML string

function atisWidgetHtml({ job, stationType, flightCat, onFetch, timerId = null }) {
  const isAwos = stationType && stationType !== 'atis';
  const stationLabel = isAwos ? 'AWOS' : 'ATIS';

  // ── Not yet fetched: solid retrieve button ─────────────────────────────────
  if (!job) {
    return `<div style="margin-top:10px">
      <button onclick="${onFetch}"
        style="width:100%;padding:10px 12px;border-radius:6px;border:none;
               background:var(--accent);color:#000;cursor:pointer;font-family:inherit;
               font-size:12px;font-weight:900;letter-spacing:2px;transition:opacity .2s"
        onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
        RETRIEVE ${stationLabel}
      </button>
    </div>`;
  }

  const fcColor = flightCat === 'IFR' || flightCat === 'LIFR' ? '#ff6b6b'
                : flightCat === 'MVFR' ? '#6496ff' : '#64ffda';

  const STATUS = {
    calling:      { icon: '📞', text: `RETRIEVING ${stationLabel}…`,  color: '#ffb347' },
    transcribing: { icon: '🎙️', text: 'TRANSCRIBING AUDIO…',          color: '#ffb347' },
    complete:     { icon: '✅', text: `${stationLabel} CURRENT${job.parsed?.code ? ` [${job.parsed.code}]` : ''}`, color: fcColor },
    error:        { icon: '⚠️', text: `${stationLabel} FETCH FAILED`,  color: '#ff6b6b' },
  };

  const s = STATUS[job.status];
  if (!s) return '';

  const isActive = job.status === 'calling' || job.status === 'transcribing';
  let cdText = '';
  if (isActive && job.startedAt) {
    const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
    cdText = ` · ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')} elapsed`;
  }
  const timerSpan = timerId ? `<span id="${timerId}">${cdText}</span>` : cdText;

  let html = `<div style="margin-top:10px;padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.05);border:1px solid ${s.color}40">
    <div style="font-size:12px;color:${s.color};letter-spacing:.5px">${s.icon} ${s.text}${timerSpan}</div>`;

  if (job.status === 'complete' && job.fetchedAt) {
    const ft = new Date(job.fetchedAt);
    const hhmm = ft.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div style="font-size:10px;color:var(--text-dim);margin-top:2px">Retrieved ${hhmm}</div>`;
  }

  if (job.status === 'complete' && job.parsed) {
    const p = job.parsed;
    let windDetail = '';
    if (p.wind && p.runway && p.wind.dir !== 'VRB' && p.wind.spd > 0) {
      const rwyHdg = parseInt(p.runway) * 10;
      const angle  = (parseInt(p.wind.dir) - rwyHdg) * Math.PI / 180;
      const hw = Math.round(p.wind.spd * Math.cos(angle));
      const xw = Math.round(Math.abs(p.wind.spd * Math.sin(angle)));
      const hwLabel = hw >= 0 ? `Headwind ${hw}kt` : `Tailwind ${Math.abs(hw)}kt`;
      windDetail = `<div style="font-size:11px;color:var(--text-dim);margin-top:2px;padding-left:4px">${hwLabel} · X-wind ${xw}kt</div>`;
    }
    const altFmt = p.altimeter ? (() => { const a = String(p.altimeter); return a.length === 4 ? a.slice(0,2)+'.'+a.slice(2) : a; })() : null;

    html += `<details style="margin-top:6px">
      <summary style="font-size:11px;color:var(--accent);cursor:pointer;letter-spacing:.5px;user-select:none;list-style:none;display:block">▼ Details</summary>
      <div style="margin-top:8px;font-size:13px;color:var(--text)">`;
    if (isAwos) html += `<div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;letter-spacing:.5px">WEATHER DATA ONLY · NO RUNWAY OR TRAFFIC INFORMATION</div>`;
    if (p.wind) {
      const ws = p.wind.spd === 0 ? 'CALM' : `${p.wind.dir === 'VRB' ? 'VRB' : p.wind.dir + '°'} @ ${p.wind.spd}kt${p.wind.gust ? ` G${p.wind.gust}kt` : ''}`;
      html += `<div><span class="data-label">WIND</span> ${ws}</div>${windDetail}`;
    }
    if (p.visibility) html += `<div style="margin-top:4px"><span class="data-label">VIS</span> ${p.visibility} SM</div>`;
    if (p.ceiling)    html += `<div style="margin-top:4px"><span class="data-label">CEILING</span> ${p.ceiling.cover} ${p.ceiling.height.toLocaleString()}ft</div>`;
    if (altFmt)       html += `<div style="margin-top:4px"><span class="data-label">ALTIMETER</span> A${altFmt}</div>`;
    if (p.runway)     html += `<div style="margin-top:4px"><span class="data-label">LANDING/DEPARTING</span> <span style="font-size:15px;font-weight:700;color:var(--text)">${p.runway}</span> <span style="color:#64ffda">✓</span></div>`;
    html += `</div>`;

    if (job.audioUrl) html += `<div style="margin-top:8px"><audio controls onplay="_atisAudioPlay(this)" style="width:100%;height:28px;opacity:0.85"><source src="${job.audioUrl}" type="audio/mpeg"></audio></div>`;

    if (job.transcription) {
      const normalized = _atisNormalizeTranscript(job.transcription);
      const display = isAwos ? _atisOrientAwos(normalized) : normalized;
      html += `<div style="font-size:11px;color:var(--text-dim);margin-top:8px;padding-top:8px;border-top:1px solid var(--border);white-space:pre-wrap;line-height:1.6">${display}</div>`;
    }
    html += `</details>`;
    html += `<div style="margin-top:6px"><button onclick="${onFetch}" style="font-size:10px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text-dim);cursor:pointer;font-family:inherit;letter-spacing:.5px">↻ Refresh</button></div>`;
  }

  if (job.status === 'error') {
    if (job.error) html += `<div style="font-size:11px;color:var(--text-dim);margin-top:4px">${job.error}</div>`;
    html += `<div style="margin-top:6px"><button onclick="${onFetch}" style="font-size:10px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text-dim);cursor:pointer;font-family:inherit;letter-spacing:.5px">Try Again</button></div>`;
  }

  html += '</div>';
  return html;
}

// ── Transcript helpers ─────────────────────────────────────────────────────────

function _atisOrientAwos(text) {
  const pat = /\bautomated\s+(?:weather|surface)\s+(?:observation|station)\b/gi;
  let lastIdx = -1, m;
  while ((m = pat.exec(text)) !== null) lastIdx = m.index;
  if (lastIdx < 0) return text;
  const before = text.slice(0, lastIdx);
  const dot = before.lastIndexOf('. ');
  const start = (dot >= 0 && lastIdx - dot <= 80) ? dot + 2 : lastIdx;
  const head = text.slice(start).trim();
  const tail = text.slice(0, start).trim();
  return tail ? head + ' ' + tail : head;
}

const _NW = {ZERO:0,ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINER:9,NINE:9,TEN:10,ELEVEN:11,TWELVE:12,THIRTEEN:13,FOURTEEN:14,FIFTEEN:15,SIXTEEN:16,SEVENTEEN:17,EIGHTEEN:18,NINETEEN:19,TWENTY:20,THIRTY:30,FORTY:40,FIFTY:50,SIXTY:60,SEVENTY:70,EIGHTY:80,NINETY:90};
const _ND = 'ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINER|NINE';
const _NA = _ND + '|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|FIFTY|SIXTY|SEVENTY|EIGHTY|NINETY';
const _NT = 'TWENTY|THIRTY|FORTY|FIFTY|SIXTY|SEVENTY|EIGHTY|NINETY';
const _NTe = 'TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN';
const _NO = 'ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINER|NINE';
const _nv = s => s.trim().split(/\s+/).reduce((n, w) => n + (_NW[w] || 0), 0);
const _nd = s => s.trim().split(/\s+/).map(w => String(_NW[w] !== undefined ? _NW[w] : w)).join('');

function _atisNormalizeTranscript(text) {
  let t = text.toUpperCase();
  t = t.replace(new RegExp(`\\b((?:${_ND})(?:\\s+(?:${_ND}))*)\\s+POINT\\s+((?:${_ND})(?:\\s+(?:${_ND}))*)\\b`, 'g'), (_, l, r) => `${_nd(l)}.${_nd(r)}`);
  t = t.replace(new RegExp(`\\b((?:${_NA})(?:\\s+(?:${_NA}))*?)\\s+THOUSAND\\s+((?:${_NA})(?:\\s+(?:${_NA}))*?)\\s+HUNDRED(?:\\s+AND\\s+((?:${_NA})(?:\\s+(?:${_NA}))*?))?\\b`, 'g'), (_, th, hu, re) => String(_nv(th) * 1000 + _nv(hu) * 100 + (re ? _nv(re) : 0)));
  t = t.replace(new RegExp(`\\b((?:${_NA})(?:\\s+(?:${_NA}))*?)\\s+THOUSAND(?:\\s+(?:AND\\s+)?((?:${_NA})(?:\\s+(?:${_NA}))*?))?\\b`, 'g'), (_, th, re) => String(_nv(th) * 1000 + (re ? _nv(re) : 0)));
  t = t.replace(new RegExp(`\\b((?:${_NA})(?:\\s+(?:${_NA}))*?)\\s+HUNDRED(?:\\s+(?:AND\\s+)?((?:${_NA})(?:\\s+(?:${_NA}))*?))?\\b`, 'g'), (_, hu, re) => String(_nv(hu) * 100 + (re ? _nv(re) : 0)));
  t = t.replace(new RegExp(`\\b(${_NT})\\s+(${_NO})\\b`, 'g'), (_, tens, ones) => String((_NW[tens] || 0) + (_NW[ones] || 0)));
  t = t.replace(new RegExp(`\\b(${_NT}|${_NTe})\\b`, 'g'), (_, w) => String(_NW[w]));
  t = t.replace(new RegExp(`\\b((?:${_ND})(?:\\s+(?:${_ND}))*)\\b`, 'g'), (_, seq) => _nd(seq));
  return t;
}
