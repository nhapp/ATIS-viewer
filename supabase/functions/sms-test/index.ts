import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { icao, phone } = await req.json()
    if (!icao || !phone) return new Response(JSON.stringify({ error: 'icao and phone required' }), { status: 400, headers: CORS })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: cache } = await supabase
      .from('atis_cache')
      .select('transcription, parsed, fetched_at')
      .eq('icao', icao.toUpperCase())
      .maybeSingle()

    if (!cache) {
      return new Response(JSON.stringify({ error: `No cached ATIS for ${icao}` }), { status: 404, headers: CORS })
    }

    const p = cache.parsed ?? {}

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
    const body = `TripAtis: ${icao.toUpperCase()} | ${info || cache.transcription.slice(0, 140)}`

    await sendSms(phone, body)

    return new Response(JSON.stringify({ ok: true, body }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS })
  }
})

async function sendSms(to: string, body: string): Promise<void> {
  const sid   = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const from  = Deno.env.get('TWILIO_FROM_NUMBER')!
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(`Twilio SMS failed: ${txt}`)
  }
}
