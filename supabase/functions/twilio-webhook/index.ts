import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const url   = new URL(req.url)
  const jobId = url.searchParams.get('job_id')

  const form  = await req.formData()
  const recUrl    = form.get('RecordingUrl')?.toString()
  const recStatus = form.get('RecordingStatus')?.toString()
  const callSid   = form.get('CallSid')?.toString()
  const recDurRaw = form.get('RecordingDuration')?.toString()
  const recordingDuration = recDurRaw ? parseInt(recDurRaw) : null

  // Only process completed recordings
  if (recStatus !== 'completed' || !recUrl) {
    return new Response('ok', { status: 200 })
  }

  // Discard short recordings (silence timeouts, DTMF, pre-ATIS segments).
  // Real ATIS/AWOS is always ≥ 30 s; anything under 15 s is debris.
  if (recordingDuration !== null && recordingDuration < 15) {
    return new Response('ok', { status: 200 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Resolve job
  let job: { id: string; icao: string; status: string; recording_duration_sec: number | null } | null = null
  if (jobId) {
    const { data } = await supabase.from('atis_jobs').select('id, icao, status, recording_duration_sec').eq('id', jobId).maybeSingle()
    job = data
  }
  if (!job && callSid) {
    const { data } = await supabase.from('atis_jobs').select('id, icao, status, recording_duration_sec').eq('call_sid', callSid).maybeSingle()
    job = data
  }
  if (!job) return new Response('job not found', { status: 404 })

  // If job already completed with a longer recording, skip this one.
  // (Twilio can deliver multiple callbacks; we only want the longest recording.)
  if (job.status === 'complete') {
    const prevDur = job.recording_duration_sec ?? 0
    if (recordingDuration === null || recordingDuration <= prevDur) {
      return new Response('ok', { status: 200 })
    }
  }

  await supabase.from('atis_jobs').update({
    status: 'transcribing',
    recording_url: `${recUrl}.mp3`,
    ...(recordingDuration !== null ? { recording_duration_sec: recordingDuration } : {}),
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

    const { text: rawTranscription } = await whisperResp.json()
    const transcription = trimToOneAtisLoop(rawTranscription)
    const parsed = parseAtis(transcription)

    // Upload MP3 to Supabase Storage for playback
    let audioUrl: string | null = null
    try {
      const storagePath = `${job.icao}/${job.id}.mp3`
      await supabase.storage.from('atis-recordings').upload(storagePath, audioBytes, {
        contentType: 'audio/mpeg',
        upsert: true,
      })
      const { data: urlData } = supabase.storage.from('atis-recordings').getPublicUrl(storagePath)
      audioUrl = urlData.publicUrl
    } catch (_) { /* non-fatal — audio playback just won't be available */ }

    // Update cache
    await supabase.from('atis_cache').upsert({
      icao:          job.icao,
      transcription,
      parsed,
      audio_url:     audioUrl,
      fetched_at:    new Date().toISOString(),
    })

    // Complete job
    const completedAt = new Date().toISOString()
    await supabase.from('atis_jobs').update({
      status:       'complete',
      transcription,
      parsed,
      audio_url:    audioUrl,
      completed_at: completedAt,
    }).eq('id', job.id)

    // Dispatch pending SMS alerts for this airport whose notify_after has passed
    try {
      const { data: alerts } = await supabase
        .from('atis_alert_subscriptions')
        .select('id, phone')
        .eq('icao', job.icao)
        .is('sent_at', null)
        .lte('notify_after', completedAt)
      if (alerts?.length) {
        const p = parsed
        // Wind string with headwind/crosswind components when runway is known
        let windStr: string | null = null
        if (p.wind) {
          if (p.wind.spd === 0) {
            windStr = 'WIND CALM'
          } else {
            windStr = `WIND ${p.wind.dir}@${p.wind.spd}KT${p.wind.gust ? ` G${p.wind.gust}` : ''}`
            if (p.runway && p.wind.dir !== 'VRB') {
              const rwyHdg = parseInt(p.runway) * 10
              const angle  = (parseInt(p.wind.dir) - rwyHdg) * Math.PI / 180
              const hw = Math.round(p.wind.spd * Math.cos(angle))
              const xw = Math.round(Math.abs(p.wind.spd * Math.sin(angle)))
              const hwLabel = hw >= 0 ? `Headwind ${hw}` : `Tailwind ${Math.abs(hw)}`
              windStr += ` (${hwLabel}/X-wind ${xw}KT)`
            }
          }
        }
        const fields = [
          p.code       ? `ATIS ${p.code}` : null,
          p.runway     ? `RWY ${p.runway}` : null,
          windStr,
          p.visibility ? `VIS ${p.visibility}SM` : null,
          p.ceiling    ? `${p.ceiling.cover} ${p.ceiling.height}FT` : null,
          p.altimeter  ? `ALT A${p.altimeter}` : null,
        ].filter(Boolean)
        const info = fields.join(' | ')
        const body = `TripAtis: ${job.icao} | ${info || transcription.slice(0, 140)}`
        await Promise.all(alerts.map(async (alert) => {
          await sendSms(alert.phone, body)
          await supabase.from('atis_alert_subscriptions')
            .update({ sent_at: completedAt, atis_code: p.code ?? null })
            .eq('id', alert.id)
        }))
      }
    } catch (_) { /* non-fatal — ATIS was stored successfully */ }

  } catch (err) {
    await supabase.from('atis_jobs').update({
      status:       'error',
      error_msg:    (err as Error).message,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id)
  }

  return new Response('ok', { status: 200 })
})

// ── Twilio SMS ────────────────────────────────────────────────────────────────

async function sendSms(to: string, body: string): Promise<void> {
  const sid  = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const from  = Deno.env.get('TWILIO_FROM_NUMBER')!
  if (!from) return // SMS not configured
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
}

// ── ATIS loop trimmer ─────────────────────────────────────────────────────────
//
// ATIS is a continuous loop. We start recording mid-loop, so the transcript
// typically contains a partial tail, then one complete loop, then the start of
// the next loop. The loop boundary is marked by "Information [Letter]" at both
// the beginning and end of each cycle.
//
// Strategy: find the first and second occurrence of "Information [X]".
//   - 2 found → keep exactly [first, second) — one complete loop
//   - 1 found → start from first marker to end — at least one complete loop
//   - 0 found → keep everything (AWOS/non-standard format)

// Phonetic alphabet words Whisper may spell out instead of single letters
const PHONETIC_WORDS = 'alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|x-ray|xray|yankee|zulu'
const INFO_PAT = new RegExp(`\\binformation\\s+(?:[a-z]\\b|(?:${PHONETIC_WORDS})\\b)`, 'gi')
const INFO_PAT_TIME = new RegExp(`\\binformation\\s+(?:[a-z]\\b|(?:${PHONETIC_WORDS})\\b)[^.!?]*(?:time|\\d{4})`, 'gi')

function trimToOneAtisLoop(transcript: string): string {
  let m: RegExpExecArray | null

  // Strategy 1: Tower ATIS — "Information [X/Foxtrot]" with time ref in same sentence.
  // Extend start backward to include airport name preceding the marker.
  const indices: number[] = []
  INFO_PAT_TIME.lastIndex = 0
  while ((m = INFO_PAT_TIME.exec(transcript)) !== null) {
    indices.push(m.index)
    if (indices.length === 2) break
  }
  if (indices.length === 0) {
    INFO_PAT.lastIndex = 0
    while ((m = INFO_PAT.exec(transcript)) !== null) {
      indices.push(m.index)
      if (indices.length === 2) break
    }
  }
  if (indices.length >= 1) {
    // Look back up to 100 chars for the start of this sentence (after last ". ")
    // so we include the airport name that precedes "Information [X]".
    const before = transcript.slice(0, indices[0])
    const dot = before.lastIndexOf('. ')
    const start = (dot >= 0 && indices[0] - dot <= 100) ? dot + 2 : indices[0]
    if (indices.length >= 2) return transcript.slice(start, indices[1]).trim()
    return transcript.slice(start).trim()
  }

  // Strategy 2: AWOS/ASOS — "AUTOMATED WEATHER/SURFACE OBSERVATION" is the loop END marker.
  // Find two occurrences; the content between them is exactly one loop.
  const awosPat = /\bautomated\s+(?:weather|surface)\s+(?:observation|station)\b/gi
  const awosEnds: number[] = []
  while ((m = awosPat.exec(transcript)) !== null) {
    let endPos = m.index + m[0].length
    // Consume trailing time reference: ". 0359. ZULU." or "0359 ZULU"
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

// ── ATIS text parser ──────────────────────────────────────────────────────────

const PHONETIC: Record<string, string> = {
  ALPHA:'A', BRAVO:'B', CHARLIE:'C', DELTA:'D', ECHO:'E', FOXTROT:'F',
  GOLF:'G', HOTEL:'H', INDIA:'I', JULIET:'J', KILO:'K', LIMA:'L',
  MIKE:'M', NOVEMBER:'N', OSCAR:'O', PAPA:'P', QUEBEC:'Q', ROMEO:'R',
  SIERRA:'S', TANGO:'T', UNIFORM:'U', VICTOR:'V', WHISKEY:'W', XRAY:'X',
  YANKEE:'Y', ZULU:'Z',
}

// Number word → numeric value
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

  // Phonetic alphabet after INFORMATION → single letter
  t = t.replace(
    /\bINFORMATION\s+(ALPHA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIET|KILO|LIMA|MIKE|NOVEMBER|OSCAR|PAPA|QUEBEC|ROMEO|SIERRA|TANGO|UNIFORM|VICTOR|WHISKEY|XRAY|YANKEE|ZULU)\b/g,
    (_, w) => `INFORMATION ${PHONETIC[w]}`
  )

  // 1. Decimal point: digit-seq POINT digit-seq → "X.Y"  ("one two one point three" → "121.3")
  t = t.replace(
    new RegExp(`\\b((?:${_D})(?:\\s+(?:${_D}))*)\\s+POINT\\s+((?:${_D})(?:\\s+(?:${_D}))*)\\b`, 'g'),
    (_, l, r) => `${_toDig(l)}.${_toDig(r)}`
  )

  // 2. N THOUSAND N HUNDRED [AND N] → integer  ("two thousand five hundred" → 2500)
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+THOUSAND\\s+((?:${_A})(?:\\s+(?:${_A}))*?)\\s+HUNDRED(?:\\s+AND\\s+((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, th, hu, re) => String(_toVal(th) * 1000 + _toVal(hu) * 100 + (re ? _toVal(re) : 0))
  )

  // 3. N THOUSAND [AND N] → integer  ("two thousand" → 2000, "one thousand and five" → 1005)
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+THOUSAND(?:\\s+(?:AND\\s+)?((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, th, re) => String(_toVal(th) * 1000 + (re ? _toVal(re) : 0))
  )

  // 4. N HUNDRED [AND N] → integer  ("twenty five hundred" → 2500, "two hundred" → 200)
  t = t.replace(
    new RegExp(`\\b((?:${_A})(?:\\s+(?:${_A}))*?)\\s+HUNDRED(?:\\s+(?:AND\\s+)?((?:${_A})(?:\\s+(?:${_A}))*?))?\\b`, 'g'),
    (_, hu, re) => String(_toVal(hu) * 100 + (re ? _toVal(re) : 0))
  )

  // 5. TENS + ONES → numeral  ("twenty five" → "25")
  t = t.replace(
    new RegExp(`\\b(${_T})\\s+(${_O})\\b`, 'g'),
    (_, tens, ones) => String((W[tens] ?? 0) + (W[ones] ?? 0))
  )

  // 6. Single TENS or TEEN → numeral  ("twenty" → "20", "eleven" → "11")
  t = t.replace(new RegExp(`\\b(${_T}|${_Te})\\b`, 'g'), (_, w) => String(W[w]))

  // 7. Pure digit sequences → digit-by-digit  ("two eight zero" → "280")
  t = t.replace(
    new RegExp(`\\b((?:${_D})(?:\\s+(?:${_D}))*)\\b`, 'g'),
    (_, seq) => _toDig(seq)
  )

  // Sky-condition abbreviations
  t = t.replace(/\bBROKEN\b/g, 'BKN').replace(/\bOVERCAST\b/g, 'OVC').replace(/\bSCATTERED\b/g, 'SCT')

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
  const rwyM = t.match(/LANDING\s+AND\s+DEPARTING\s+(?:RUNWAY\s+)?(\d{1,2}[LRC]?)/)
    ?? t.match(/(?:LANDING|DEPARTING|ARRIVAL|DEPARTURE)S?\s+RUNWAY\s+(\d{1,2}[LRC]?)/)
    ?? t.match(/RUNWAY\s+(\d{1,2}[LRC]?)\s+(?:IN USE|APPROACH|LANDING|DEPARTING)/)

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
