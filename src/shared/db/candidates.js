import { supabase, toUiCandidate, fromUiCandidate } from './mappers.js';

// Supabase/PostgREST caps a single response at 1000 rows by default. With enough
// candidates each having up to 6 score rows, candidate_scores can exceed that —
// fetch in pages so no candidate's scores get silently dropped off the end.
const PAGE_SIZE = 1000;
async function fetchAllRows(builder) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await builder().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

async function fetchScoresMap(candidateIds) {
  if (!candidateIds.length) return {};
  const data = await fetchAllRows(() =>
    supabase.from('candidate_scores').select('candidate_id, round_index, score').in('candidate_id', candidateIds)
  );
  const map = {};
  data.forEach((r) => {
    (map[r.candidate_id] ||= []).push(r);
  });
  return map;
}

export async function getCandidates({ includeDeleted = false } = {}) {
  const rows = await fetchAllRows(() => {
    let q = supabase.from('candidates').select('*').order('updated_at', { ascending: false });
    if (!includeDeleted) q = q.is('deleted_at', null);
    return q;
  });
  const scoresMap = await fetchScoresMap(rows.map((r) => r.id));
  return rows.map((r) => toUiCandidate(r, scoresMap[r.id] || []));
}

export async function getCandidateByEmail(email) {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('email', (email || '').toLowerCase().trim())
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const scoresMap = await fetchScoresMap([data.id]);
  return toUiCandidate(data, scoresMap[data.id] || []);
}

/** Upsert candidate core fields (does not write event decorations). */
export async function upsertCandidate(ui) {
  const row = fromUiCandidate(ui);
  if (!row.email) throw new Error('email required');
  // Don't overwrite hire/hr on assessment upserts unless provided
  const payload = { ...row, updated_at: new Date().toISOString() };
  if (ui.hired !== undefined) payload.hired = !!ui.hired;
  if (ui.hrStatus !== undefined) payload.hr_status = ui.hrStatus;
  if (ui.hiredAt !== undefined) payload.hired_at = ui.hiredAt;
  if (ui.hiredBy !== undefined) payload.hired_by = ui.hiredBy;
  if (ui.certId !== undefined) payload.cert_id = ui.certId;

  const { data, error } = await supabase
    .from('candidates')
    .upsert(payload, { onConflict: 'email' })
    .select('*')
    .single();
  if (error) throw error;

  if (Array.isArray(ui.scores) && ui.scores.length) {
    await replaceScores(data.id, ui.scores);
  }
  const scoresMap = await fetchScoresMap([data.id]);
  return toUiCandidate(data, scoresMap[data.id] || []);
}

export async function replaceScores(candidateId, scoresArr) {
  const rows = (scoresArr || [])
    .map((score, round_index) =>
      typeof score === 'number' && !Number.isNaN(score)
        ? { candidate_id: candidateId, round_index, score: Math.round(score), updated_at: new Date().toISOString() }
        : null
    )
    .filter(Boolean);
  if (!rows.length) return;
  const { error } = await supabase.from('candidate_scores').upsert(rows, {
    onConflict: 'candidate_id,round_index',
  });
  if (error) throw error;
}

export async function upsertScore(candidateId, roundIndex, score) {
  const { error } = await supabase.from('candidate_scores').upsert(
    {
      candidate_id: candidateId,
      round_index: roundIndex,
      score: Math.round(score),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'candidate_id,round_index' }
  );
  if (error) throw error;
}

export async function setHrStatus(email, hrStatus) {
  const { error } = await supabase
    .from('candidates')
    .update({ hr_status: hrStatus, updated_at: new Date().toISOString() })
    .eq('email', email.toLowerCase().trim());
  if (error) throw error;
}

export async function hireCandidate(email, hiredBy) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('candidates')
    .update({
      hired: true,
      hr_status: 'hired',
      hired_at: now,
      hired_by: hiredBy || 'HR',
      updated_at: now,
    })
    .eq('email', email.toLowerCase().trim());
  if (error) throw error;
}

export async function softDeleteCandidate(email, deletedBy) {
  const { error } = await supabase
    .from('candidates')
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: deletedBy || 'HR',
      updated_at: new Date().toISOString(),
    })
    .eq('email', email.toLowerCase().trim());
  if (error) throw error;
}

export async function setFeedback(email, rating, feedback) {
  const { error } = await supabase
    .from('candidates')
    .update({
      rating: rating ?? null,
      feedback: feedback || '',
      updated_at: new Date().toISOString(),
    })
    .eq('email', (email || '').toLowerCase().trim());
  if (error) throw error;
}

export async function setCertId(email, certId) {
  const { error } = await supabase
    .from('candidates')
    .update({ cert_id: certId, updated_at: new Date().toISOString() })
    .eq('email', email.toLowerCase().trim());
  if (error) throw error;
}

export function subscribeCandidates(onChange) {
  const channel = supabase
    .channel('candidates_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates' }, () => onChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'candidate_scores' }, () => onChange())
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}
