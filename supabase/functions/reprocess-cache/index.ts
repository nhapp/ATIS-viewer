import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PHONETIC: Record<string, string> = {
  ALPHA:'A', BRAVO:'B', CHARLIE:'C', DELTA:'D', ECHO:'E', FOXTROT:'F',
  GOLF:'G', HOTEL:'H', INDIA:'I', JULIET:'J', KILO:'K', LIMA:'L',
  MIKE:'M', NOVEMBER:'N', OSCAR:'O', PAPA:'P', QUEBEC:'Q', ROMEO:'R',
  SIERRA:'S', TANGO:'T', UNIFORM:'U', VICTOR:'V', WHISKEY:'W', XRAY:'X',
  YANKEE:'Y', ZULU:'Z',
}

const W: Record<string, number> = {
  ZERO:0, ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5, SIX:6, SEVEN:7, EIGHT:8, NINER:9, NINE:9,
  TEN:10, ELEVEN:11, TWELVE:12, THIRTEEN:13, FOURTEEN:14, FIFTEEN:15,
  SIXTEEN:16, SEVENTEEN:17, EIGHTEEN:18, NINETEEN:19,
  TWENTY:20, THIRTY:30, FORTY:40, FIFTY:50, SIXTY:60, SEVENTY:70, EIGHTY:80, NINETY:90,
}
const _D  = 'ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINER|NINE'
const _A  = _D + '|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|FIFTY|SIXTY|SEVENTY|EIGHTY|NINETY'
const _T  = 'TWENTY|THIRTY|FORTY|FIFTY|SIXTY|SEVENTY|EIGHTY|NINETY'
const _Te = 'TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN'
const _O  = 'ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINER|NINE'
const _toVal = (s: string): number => s.trim().split(/\s+/).reduce((n, w) => n + (W[w] ?? 0), 0)
const _toDig = (s: string): string => s.trim().split(/\s+/).map(w => String(W[w] ?? w)).join('')

