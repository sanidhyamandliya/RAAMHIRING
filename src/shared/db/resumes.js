import { supabase } from '../supabase.js';

export async function uploadResume(email, file) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const safeName = (file.name || 'resume').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${cleanEmail.replace(/[^a-z0-9.@_-]/gi, '_')}/${Date.now()}_${safeName}`;

  const { error: upErr } = await supabase.storage.from('resumes').upload(path, file, { upsert: false });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage.from('resumes').getPublicUrl(path);

  const { error } = await supabase.from('resumes').insert({
    candidate_email: cleanEmail,
    file_path: path,
    file_name: file.name || safeName,
    file_size: file.size || null,
    mime_type: file.type || null,
  });
  if (error) throw error;

  return pub.publicUrl;
}

export async function getResumeByEmail(email) {
  const { data, error } = await supabase
    .from('resumes')
    .select('*')
    .eq('candidate_email', (email || '').toLowerCase().trim())
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: pub } = supabase.storage.from('resumes').getPublicUrl(data.file_path);
  return { ...data, url: pub.publicUrl };
}
