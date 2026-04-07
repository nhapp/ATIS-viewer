import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// Type-aware cache validity:
//   AWOS/ASOS  → 60-minute rolling TTL (continuous weather sensor)
//   ATIS       → valid since last :45 mark (hourly broadcast)
function isCacheValid(fetchedAt: string, type: string | null): boolean {
  const fetched = new Date(fetchedAt)
  const now = new Date()
  if (type && type !== 'atis') {
    return (now.getTime() - fetched.getTime()) < 60 * 60 * 1000
  }
  const thisHour45 = new Date(now)
  thisHour45.setMinutes(45, 0, 0)
  const lastUpdate = now >= thisHour45
    ? thisHour45
    : new Date(thisHour45.getTime() - 3_600_000)
  return fetched > lastUpdate
}

// ISO timestamp when the current cache entry will next expire
function nextValidAt(fetchedAt: string, type: string | null): string {
  if (type && type !== 'atis') {
    return new Date(new Date(fetchedAt).getTime() + 60 * 60 * 1000).toISOString()
  }
  const now = new Date()
  const thisHour45 = new Date(now)
  thisHour45.setMinutes(45, 0, 0)
  if (now < thisHour45) return thisHour45.toISOString()
  return new Date(thisHour45.getTime() + 3_600_000).toISOString()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const { icao } = await req.json()
  if (!icao) return json({ error: 'icao required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const icaoUpper = icao.toUpperCase()

  // 1. Look up phone/type first — required for type-aware cache check
  const { data: phone } = await supabase
    .from('atis_phones')
    .select('phone_number, type')
    .eq('icao', icaoUpper)
    .maybeSingle()

  const stationType = phone?.type ?? null

  // 2. Check cache with type-aware TTL
  const { data: cache } = await supabase
    .from('atis_cache')
    .select('icao, transcription, parsed, audio_url, fetched_at')
    .eq('icao', icaoUpper)
    .maybeSingle()

  if (cache && isCacheValid(cache.fetched_at, stationType)) {
    return json({
      status:       'cached',
      station_type: stationType,
      next_valid_at: nextValidAt(cache.fetched_at, stationType),
      data:         cache,
    })
  }

  // 3. Dedup: return existing in-progress job instead of starting another call
  const { data: running } = await supabase
    .from('atis_jobs')
    .select('id, status')
    .eq('icao', icaoUpper)
    .in('status', ['pending', 'calling', 'transcribing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (running) {
    return json({ status: running.status, job_id: running.id, station_type: stationType })
  }

  // 4. No phone on file — cannot make call
  if (!phone) {
    return json({ status: 'no_phone', station_type: null, error: 'No ATIS phone number on file for this airport' })
  }

  // 5. Create job
  const { data: job, error: jobErr } = await supabase
    .from('atis_jobs')
    .insert({ icao: icaoUpper, status: 'calling' })
    .select()
    .single()

  if (jobErr) return json({ error: jobErr.message }, 500)

  // 6. Initiate Twilio call
  const SID   = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const FROM  = Deno.env.get('TWILIO_FROM_NUMBER')!
  const BASE  = Deno.env.get('SUPABASE_URL')!

  const twimlUrl   = `${BASE}/functions/v1/twiml-record?job_id=${job.id}`
  const webhookUrl = `${BASE}/functions/v1/twilio-webhook?job_id=${job.id}`

  const body = new URLSearchParams({
    To:   phone.phone_number,
    From: FROM,
    Url:  twimlUrl,
    StatusCallback:       webhookUrl,
    StatusCallbackMethod: 'POST',
    StatusCallbackEvent:  'completed',
  })

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization:  'Basic ' + btoa(`${SID}:${TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }
  )

  const call = await resp.json()

  if (!resp.ok) {
    await supabase.from('atis_jobs').update({ status: 'error', error_msg: call.message }).eq('id', job.id)
    return json({ status: 'error', station_type: stationType, error: call.message }, 500)
  }

  await supabase.from('atis_jobs').update({ call_sid: call.sid }).eq('id', job.id)

  return json({ status: 'calling', job_id: job.id, station_type: stationType })
})
