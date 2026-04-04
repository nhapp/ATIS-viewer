import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

// Returns TwiML that records the ATIS audio and calls back when done
serve(async (req) => {
  const url    = new URL(req.url)
  const jobId  = url.searchParams.get('job_id') ?? ''
  const base   = Deno.env.get('SUPABASE_URL')!
  const cbUrl  = `${base}/functions/v1/twilio-webhook?job_id=${jobId}`

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record
    maxLength="240"
    timeout="6"
    trim="trim-silence"
    recordingStatusCallback="${cbUrl}"
    recordingStatusCallbackMethod="POST"
    recordingStatusCallbackEvent="completed"
  />
  <Hangup/>
</Response>`

  return new Response(twiml, {
    headers: { 'Content-Type': 'text/xml' },
  })
})
