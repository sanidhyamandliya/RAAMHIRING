# Apex Assessment Platform

Vite multi-page app: candidate assessment (`/`) + HR dashboard (`/dashboard.html`), backed by **normalized Supabase tables**.

## Database tables

| Table | What’s stored |
|-------|----------------|
| `candidates` | Name, email, programme, college, status, hire fields |
| `candidate_scores` | One row per round (0–5) with score |
| `events` | Live feed only (`registered`, `round_*`, `completed`, …) |
| `colleges` | College links / schedule / gate |
| `blocked_devices` / `blocked_emails` | Ban lists |
| `custom_questions` | Editable MCQ banks for rounds 0–3 |

Schema: [`sql/relational-schema.sql`](sql/relational-schema.sql)  
Auth users: [`sql/auth-setup.md`](sql/auth-setup.md)

(The old single `kv` JSON table is no longer used by the app.)

## Setup

1. Copy `.env.example` → `.env` and set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
2. Supabase SQL Editor → run `sql/relational-schema.sql`
3. Create HR Auth users (set `role` in app/user metadata — see auth-setup.md)
4. `npm install && npm run dev`

## URLs

- Assessment: http://localhost:5173/
- Dashboard: http://localhost:5173/dashboard.html

## Netlify (no GitHub)

```bash
npm run build
```

Drag the `dist` folder to [app.netlify.com/drop](https://app.netlify.com/drop).

## Project layout

```
src/
  shared/
    supabase.js      # createClient from env
    auth.js          # dashboard sign-in
    email.js
    db/              # relational data API
  assessment/
  dashboard/
sql/
  relational-schema.sql
  auth-setup.md
```
