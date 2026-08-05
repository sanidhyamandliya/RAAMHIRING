import { supabase } from '../supabase.js';

export async function listBlockedDevices() {
  const { data, error } = await supabase.from('blocked_devices').select('*');
  if (error) throw error;
  return data || [];
}

export async function listBlockedEmails() {
  const { data, error } = await supabase.from('blocked_emails').select('*');
  if (error) throw error;
  return data || [];
}

export async function isDeviceBlocked(deviceId) {
  const { data, error } = await supabase
    .from('blocked_devices')
    .select('device_id')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function isEmailBlocked(email) {
  const { data, error } = await supabase
    .from('blocked_emails')
    .select('email')
    .eq('email', (email || '').toLowerCase().trim())
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function blockDevice(deviceId, email, reason = 'termination') {
  const { error } = await supabase.from('blocked_devices').upsert({
    device_id: deviceId,
    email: email || '',
    reason,
    blocked_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function blockEmail(email, deviceId = null, reason = 'termination') {
  const { error } = await supabase.from('blocked_emails').upsert({
    email: (email || '').toLowerCase().trim(),
    device_id: deviceId,
    reason,
    blocked_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function unblockDevice(deviceId) {
  const { error } = await supabase.from('blocked_devices').delete().eq('device_id', deviceId);
  if (error) throw error;
}

export async function unblockEmail(email) {
  const { error } = await supabase
    .from('blocked_emails')
    .delete()
    .eq('email', (email || '').toLowerCase().trim());
  if (error) throw error;
}

export function subscribeBlocks(onChange) {
  const channel = supabase
    .channel('blocks_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_devices' }, () => onChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_emails' }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
