/**
 * Renders a certificate to an off-screen canvas and returns base64 PNG (no data: prefix).
 * Same manual-canvas approach used elsewhere in this app for webcam snapshots — no image/PDF library needed.
 */
export function renderCertificatePNG({ name, programme, college, statusText, certId }) {
  const cvs = document.createElement('canvas');
  cvs.width = 1000;
  cvs.height = 650;
  const ctx = cvs.getContext('2d');

  ctx.fillStyle = '#0d0d10';
  ctx.fillRect(0, 0, 1000, 650);
  ctx.strokeStyle = '#d4a843';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, 952, 602);
  ctx.strokeStyle = 'rgba(212,168,67,.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 36, 928, 578);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#d4a843';
  ctx.font = '700 26px Georgia, serif';
  ctx.fillText('CERTIFICATE OF COMPLETION', 500, 120);

  ctx.fillStyle = '#9a9a9a';
  ctx.font = '400 15px Georgia, serif';
  ctx.fillText('Management Trainee Programme · 2026', 500, 150);

  ctx.fillStyle = '#cfcfcf';
  ctx.font = '400 14px Georgia, serif';
  ctx.fillText('This certifies that', 500, 230);

  ctx.fillStyle = '#d4a843';
  ctx.font = '700 42px Georgia, serif';
  ctx.fillText(name || 'Candidate', 500, 285);

  ctx.fillStyle = '#cfcfcf';
  ctx.font = '400 16px Georgia, serif';
  ctx.fillText('has successfully completed the ' + (programme || 'Management Trainee') + ' Assessment', 500, 330);
  ctx.fillText('College: ' + (college || '—'), 500, 360);

  ctx.fillStyle = '#22c55e';
  ctx.font = '700 24px Georgia, serif';
  ctx.fillText(statusText || 'ASSESSMENT SUBMITTED', 500, 430);

  ctx.fillStyle = '#8a8a8a';
  ctx.font = '400 13px Georgia, serif';
  ctx.fillText('Date: ' + new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), 500, 470);
  ctx.fillText('Certificate ID: ' + (certId || '—'), 500, 595);

  return cvs.toDataURL('image/png').split(',')[1];
}
