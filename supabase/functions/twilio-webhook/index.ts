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
function parseAtis(text: string) {
  const t = text.toUpperCase()

  // ATIS letter code
  const codeM = t.match(/INFORMATION\s+([A-Z])\b/)

  // Wind — handles both "270 AT 10" and "270/10" and "CALM"
  let wind: { dir: string; spd: number; gust?: number } | null = null
  if (/WIND\s+CALM|WINDS?\s+CALM/i.test(t)) {
    wind = { dir: '000', spd: 0 }
  } else {
    const wm = t.match(/WIND[S]?\s+(\d{3})\s+(?:AT|@)\s+(\d+)(?:\s+(?:GUST(?:ING)?|G)\s+(\d+))?/)
      ?? t.match(/(\d{3})\/(\d{2,3})(?:G(\d{2,3}))?KT/)
    if (wm) wind = { dir: wm[1], spd: parseInt(wm[2]), ...(wm[3] ? { gust: parseInt(wm[3]) } : {}) }
  }

  // Visibility
  const visM = t.match(/VISIBILITY\s+([\d\/\s]+?)\s*(?:MILE|SM|$)/)

  // Sky / ceiling — pick lowest BKN or OVC
  const skyRe = /(FEW|SCT|BKN|OVC)\s+(\d{3})/g
  let ceiling: { cover: string; height: number } | null = null
  let m: RegExpExecArray | null
  while ((m = skyRe.exec(t)) !== null) {
    if (m[1] === 'BKN' || m[1] === 'OVC') {
      const h = parseInt(m[2]) * 100
      if (!ceiling || h < ceiling.height) ceiling = { cover: m[1], height: h }
    }
  }

  // Altimeter
  const altM = t.match(/ALTIMETER\s+(\d[\d\s]{3,6})|A\s*(\d{4})/)
  let altimeter: string | null = null
  if (altM) {
    const raw = (altM[1] ?? altM[2]).replace(/\s/g, '')
    altimeter = raw.length === 4 ? raw : null
  }

  // Active runways
  const rwyM = t.match(/(?:LANDING|DEPARTING|ARRIVAL|DEPARTURE)S?\s+RUNWAY\s+([\d]{1,2}[LRC]?)/)
    ?? t.match(/RUNWAY\s+([\d]{1,2}[LRC]?)\s+(?:IN USE|APPROACH|LANDING|DEPARTING)/)

  // Temperature / dewpoint
  const tempM = t.match(/TEMPERATURE\s+(\d+)|TEMP(?:ERATURE)?\s+(\d+)/)
  const dewM  = t.match(/DEW\s*POINT\s+(\d+)|DEWPOINT\s+(\d+)/)

  return {
    code:        codeM?.[1] ?? null,
    wind,
    visibility:  visM?.[1]?.trim() ?? null,
    ceiling,
    altimeter,
    runway:      rwyM?.[1] ?? null,
    temperature: tempM ? parseInt(tempM[1] ?? tempM[2]) : null,
    dewpoint:    dewM  ? parseInt(dewM[1]  ?? dewM[2])  : null,
    raw:         text,
  }
}