function normalizeSpoken(raw: string): string {
  let t = raw.toUpperCase()
  t = t.replace(
    /\bINFORMATION\s+(ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIET|KILO|LIMA|MIKE|NOVEMBER|OSCAR|PAPA|QUEBEC|ROMEO|SIERRA|TANGO|UNIFORM|VICTOR|WHISKEY|XRAY|YANKEE|ZULU)\b/g,
    (_, w) => `INFORMATION ${PHONETIC[w]}`
  )
  t = t.replace(
    new RegExp(`\\b((?:${_D})(?:\\s+(?:${_D}))*)\\s+POINT\\s+((?:${_D})(?:\\s+(?:${_D}))*)\\b`, 'g'),
    (_, l, r) => `${_toDig(l)}.${_toDig(r)}`
  )
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+THOUSAND\\s+((?:${_A})(?:\\s+(?:${_A}))*?)\\s+HUNDRED(?:\\s+AND\\s+((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, th, hu, re) => String(_toVal(th) * 1000 + _toVal(hu) * 100 + (re ? _toVal(re) : 0))
  )
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+THOUSAND(?:\\s+(?:AND\\s+)?((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, th, re) => String(_toVal(th) * 1000 + (re ? _toVal(re) : 0))
  )
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+HUNDRED(?:\\s+(?:AND\\s+)?((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, hu, re) => String(_toVal(hu) * 100 + (re ? _toVal(re) : 0))
  )
  t = t.replace(
    new RegExp(`\\b(${_T})\\s+(${_O})\\b`, 'g'),
    (_, tens, ones) => String((W[tens] ?? 0) + (W[ones] ?? 0))
  )
  t = t.replace(new RegExp(`\\b(${_T}|${_Te})\\b`, 'g'), (_, w) => String(W[w]))
  t = t.replace(
    new RegExp(`\\b((?:${_D})(?:\\s+(?:${_D}))*)\\b`, 'g'),
    (_, seq) => _toDig(seq)
  )
  t = t.replace(/\bBROKEN\b/g, 'BKN').replace(/\bOVERCAST\b/g, 'OVC').replace(/\bSCATTERED\b/g, 'SCT')
  return t
}

function parseAtis(text: string) {
  const t = normalizeSpoken(text)
  const codeM = t.match(/INFORMATION\s+([A-Z])\b/)
  let wind: { dir: string; spd: number; gust?: number } | null = null
  if (/WINDS?\s+CALM/i.test(t)) {
    wind = { dir: '000', spd: 0 }
  } else {
    const wm = t.match(/WIND[S]?\s+(\d{3})\s+(?:AT|@)\s+(\d+)(?:\s+(?:GUST(?:ING)?|G)\s+(\d+))?/)
      ?? t.match(/(\d{3})\/(\d{2,3})(?:G(\d{2,3}))?KT/)
    if (wm) wind = { dir: wm[1], spd: parseInt(wm[2]), ...(wm[3] ? { gust: parseInt(wm[3]) } : {}) }
  }
  const visM = t.match(/VISIBILITY\s+([\d\/]+)/)
  const skyRe = /\b(FEW|SCT|BKN|OVC)\s+(\d+)/g
  let ceiling: { cover: string; height: number } | null = null
  let m: RegExpExecArray | null
  while ((m = skyRe.exec(t)) !== null) {
    if (m[1] === 'BKN' || m[1] === 'OVC') {
      const raw = parseInt(m[2])
      const h = raw >= 1000 ? raw : raw * 100
      if (!ceiling || h < ceiling.height) ceiling = { cover: m[1], height: h }
    }
  }
  const altM = t.match(/ALTIMETER\s+(\d{4})|A\s*(\d{4})/)
  const altimeter = altM ? (altM[1] ?? altM[2]) : null
  const rwyM = t.match(/LANDING\s+AND\s+DEPARTING\s+(?:RUNWAY\s+)?(\d{1,2}[LRC]?)/)
    ?? t.match(/(?:LANDING|DEPARTING|ARRIVAL|DEPARTURE)S?\s+RUNWAY\s+(\d{1,2}[LRC]?)/)
    ?? t.match(/RUNWAY\s+(\d{1,2}[LRC]?)\s+(?:IN USE|APPROACH|LANDING|DEPARTING)/)
  const tempM = t.match(/TEMPERATURE\s+(\d+)/)
  const dewM  = t.match(/DEW\s*POINT\s+(\d+)|DEWPOINT\s+(\d+)/)
  const timeM = t.match(/TIME\s+(\d{4})\s*(?:ZULU|Z\b)/)
  return {
    code:        codeM?.[1] ?? null,
    time:        timeM ? `${timeM[1]}Z` : null,
    wind,
    visibility:  visM?.[1] ?? null,
    ceiling,
    altimeter,
    runway:      rwyM?.[1] ?? null,
    temperature: tempM ? parseInt(tempM[1]) : null,
    dewpoint:    dewM  ? parseInt(dewM[1] ?? dewM[2]) : null,
    raw:         text,
  }
}

function trimToOneAtisLoop(transcript: string): string {
  let m: RegExpExecArray | null

  // Strategy 1: Tower ATIS — "Information [X]" with time ref in same sentence
  const openPat = /\binformation\s+[a-z]\b[^.!?]*(?:time|\d{4}|zulu)/gi
  const indices: number[] = []
  while ((m = openPat.exec(transcript)) !== null) {
    indices.push(m.index)
    if (indices.length === 2) break
  }
  if (indices.length === 0) {
    const fallback = /\binformation\s+[a-z]\b/gi
    while ((m = fallback.exec(transcript)) !== null) {
      indices.push(m.index)
      if (indices.length === 2) break
    }
  }
  if (indices.length >= 1) {
    const before = transcript.slice(0, indices[0])
    const dot = before.lastIndexOf('. ')
    const start = (dot >= 0 && indices[0] - dot <= 100) ? dot + 2 : indices[0]
    if (indices.length >= 2) return transcript.slice(start, indices[1]).trim()
    return transcript.slice(start).trim()
  }

  // Strategy 2: AWOS/ASOS — "AUTOMATED WEATHER/SURFACE OBSERVATION" is the loop END marker.
  const awosPat = /\bautomated\s+(?:weather|surface)\s+(?:observation|station)\b/gi
  const awosEnds: number[] = []
  while ((m = awosPat.exec(transcript)) !== null) {
    let endPos = m.index + m[0].length
    const tail = transcript.slice(endPos, endPos + 60)
    const zuluM = tail.match(/^[^a-zA-Z]*\d{4}[^a-zA-Z]*\bzulu\b[^.]*\.?/i)
    if (zuluM) endPos += zuluM[0].length
    awosEnds.push(endPos)
    if (awosEnds.length === 2) break
  }
  if (awosEnds.length >= 2) return transcript.slice(awosEnds[0], awosEnds[1]).trim()
  if (awosEnds.length === 1) return transcript.slice(awosEnds[0]).trim()

  return transcript
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data: rows, error } = await supabase
    .from('atis_cache')
    .select('icao, transcription')

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

  const results: string[] = []
  for (const row of rows ?? []) {
    if (!row.transcription) continue
    const transcription = trimToOneAtisLoop(row.transcription)
    const parsed = parseAtis(transcription)
    await supabase.from('atis_cache').update({ transcription, parsed }).eq('icao', row.icao)
    results.push(row.icao)
  }

  return new Response(JSON.stringify({ reprocessed: results }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
