import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const token = process.env.DECK_RENDERER_TOKEN || 'dev-token';
const port = Number(process.env.PORT || 4317);
const env = { ...process.env, DECK_RENDERER_TOKEN: token, PORT: String(port) };
const server = spawn(process.execPath, ['src/server.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', chunk => process.stdout.write(chunk));
server.stderr.on('data', chunk => process.stderr.write(chunk));

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  await wait(1500);
  const html = `<!doctype html><html><head><style>
    body{margin:0;background:#050507;font-family:Inter,Arial;color:#fff}
    .slide{width:1920px;height:1080px;position:relative;background:#0f0f14;padding:96px;box-sizing:border-box;page-break-after:always}
    .accent-line{position:absolute;left:48px;top:120px;width:4px;height:420px;background:#b548f6}
    h1{font-size:72px;margin:0 0 32px 80px;max-width:1200px}
    p{font-size:32px;margin-left:80px;max-width:1100px;line-height:1.25}
  </style></head><body>
    <section class="slide" id="slide_1"><div class="accent-line"></div><h1>Smoke Test Deck</h1><p>Renderer should capture this slide, produce a PDF, and run QA.</p></section>
  </body></html>`;
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      job_id: 'smoke',
      title: 'Smoke Test',
      html,
      style_pack: 'medina_default',
      quality_mode: 'premium',
      output_formats: ['html', 'pdf', 'pptx'],
      plan: { title: 'Smoke Test', audience: 'internal', objective: 'inform', storyline: [], style_pack: 'medina_default', slides: [], facts: [] },
      qa_report: { status: 'pass', slideFindings: [], checks: { slide_count: 1, visual_surface_count: 1, average_words_per_slide: 4, max_words_on_slide: 8, accent_gutter_px: 80, html_bytes: html.length } },
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.pdf_base64 || !body.screenshots?.length) {
    throw new Error(`Smoke render failed: ${JSON.stringify(body).slice(0, 500)}`);
  }
  console.log(`[deck-renderer] smoke ok: status=${body.status}, screenshots=${body.screenshots.length}`);
} finally {
  server.kill('SIGTERM');
}
