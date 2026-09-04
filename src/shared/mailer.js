import { supabase } from './supabase.js';

/**
 * Invokes the `send-email` Supabase Edge Function.
 * type: 'confirmation' | 'invite' | 'offer' — each renders its own template server-side.
 */
export async function sendMail(type, payload) {
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: { type, ...payload },
  });
  if (error) {
    // supabase-js only gives a generic "non-2xx status code" message here — the
    // actual reason (e.g. "RESEND_API_KEY not configured", a Resend rejection)
    // is in the raw response body on error.context. Unwrap it so failures are
    // actually diagnosable instead of silently generic.
    let reason = error.message;
    if (error.context && typeof error.context.json === 'function') {
      try {
        const body = await error.context.json();
        if (body && body.error) reason = body.error;
      } catch { /* body wasn't JSON */ }
    }
    throw new Error(reason);
  }
  return data;
}
