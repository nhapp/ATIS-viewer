import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature') ?? ''
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

  let event: any
  try {
    event = await verifyStripeWebhook(body, sig, secret)
  } catch (err) {
    return new Response(`Webhook error: ${(err as Error).message}`, { status: 400 })
  }

  if (event.type !== 'payment_intent.succeeded') {
    return new Response('ok', { status: 200 })
  }

  const pi          = event.data.object
  const userId      = pi.metadata?.user_id
  const amountCents = parseInt(pi.metadata?.amount_cents ?? pi.amount)

  if (!userId || !amountCents) return new Response('ok', { status: 200 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  await supabase.rpc('credit_balance', { p_user_id: userId, p_amount_cents: amountCents })

  await supabase.from('balance_transactions').insert({
    user_id:     userId,
    amount_cents: amountCents,
    type:        'topup',
    description: `Top-up $${(amountCents / 100).toFixed(2)} via credit card`,
  })

  return new Response('ok', { status: 200 })
})

async function verifyStripeWebhook(payload: string, sig: string, secret: string): Promise<any> {
  const parts: Record<string, string> = {}
  for (const part of sig.split(',')) {
    const [k, v] = part.split('=')
    parts[k] = v
  }
  const { t, v1 } = parts as any
  if (!t || !v1) throw new Error('Invalid signature header')

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(t)) > 300) throw new Error('Timestamp out of tolerance')

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
  if (expected !== v1) throw new Error('Signature mismatch')

  return JSON.parse(payload)
}
