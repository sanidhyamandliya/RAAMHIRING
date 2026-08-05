import { supabase } from '../supabase.js';

/** Map DB candidate row + scores[] → UI shape used by dashboard/assessment. */
export function toUiCandidate(row, scores = []) {
  if (!row) return null;
  const scoreArr = Array.isArray(scores)
    ? scores
    : [];
  // Build dense scores array from {round_index, score} rows
  let scoresList = [];
  if (scoreArr.length && typeof scoreArr[0] === 'object') {
    const max = Math.max(5, ...scoreArr.map((s) => s.round_index));
    scoresList = Array.from({ length: max + 1 }, () => null);
    scoreArr.forEach((s) => {
      scoresList[s.round_index] = s.score;
    });
    scoresList = scoresList.filter((v, i) => v != null || i < (row.completed_rounds || 0));
    // Prefer contiguous completed scores in order 0..n-1
    scoresList = [];
    for (let i = 0; i < 6; i++) {
      const hit = scoreArr.find((s) => s.round_index === i);
      if (hit) scoresList.push(hit.score);
    }
  } else {
    scoresList = scoreArr;
  }

  return {
    id: row.id,
    email: row.email,
    fname: row.fname || '',
    lname: row.lname || '',
    phone: row.phone || '',
    college: row.college || '',
    collegeId: row.college_id || '',
    passYear: row.pass_year || '',
    deg: row.deg || '',
    prog: row.prog || '',
    progKey: row.prog_key || '',
    status: row.status || 'in_progress',
    completedRounds: row.completed_rounds || 0,
    violations: row.violations || 0,
    registeredAt: row.registered_at || '',
    submittedAt: row.submitted_at || null,
    deviceId: row.device_id || '',
    certId: row.cert_id || null,
    hrStatus: row.hr_status || null,
    hired: !!row.hired,
    hiredAt: row.hired_at || null,
    hiredBy: row.hired_by || null,
    rating: row.rating ?? null,
    feedback: row.feedback || '',
    scores: scoresList,
    _updated: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
    _created: row.created_at ? Date.parse(row.created_at) : Date.now(),
  };
}

export function fromUiCandidate(ui) {
  return {
    email: (ui.email || '').toLowerCase().trim(),
    fname: ui.fname || '',
    lname: ui.lname || '',
    phone: ui.phone || '',
    college: ui.college || '',
    college_id: ui.collegeId ? ui.collegeId : null,
    pass_year: ui.passYear || '',
    deg: ui.deg || '',
    prog: ui.prog || '',
    prog_key: ui.progKey || '',
    status: ui.status || 'in_progress',
    completed_rounds: ui.completedRounds || 0,
    violations: ui.violations || 0,
    registered_at: ui.registeredAt || null,
    submitted_at: ui.submittedAt || null,
    device_id: ui.deviceId || '',
    cert_id: ui.certId || null,
  };
}

export { supabase };
