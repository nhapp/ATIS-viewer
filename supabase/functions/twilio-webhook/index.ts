import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const url   = new URL(req.url)
  const jobId = url.searchParams.get('job_id')

  const form  = await req.formData()
  const recUrl    = form.get('RecordingUrl')?.toString()
  const recStatus = form.get('RecordingStatus')?.toString()
  const callSid   = form.get('CallSid')?.toString()

  // Only process completed recordings
  if (recStatus !== 'completed' || !recUrl) {
    return new Response('ok', { status: 200 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Resolve job
  let job: { id: string; icao: string } | null = null
  if (jobId) {
    const { data } = await supabase.from('atis_jobs').select('id, icao').eq('id', jobId).maybeSingle()
    job = data
  }
  if (!job && callSid) {
    const { data } = await supabase.from('atis_jobs').select('id, icao').eq('call_sid', callSid).maybeSingle()
    job = data
  }
  if (!job) return new Response('job not found', { status: 404 })

  await supabase.from('atis_jobs').update({
    status: 'transcribing',
    recording_url: `${recUrl}.mp3`,
  }).eq('id', job.id)

  try {
    // Download MP3 from Twilio
    const SID   = Deno.env.get('TWILIO_ACCOUNT_SID')!
    const TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!

    const audioResp = await fetch(`${recUrl}.mp3`, {
      headers: { Authorization: 'Basic ' + btoa(`${SID}:${TOKEN}`) },
    })
    if (!audioResp.ok) throw new Error(`Twilio audio download failed: ${audioResp.status}`)
    const audioBytes = await audioResp.arrayBuffer()

    // Transcribe with OpenAI Whisper
    const fd = new FormData()
    fd.append('file', new Blob([audioBytes], { type: 'audio/mpeg' }), 'atis.mp3')
    fd.append('model', 'whisper-1')
    fd.append('language', 'en')
    // Aviation vocabulary prompt improves accuracy for runway/wind/altimeter terminology
    fd.append('prompt',
      'ATIS information. Runway, wind, altimeter, ceiling, visibility, temperature, dewpoint. ' +
      'ILS, localizer, NOTAM, taxiway. Knots, feet, statute miles. ' +
      'Information Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike. ' +
      'Winds calm. Wind shear. VFR IFR MVFR. Altimeter two niner niner two.'
    )

    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}` },
      body: fd,
    })
    if (!whisperResp.ok) {
      const err = await whisperResp.text()
      throw new Error(`Whisper failed: ${err}`)
    }

    const { text: transcription } = await whisperResp.json()
    const parsed = parseAtis(transcription)

    // Update cache
    await supabase.from('atis_cache').upsert({
      icao:          job.icao,
      transcription,
      parsed,
      fetched_at:    new Date().toISOString(),
    })

    // Complete job
    await supabase.from('atis_jobs').update({
      status:       'complete',
      transcription,
      parsed,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id)

  } catch (err) {
    await supabase.from('atis_jobs').update({
      status:    'error',
      error_msg: (err as Error).message,
    }).eq('id', job.id)
  }

  return new Response('ok', { status: 200 })
})

// ── ATIS text parser ──────────────────────────────────────────────────────────

// Whisper transcribes numbers as spoken words ("two eight zero").
// Convert spoken digit sequences back to numerals before regex parsing.
const DIGIT_WORDS: Record<string, string> = {
  ZERO:'0', ONE:'1', TWO:'2', THREE:'3', FOUR:'4',
  FIVE:'5', SIX:'6', SEVEN:'7', EIGHT:'8', NINER:'9', NINE:'9',
}
const PHONETIC: Record<string, string> = {
  ALPHA:'A', BRAVO:'B', CHARLIE:'C', DELTA:'D', ECHO:'E', FOXTROT:'F',
  GOLF:'G', HOTEL:'H', INDIA:'I', JULIET:'J', KILO:'K', LIMA:'L',
  MIKE:'M', NOVEMBER:'N', OSCAR:'O', PAPA:'P', QUEBEC:'Q', ROMEO:'R',
  SIERRA:'S', TANGO:'T', UNIFORM:'U', VICTOR:'V', WHISKEY:'W', XRAY:'X',
  YANKEE:'Y', ZULU:'Z',
}

function normalizeSpoken(raw: string): string {
  let t = raw.toUpperCase()

  // Phonetic alphabet after INFORMATION → single letter
  t = t.replace(
    /\bINFORMATION\s+(ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIET|KILO|LIMA|MIKE|NOVEMBER|OSCAR|PAPA|QUEBEC|ROMEO|SIERRA|TANGO|UNIFORM|VICTOR|WHISKEY|XRAY|YANKEE|ZULU)\b/g,
    (_, w) => `INFORMATION ${PHONETIC[w]}`
  )

  // Digit-word sequences optionally ending in THOUSAND → numerals
  // e.g. "TWO EIGHT ZERO" → "280", "ONE EIGHT THOUSAND" → "18000"
  const dPat = '(?:ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINER|NINE)'
  const seqRe = new RegExp(`\\b(${dPat}(?:\\s+${dPat})*)(?:\\s+THOUSAND)?\\b`, 'g')
  t = t.replace(seqRe, (match) => {
    const hasThousand = match.endsWith('THOUSAND')
    const words = match.replace(/\s*THOUSAND$/, '').trim().split(/\s+/)
    const digits = words.map(w => DIGIT_WORDS[w] ?? w).join('')
    return hasThousand ? String(parseInt(digits) * 1000) : digits
  })

  // Expand sky-condition full words to METAR abbreviations
  t = t.replace(/\bBROKEN\b/g, 'BKN').replace(/\bOVERCAST\b/g, 'OVC')
       .replace(/\bSCATTERED\b/g, 'SCT').replace(/\bFEW\b/g, 'FEW')

  return t
}

function parseAtis(text: string) {
  const t = normalizeSpoken(text)

  // ATIS letter code
  const codeM = t.match(/INFORMATION\s+([A-Z])\b/)

  // Wind — handles "280 AT 11", "280/11KT", and CALM
  let wind: { dir: string; spd: number; gust?: number } | null = null
  if (/WINDS?\s+CALM/i.test(t)) {
    wind = { dir: '000', spd: 0 }
  } else {
    const wm = t.match(/WIND[S]?\s+(\d{3})\s+(?:AT|@)\s+(\d+)(?:\s+(?:GUST(?:ING)?|G)\s+(\d+))?/)
      ?? t.match(/(\d{3})\/(\d{2,3})(?:G(\d{2,3}))?KT/)
    if (wm) wind = { dir: wm[1], spd: parseInt(wm[2]), ...(wm[3] ? { gust: parseInt(wm[3]) } : {}) }
  }

  // Visibility
  const visM = t.match(/VISIBILITY\s+([\d\/]+)/)

  // Sky / ceiling — handles both METAR codes (BKN 020) and spoken feet (BKN 20000)
  const skyRe = /\b(FEW|SCT|BKN|OVC)\s+(\d+)/g
  let ceiling: { cover: string; height: number } | null = null
  let m: RegExpExecArray | null
  while ((m = skyRe.exec(t)) !== null) {
    if (m[1] === 'BKN' || m[1] === 'OVC') {
      const raw = parseInt(m[2])
      const h = raw >= 1000 ? raw : raw * 100   // spoken = feet; METAR = hundreds
      if (!ceiling || h < ceiling.height) ceiling = { cover: m[1], height: h }
    }
  }

  // Altimeter
  const altM = t.match(/ALTIMETER\s+(\d{4})|A\s*(\d{4})/)
  const altimeter = altM ? (altM[1] ?? altM[2]) : null

  // Active runways
  const rwyM = t.match(/(?:LANDING|DEPARTING|ARRIVAL|DEPARTURE)S?\s+RUNWAY\s+([\d]{1,2}[LRC]?)/)
    ?? t.match(/RUNWAY\s+([\d]{1,2}[LRC]?)\s+(?:IN USE|APPROACH|LANDING|DEPARTING)/)

  // Temperature / dewpoint
  const tempM = t.match(/TEMPERATURE\s+(\d+)/)
  const dewM  = t.match(/DEW\s*POINT\s+(\d+)|DEWPOINT\s+(\d+)/)

  // ATIS time e.g. "TIME 0247 ZULU" → "0247Z"
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
