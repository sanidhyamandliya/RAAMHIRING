import fs from 'fs';
import path from 'path';

function extract(file, name) {
  const html = fs.readFileSync(file, 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  const styles = styleMatch ? styleMatch[1] : '';

  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1]
  );
  // Prefer the largest inline script (main app), not tiny bootstraps
  const js = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');

  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : '';
  body = body.replace(/<style>[\s\S]*?<\/style>/g, '');
  body = body.replace(/<script[\s\S]*?<\/script>/g, '');

  fs.mkdirSync('tmp_extract', { recursive: true });
  fs.writeFileSync(path.join('tmp_extract', `${name}.css`), styles);
  fs.writeFileSync(path.join('tmp_extract', `${name}.js`), js);
  fs.writeFileSync(path.join('tmp_extract', `${name}-body.html`), body.trim());
  console.log(name, {
    css: styles.length,
    js: js.length,
    body: body.length,
    scripts: scripts.map((s) => s.length),
  });
}

extract('assessment-supabase.html', 'assessment');
extract('dashboard-supabase.html', 'dashboard');
