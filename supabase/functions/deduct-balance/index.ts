import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const COSTS: Record<string, number> = {
  atis_fetch: 100,  // $1.00
  sms_send:    25,  // $0.25
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { type, icao } = await req.json()
    if (!COSTS[type]) {
      return new Response(JSON.stringify({ error: 'Invalid type' }), { status: 400, headers: CORS })
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const cost = COSTS[type]

    // ATIS fetch: free re-fetch if same airport already charged today
    if (type === 'atis_fetch' && icao) {
      const today = new Date().toISOString().slice(0, 10)
      const { data: existing } = await supabase
        .from('daily_atis_fetches')
        .select('fetch_date')
        .eq('user_id', user.id)
        .eq('icao', icao.toUpperCase())
        .eq('fetch_date', today)
        .maybeSingle()

      if (existing) {
        return new Response(JSON.stringify({ ok: true, charged: false, free: true }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }
    }

    // Atomically deduct — returns null if insufficient funds
    const { data: newBalance } = await supabase.rpc('deduct_balance', {
      p_user_id:     user.id,
      p_amount_cents: cost,
    })

    if (newBalance === null || newBalance === undefined) {
      return new Response(JSON.stringify({ error: 'insufficient_balance' }), { status: 402, headers: CORS })
    }

    // Record daily fetch marker
    if (type === 'atis_fetch' && icao) {
      await supabase.from('daily_atis_fetches').upsert({
        user_id:    user.id,
        icao:       icao.toUpperCase(),
        fetch_date: new Date().toISOString().slice(0, 10),
      }, { onConflict: 'user_id,icao,fetch_date', ignoreDuplicates: true })
    }

    // Ledger entry
    const desc: Record<string, string> = {
      atis_fetch: `ATIS fetch – ${icao?.toUpperCase() ?? ''}`,
      sms_send:   `SMS sent – ${icao?.toUpperCase() ?? ''}`,
    }
    await supabase.from('balance_transactions').insert({
      user_id:     user.id,
      amount_cents: -cost,
      type,
      description: desc[type],
    })

    return new Response(
      JSON.stringify({ ok: true, charged: true, amount_cents: cost, new_balance_cents: newBalance }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS })
  }
})
