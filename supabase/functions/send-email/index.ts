// Supabase Edge Function: send-email
// Sends candidate-facing email via Resend, using one of three distinct HTML templates
// selected by `type`. Keeps the Resend API key server-side only (never shipped to the client).
//
// Deploy:
//   npx supabase functions deploy send-email
//   npx supabase secrets set RESEND_API_KEY=re_xxx MAIL_FROM="Assessment Team <you@yourdomain.com>"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const AMBER = '#d4a843';
const BG = '#0d0d10';
const CARD = '#15151a';
const TEXT = '#e8e8ea';
const MUTED = '#9a9a9a';

function wrapper(bodyHtml: string): string {
  return `<!doctype html>
<html>
<body style="margin:0;padding:32px 16px;background:${BG};font-family:Georgia,serif;color:${TEXT}">
  <div style="max-width:560px;margin:0 auto;background:${CARD};border:1px solid ${AMBER};border-radius:12px;padding:32px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:11px;letter-spacing:.14em;color:${MUTED};text-transform:uppercase">Management Trainee Programme · 2026</div>
    </div>
    ${bodyHtml}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid rgba(212,168,67,.25);text-align:center;font-size:10.5px;color:${MUTED}">
      Recruitment Team
    </div>
  </div>
</body>
</html>`;
}

function confirmationTemplate(p: Record<string, string>) {
  const subject = 'Assessment Submitted — ' + (p.name || 'Candidate');
  const html = wrapper(`
    <h1 style="font-size:20px;color:${AMBER};text-align:center;margin:0 0 16px">Assessment Submitted 🎉</h1>
    <p style="font-size:14px;line-height:1.7">Dear ${p.name || 'Candidate'},</p>
    <p style="font-size:14px;line-height:1.7">Your Management Trainee Assessment has been submitted successfully.</p>
    <table style="width:100%;font-size:13px;margin:16px 0;border-collapse:collapse">
      <tr><td style="padding:4px 0;color:${MUTED}">Programme</td><td style="padding:4px 0;text-align:right">${p.programme || '—'}</td></tr>
      <tr><td style="padding:4px 0;color:${MUTED}">College</td><td style="padding:4px 0;text-align:right">${p.college || '—'}</td></tr>
      <tr><td style="padding:4px 0;color:${MUTED}">Certificate ID</td><td style="padding:4px 0;text-align:right">${p.certId || '—'}</td></tr>
    </table>
    <p style="font-size:14px;line-height:1.7">Your certificate is attached to this email. The recruitment team will review your profile and be in touch within 10 business days.</p>
  `);
  return { subject, html };
}

function inviteTemplate(p: Record<string, string>) {
  const subject = p.subject || 'Invitation: Management Trainee Assessment';
  const bodyText = (p.body || '').replace(/\n/g, '<br>');
  const html = wrapper(`
    <h1 style="font-size:20px;color:${AMBER};text-align:center;margin:0 0 16px">You're Invited 📨</h1>
    <div style="font-size:14px;line-height:1.8">${bodyText}</div>
    ${p.link ? `<div style="text-align:center;margin:24px 0">
      <a href="${p.link}" style="background:${AMBER};color:#000;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px;display:inline-block;font-family:sans-serif;font-size:13px">Start Assessment →</a>
    </div>` : ''}
  `);
  return { subject, html };
}

function offerTemplate(p: Record<string, string>) {
  const subject = 'Offer: Management Trainee Programme';
  const html = wrapper(`
    <h1 style="font-size:20px;color:${AMBER};text-align:center;margin:0 0 16px">Congratulations! 🎉</h1>
    <p style="font-size:14px;line-height:1.7">Dear ${p.name || 'Candidate'},</p>
    <p style="font-size:14px;line-height:1.7">We are pleased to offer you a position as a Management Trainee for the ${p.programme || 'MT Programme'}.</p>
    <p style="font-size:14px;line-height:1.7">Your assessment performance has impressed our team. Please contact HR to confirm acceptance within 5 business days.</p>
  `);
  return { subject, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { type, to } = body;
    if (!to || !type) {
      return new Response(JSON.stringify({ error: 'Missing "to" or "type"' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let rendered: { subject: string; html: string };
    if (type === 'confirmation') rendered = confirmationTemplate(body);
    else if (type === 'invite') rendered = inviteTemplate(body);
    else if (type === 'offer') rendered = offerTemplate(body);
    else {
      return new Response(JSON.stringify({ error: 'Unknown type: ' + type }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const MAIL_FROM = Deno.env.get('MAIL_FROM') || 'Assessment Team <onboarding@resend.dev>';
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const payload: Record<string, unknown> = {
      from: MAIL_FROM,
      to: [to],
      subject: rendered.subject,
      html: rendered.html,
    };
    if (body.certImageBase64) {
      payload.attachments = [
        {
          filename: `certificate-${body.certId || 'apex'}.png`,
          content: body.certImageBase64,
        },
      ];
    }

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();

    return new Response(JSON.stringify(result), {
      status: resp.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
