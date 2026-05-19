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
    .slide{width:1920px;height:1080px;position:relative;background:#08080d;padding:120px 120px 96px 188px;box-sizing:border-box;page-break-after:always;overflow:hidden}
    .accent-line{position:absolute;left:64px;top:120px;width:5px;height:760px;background:#d946a8;border-radius:999px}
    .cover-grid{display:grid;grid-template-columns:minmax(0,1fr)420px;gap:72px;align-items:center;height:100%}
    .kicker{font-size:18px;letter-spacing:.16em;text-transform:uppercase;color:#a78bfa;font-weight:800;margin-bottom:28px}
    h1{font-size:66px;line-height:1.04;margin:0;max-width:980px;color:color(srgb 0.965 0.97 1)}
    h2{font-size:54px;line-height:1.05;margin:0 0 26px;color:#f8fafc;max-width:1120px}
    p{font-size:30px;line-height:1.28;color:color(srgb 0.93 0.92 0.99);max-width:1100px;margin:24px 0 0}
    .proof{display:grid;gap:18px}
    .card,.metric,.table-wrap{background:#151520;border:1px solid #323244;border-radius:8px}
    .card{padding:24px;color:#f8fafc;font-size:24px;line-height:1.25}
    .metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:44px;max-width:760px}
    .metric{padding:28px}
    .metric strong{display:block;font-size:44px;line-height:1;color:#fff}
    .metric span{display:block;margin-top:12px;color:#a1a1aa;text-transform:uppercase;letter-spacing:.1em;font-size:18px}
    .table-wrap{margin-top:40px;overflow:hidden}
    table{width:100%;border-collapse:collapse;font-size:24px;color:#eef0f6}
    th,td{padding:20px 24px;text-align:left;vertical-align:top;border-bottom:1px solid #2d2d36;line-height:1.28}
    th{font-size:18px;letter-spacing:.1em;text-transform:uppercase;color:#a78bfa;background:#111118}
  </style></head><body>
    <section class="slide" id="slide_1"><div class="accent-line"></div><div class="cover-grid"><div><div class="kicker">Medina Ventures · Deal Review</div><h1>NeuralSeek — Deal Status Update With a Long Cover Title That Must Not Collide With Proof Cards</h1><p>Renderer should parse color(srgb) text correctly and keep the cover proof surface separate from the headline.</p></div><aside class="proof"><div class="card">All-channel ARR: $1.8M</div><div class="card">NS-led ARR: $168K</div><div class="card">Target valuation: $250M</div></aside></div></section>
    <section class="slide" id="slide_2"><div class="accent-line"></div><div class="kicker">Analysis Exhibit</div><h2>Financial Snapshot — As of Dec 31, 2025</h2><p>Metrics should stay readable on dark Medina panels without low-contrast false positives.</p><div class="metrics"><div class="metric"><strong>$149,130</strong><span>Total MRR</span></div><div class="metric"><strong>$1,789,560</strong><span>Total ARR</span></div></div></section>
    <section class="slide" id="slide_3"><div class="accent-line"></div><div class="kicker">Table Exhibit</div><h2>Pipeline Evidence Table</h2><div class="table-wrap"><table><thead><tr><th>Dimension</th><th>Summary</th><th>Status</th></tr></thead><tbody><tr><td>Product</td><td>Agentic AI control-layer platform with no-code enterprise deployment.</td><td>Validated</td></tr><tr><td>Revenue</td><td>Direct ARR remains small relative to channel-led revenue.</td><td>Needs bridge</td></tr><tr><td>Next step</td><td>Confirm revenue split and customer usage depth.</td><td>Owner assigned</td></tr></tbody></table></div></section>
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
