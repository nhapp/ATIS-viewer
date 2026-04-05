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

// Returns true if the cached ATIS is still valid for the current :45 cycle
function isCacheValid(fetchedAt: string): boolean {
  const fetched = new Date(fetchedAt)
  const now = new Date()
  const thisHour45 = new Date(now)
  thisHour45.setMinutes(45, 0, 0)
  const lastUpdate = now >= thisHour45
    ? thisHour45
    : new Date(thisHour45.getTime() - 3_600_000)
  return fetched > lastUpdate
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const { icao, session_id } = await req.json()
  if (!icao) return json({ error: 'icao required' }, 400)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Check cache
  const { data: cache } = await supabase
    .from('atis_cache')
    .select('icao, transcription, parsed, audio_url, fetched_at')
    .eq('icao', icao.toUpperCase())
    .maybeSingle()

  if (cache && isCacheValid(cache.fetched_at)) {
    return json({ status: 'cached', data: cache })
  }

  // 2. Check for already-running job
  const { data: running } = await supabase
    .from('atis_jobs')
    .select('id, status')
    .eq('icao', icao.toUpperCase())
    .in('status', ['pending', 'calling', 'transcribing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (running) {
    return json({ status: running.status, job_id: running.id })
  }

  // 3. Look up ATIS phone number
  const { data: phone } = await supabase
    .from('atis_phones')
    .select('phone_number, type')
    .eq('icao', icao.toUpperCase())
    .maybeSingle()

  if (!phone) {
    return json({ status: 'no_phone', error: 'No ATIS phone number on file for this airport' })
  }

  // 4. Create job
  const { data: job, error: jobErr } = await supabase
    .from('atis_jobs')
    .insert({ icao: icao.toUpperCase(), session_id, status: 'calling' })
    .select()
    .single()

  if (jobErr) return json({ error: jobErr.message }, 500)

  // 5. Initiate Twilio call
  const SID   = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const FROM  = Deno.env.get('TWILIO_FROM_NUMBER')!
  const BASE  = Deno.env.get('SUPABASE_URL')!

  const twimlUrl    = `${BASE}/functions/v1/twiml-record?job_id=${job.id}`
  const webhookUrl  = `${BASE}/functions/v1/twilio-webhook?job_id=${job.id}`

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
    return json({ status: 'error', error: call.message }, 500)
  }

  await supabase.from('atis_jobs').update({ call_sid: call.sid }).eq('id', job.id)

  return json({ status: 'calling', job_id: job.id, station_type: phone.type })
})
