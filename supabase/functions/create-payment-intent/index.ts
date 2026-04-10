import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { amount_cents } = await req.json()
    if (!amount_cents || amount_cents < 500) {
      return new Response(JSON.stringify({ error: 'Minimum top-up is $5.00' }), { status: 400, headers: CORS })
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

    const params = new URLSearchParams({
      amount:                   String(amount_cents),
      currency:                 'usd',
      'metadata[user_id]':      user.id,
      'metadata[amount_cents]': String(amount_cents),
    })

    const resp = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: params,
    })
    const pi = await resp.json()
    if (!resp.ok) throw new Error(pi.error?.message || 'Stripe error')

    return new Response(JSON.stringify({ client_secret: pi.client_secret }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS })
  }
})
