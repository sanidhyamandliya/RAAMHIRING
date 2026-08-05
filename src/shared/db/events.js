import { supabase } from '../supabase.js';

const ICO = {
  registered: '📝',
  round_start: '▶️',
  round_completed: '✅',
  completed: '🏆',
  violation: '⚠️',
  terminated: '🚫',
  hired: '🎉',
};

export async function pushEvent(payload) {
  const type = payload.type || 'unknown';
  const row = {
    type,
    candidate_email: payload.candidateEmail || payload.email || null,
    candidate_name:
      payload.candidateName ||
      [payload.fname, payload.lname].filter(Boolean).join(' ').trim() ||
      null,
    device_id: payload.deviceId || null,
    round_index:
      payload.roundJustCompleted != null
        ? Number(payload.roundJustCompleted) - 1
        : payload.round != null
          ? Number(payload.round) - 1
          : null,
    round_name: payload.roundName || null,
    round_score: payload.roundScore != null ? Number(payload.roundScore) : null,
    reason: payload.reason || null,
    violation_count: payload.count != null ? Number(payload.count) : null,
    meta: {
      prog: payload.prog,
      progKey: payload.progKey,
      college: payload.college,
      status: payload.status,
      completedRounds: payload.completedRounds,
      scores: payload.scores,
      ico: payload.ico || ICO[type] || '•',
      time:
        payload.time ||
        new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    },
  };

  const { data, error } = await supabase.from('events').insert(row).select('*').single();
  if (error) throw error;
  return toUiEvent(data);
}

export function toUiEvent(row) {
  if (!row) return null;
  const meta = row.meta || {};
  return {
    type: row.type,
    candidateEmail: row.candidate_email,
    candidateName: row.candidate_name,
    email: row.candidate_email,
    deviceId: row.device_id,
    round: row.round_index != null ? row.round_index + 1 : undefined,
    roundJustCompleted: row.round_index != null ? row.round_index + 1 : undefined,
    roundName: row.round_name,
    roundScore: row.round_score,
    reason: row.reason,
    count: row.violation_count,
    ico: meta.ico || ICO[row.type] || '•',
    time:
      meta.time ||
      new Date(row.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    _ts: Date.parse(row.created_at),
    timestamp: row.created_at,
    prog: meta.prog,
    progKey: meta.progKey,
    college: meta.college,
    status: meta.status,
    completedRounds: meta.completedRounds,
    scores: meta.scores,
    fname: undefined,
    lname: undefined,
  };
}

export async function listEvents(limit = 400) {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse().map(toUiEvent);
}

export function subscribeEvents(onInsert) {
  const channel = supabase
    .channel('events_rt')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (payload) => {
      onInsert(toUiEvent(payload.new));
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}
