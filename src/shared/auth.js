import { supabase } from './supabase.js';

/** Map a Supabase Auth user to the dashboard's loggedUser shape. */
export function mapAuthUser(user) {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const app = user.app_metadata || {};
  const role = app.role || meta.role || 'hr';
  const name = meta.name || meta.full_name || (user.email ? user.email.split('@')[0] : 'User');
  return {
    id: user.id,
    email: user.email,
    name,
    role: role === 'admin' || role === 'hr' ? role : 'hr',
  };
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return mapAuthUser(data.user);
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSessionUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session?.user) return null;
  return mapAuthUser(data.session.user);
}
