import { supabase } from './supabase.js';

/**
 * Invokes the `send-email` Supabase Edge Function.
 * type: 'confirmation' | 'invite' | 'offer' — each renders its own template server-side.
 */
export async function sendMail(type, payload) {
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: { type, ...payload },
  });
  if (error) throw error;
  return data;
}
