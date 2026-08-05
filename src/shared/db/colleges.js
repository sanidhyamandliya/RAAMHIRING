import { supabase } from '../supabase.js';

export function toUiCollege(row) {
  if (!row) return null;
  return {
    name: row.name,
    open: !!row.open,
    ended: !!row.ended,
    startTime: row.start_time || 0,
    expireTime: row.expire_time || 0,
    endedAt: row.ended_at || null,
    accent: row.accent || '#d4a843',
    welcome: row.welcome || '',
    landTitle: row.land_title || '',
    landEyebrow: row.land_eyebrow || '',
    createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
    createdBy: row.created_by || '',
  };
}

export function fromUiCollege(ui, id) {
  return {
    id,
    name: ui.name || '',
    open: !!ui.open,
    ended: !!ui.ended,
    start_time: ui.startTime || 0,
    expire_time: ui.expireTime || 0,
    ended_at: ui.endedAt || null,
    accent: ui.accent || '#d4a843',
    welcome: ui.welcome || '',
    land_title: ui.landTitle || null,
    land_eyebrow: ui.landEyebrow || null,
    created_by: ui.createdBy || '',
  };
}

export async function listColleges() {
  const { data, error } = await supabase.from('colleges').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  const out = {};
  (data || []).forEach((r) => {
    out[r.id] = toUiCollege(r);
  });
  return out;
}

export async function getCollege(id) {
  const { data, error } = await supabase.from('colleges').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return toUiCollege(data);
}

export async function upsertCollege(id, ui) {
  const row = fromUiCollege(ui, id);
  const { data, error } = await supabase.from('colleges').upsert(row).select('*').single();
  if (error) throw error;
  return toUiCollege(data);
}

export async function patchCollege(id, patch) {
  const row = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.open !== undefined) row.open = patch.open;
  if (patch.ended !== undefined) row.ended = patch.ended;
  if (patch.startTime !== undefined) row.start_time = patch.startTime;
  if (patch.expireTime !== undefined) row.expire_time = patch.expireTime;
  if (patch.endedAt !== undefined) row.ended_at = patch.endedAt;
  if (patch.accent !== undefined) row.accent = patch.accent;
  if (patch.welcome !== undefined) row.welcome = patch.welcome;
  if (patch.landTitle !== undefined) row.land_title = patch.landTitle;
  if (patch.landEyebrow !== undefined) row.land_eyebrow = patch.landEyebrow;
  const { data, error } = await supabase.from('colleges').update(row).eq('id', id).select('*').single();
  if (error) throw error;
  return toUiCollege(data);
}

export async function deleteCollege(id) {
  const { error } = await supabase.from('colleges').delete().eq('id', id);
  if (error) throw error;
}

export function subscribeColleges(onChange) {
  const channel = supabase
    .channel('colleges_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'colleges' }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
