import { supabase } from '../supabase.js';

export async function listCustomQuestions() {
  const { data, error } = await supabase.from('custom_questions').select('*');
  if (error) throw error;
  const out = {};
  (data || []).forEach((r) => {
    out[r.round_index] = { questions: r.questions || [] };
    out['round' + r.round_index] = { questions: r.questions || [] };
  });
  return out;
}

export async function saveCustomQuestions(roundIndex, questionsPayload) {
  const questions = questionsPayload?.questions || questionsPayload || [];
  const { error } = await supabase.from('custom_questions').upsert({
    round_index: roundIndex,
    questions,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export function subscribeCustomQuestions(onChange) {
  const channel = supabase
    .channel('questions_rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'custom_questions' }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
