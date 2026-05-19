import http from 'node:http';
import { artifactToolUnavailableResult, buildArtifactToolDeck } from './artifact-builder.mjs';

const PORT = Number(process.env.PORT || 4317);
const TOKEN = process.env.DECK_RENDERER_TOKEN || '';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 15_000_000);
const VIEWPORT = { width: 1920, height: 1080 };
const MAX_REPAIR_PASSES = 3;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearer(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] || req.headers['x-deck-renderer-token'] || '').trim();
}

function emptyQa(jobId, status = 'failed', error = 'Renderer failed before QA completed.') {
  return {
    job_id: jobId,
    status,
    qa_report: {
      status,
      slideFindings: [{ slideId: 'deck', severity: 'critical', issue: error, requiredFix: 'Retry rendering or inspect the renderer service logs.' }],
      checks: {
        slide_count: 0,
        visual_surface_count: 0,
        average_words_per_slide: 0,
        max_words_on_slide: 0,
        accent_gutter_px: 0,
        html_bytes: 0,
      },
    },
    screenshots: [],
    metrics: {},
    error,
  };
}

function severityRank(severity) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity] || 0;
}

function mergeQa(baseQa, findings, metrics) {
  const existing = Array.isArray(baseQa?.slideFindings) ? baseQa.slideFindings : [];
  const seen = new Set();
  const merged = [];
  for (const finding of [...existing, ...findings]) {
    const key = `${finding.slideId}|${finding.severity}|${finding.issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  const maxSeverity = merged.reduce((max, item) => Math.max(max, severityRank(item.severity)), 0);
  const status = maxSeverity >= 4 ? 'failed' : maxSeverity >= 3 ? 'needs_revision' : 'pass';
  return {
    status,
    slideFindings: merged,
    checks: {
      ...(baseQa?.checks || {}),
      ...metrics,
    },
  };
}

async function inspectSlides(page) {
  return page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const slides = Array.from(document.querySelectorAll('.slide'));
    const findings = [];
    const metrics = {
      slide_count: slides.length,
      blank_slide_count: 0,
      overflow_count: 0,
      overlap_count: 0,
      low_contrast_count: 0,
      tiny_type_count: 0,
      bad_margin_count: 0,
      excessive_bullet_slide_count: 0,
      accent_gutter_px: 0,
    };

    function parseAlpha(value) {
      const raw = String(value || '1').trim();
      if (raw.endsWith('%')) return Math.max(0, Math.min(1, Number(raw.slice(0, -1)) / 100));
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    }

    function parseRgbChannel(value, unitInterval) {
      const raw = String(value || '0').trim();
      if (raw.endsWith('%')) return Math.max(0, Math.min(255, Number(raw.slice(0, -1)) * 2.55));
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(255, unitInterval ? n * 255 : n));
    }

    function parseCssColor(value) {
      const raw = String(value || '').trim();
      const normalized = raw.replace(/\s+/g, ' ').toLowerCase();
      if (!normalized || normalized === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const hex = normalized.match(/^#([0-9a-f]{3,8})$/i)?.[1];
      if (hex) {
        const expanded = hex.length === 3 || hex.length === 4
          ? hex.split('').map(ch => ch + ch).join('')
          : hex;
        return {
          r: parseInt(expanded.slice(0, 2), 16),
          g: parseInt(expanded.slice(2, 4), 16),
          b: parseInt(expanded.slice(4, 6), 16),
          a: expanded.length >= 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
        };
      }
      const srgb = normalized.match(/^color\(\s*srgb\s+(.+)\)$/i);
      if (srgb) {
        const [channelsPart, alphaPart] = srgb[1].split('/');
        const channels = channelsPart.trim().split(/\s+/);
        return {
          r: parseRgbChannel(channels[0], true),
          g: parseRgbChannel(channels[1], true),
          b: parseRgbChannel(channels[2], true),
          a: parseAlpha(alphaPart),
        };
      }
      const rgb = normalized.match(/^rgba?\((.+)\)$/i);
      if (rgb) {
        const parts = rgb[1].replace(/\s*\/\s*/, ',').split(/[,\s]+/).filter(Boolean);
        return {
          r: parseRgbChannel(parts[0], false),
          g: parseRgbChannel(parts[1], false),
          b: parseRgbChannel(parts[2], false),
          a: parseAlpha(parts[3]),
        };
      }
      return null;
    }

    function composite(top, bottom) {
      const a = top.a + bottom.a * (1 - top.a);
      if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a,
      };
    }

    function luminance(color) {
      const [r, g, b] = [color.r, color.g, color.b].map(v => {
        const s = Math.max(0, Math.min(255, v)) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function contrast(foreground, background) {
      const fg = parseCssColor(foreground) || { r: 0, g: 0, b: 0, a: 1 };
      const composited = composite(fg, background);
      const l1 = luminance(composited);
      const l2 = luminance(background);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    function isTransparentColor(value) {
      const parsed = parseCssColor(value);
      return !parsed || parsed.a <= 0;
    }

    function rectFor(el) {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }

    function intersects(a, b) {
      const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const area = x * y;
      if (area < 64) return false;
      const smaller = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
      return area / smaller > 0.08;
    }

    function effectiveBackground(el, slide, fallback) {
      const chain = [];
      let node = el;
      while (node) {
        chain.push(node);
        if (node === slide) break;
        node = node.parentElement;
      }
      let bg = parseCssColor(fallback) || { r: 15, g: 15, b: 20, a: 1 };
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const parsed = parseCssColor(window.getComputedStyle(chain[i]).backgroundColor);
        if (parsed && parsed.a > 0) bg = composite(parsed, bg);
      }
      return bg;
    }

    slides.forEach((slide, index) => {
      const slideId = slide.id || `slide_${index + 1}`;
      const rect = rectFor(slide);
      const style = window.getComputedStyle(slide);
      const text = (slide.textContent || '').replace(/\s+/g, ' ').trim();
      const contentEls = Array.from(slide.querySelectorAll('h1,h2,h3,p,li,td,th,.headline,.takeaway,.metric-value,.metric-label,.evidence-card strong,.evidence-card span,.table-title'))
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        })
        .filter((el, _index, all) => {
          return !all.some(other => other !== el && el.contains(other));
        });

      if (!text && slide.querySelectorAll('img,svg,canvas,table').length === 0) {
        metrics.blank_slide_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Rendered slide appears blank.', requiredFix: 'Populate the slide or remove it from the deck.' });
      }

      if (slide.scrollWidth > slide.clientWidth + 3 || slide.scrollHeight > slide.clientHeight + 3) {
        metrics.overflow_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Slide content overflows the canvas.', requiredFix: 'Compress copy, reduce density, or split the slide.' });
      }

      const minMargin = Math.min(
        ...contentEls.map(el => {
          const r = rectFor(el);
          return Math.min(r.left - rect.left, rect.right - r.right, r.top - rect.top, rect.bottom - r.bottom);
        }),
        999
      );
      if (minMargin < 32) {
        metrics.bad_margin_count += 1;
        findings.push({ slideId, severity: 'high', issue: 'Slide has content too close to the edge.', requiredFix: 'Restore safe margins and rebalance the layout grid.' });
      }

      const tiny = contentEls.filter(el => Number.parseFloat(window.getComputedStyle(el).fontSize || '16') < 11);
      if (tiny.length > 0) {
        metrics.tiny_type_count += 1;
        findings.push({ slideId, severity: 'high', issue: 'Slide contains tiny type below presentation-safe size.', requiredFix: 'Increase type size or move detail to appendix/notes.' });
      }

      const bullets = slide.querySelectorAll('li').length;
      if (bullets > 7) {
        metrics.excessive_bullet_slide_count += 1;
        findings.push({ slideId, severity: 'medium', issue: `Slide has ${bullets} bullets.`, requiredFix: 'Convert the list into a table, matrix, timeline, or proof surface.' });
      }

      const background = isTransparentColor(style.backgroundColor) ? 'rgb(15,15,20)' : style.backgroundColor;
      const lowContrast = contentEls.filter(el => {
        const elementStyle = window.getComputedStyle(el);
        return contrast(elementStyle.color, effectiveBackground(el, slide, background)) < 3.8;
      });
      if (lowContrast.length > Math.max(2, contentEls.length * 0.15)) {
        metrics.low_contrast_count += 1;
        findings.push({ slideId, severity: 'high', issue: 'Slide has low-contrast text.', requiredFix: 'Increase foreground/background contrast before export.' });
      }

      const blocks = contentEls.slice(0, 60).map(el => ({ el, rect: rectFor(el) }));
      let overlap = false;
      for (let i = 0; i < blocks.length && !overlap; i += 1) {
        for (let j = i + 1; j < blocks.length; j += 1) {
          if (blocks[i].el.contains(blocks[j].el) || blocks[j].el.contains(blocks[i].el)) continue;
          if (intersects(blocks[i].rect, blocks[j].rect)) {
            overlap = true;
            break;
          }
        }
      }
      if (overlap) {
        metrics.overlap_count += 1;
        findings.push({ slideId, severity: 'critical', issue: 'Slide elements appear to overlap.', requiredFix: 'Reflow the slide and increase spacing between elements.' });
      }

      const accent = slide.querySelector('.slide-accent,.accent-line,.purple-line,.callout-accent,[data-accent-line]');
      if (accent) {
        const accentRect = rectFor(accent);
        const nearestTextLeft = Math.min(...contentEls.map(el => rectFor(el).left).filter(v => Number.isFinite(v)), rect.right);
        const gutter = nearestTextLeft - accentRect.right;
        metrics.accent_gutter_px = Math.max(metrics.accent_gutter_px || 0, Math.round(gutter));
        if (gutter < 48) {
          findings.push({ slideId, severity: 'critical', issue: 'Purple accent line is too close to body text.', requiredFix: 'Move the accent line left or increase the text gutter.' });
        }
      }
    });

    return { viewport, findings, metrics };
  });
}

async function applyRepairPass(page, pass) {
  await page.addStyleTag({
    content: `
      :root { --accent-gutter: ${88 + pass * 10}px !important; }
      .slide { overflow: hidden !important; }
      .slide * { box-sizing: border-box !important; }
      .slide-accent, .accent-line, .purple-line, [data-accent-line] { margin-right: ${42 + pass * 8}px !important; }
      .slide p, .slide li, .slide td, .slide th { line-height: ${pass >= 2 ? 1.18 : 1.22} !important; }
      .slide .body, .slide .content, .slide .evidence-grid, .slide .table-wrap { max-width: 100% !important; }
    `,
  });
}

async function renderDeck(payload) {
  const jobId = String(payload.job_id || '');
  if (!jobId || typeof payload.html !== 'string') {
    throw new Error('INVALID_RENDER_REQUEST');
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.setContent(payload.html, { waitUntil: 'networkidle' });
    let inspection = await inspectSlides(page);
    let repairPasses = 0;
    while (
      repairPasses < MAX_REPAIR_PASSES
      && inspection.findings.some(f => f.severity === 'critical' || f.severity === 'high')
    ) {
      repairPasses += 1;
      await applyRepairPass(page, repairPasses);
      inspection = await inspectSlides(page);
    }

    const slideHandles = await page.$$('.slide');
    const screenshots = [];
    for (let i = 0; i < slideHandles.length; i += 1) {
      const handle = slideHandles[i];
      const buffer = await handle.screenshot({ type: 'png' });
      const slideId = await handle.evaluate((el, fallback) => el.id || fallback, `slide_${i + 1}`);
      screenshots.push({
        slideId,
        index: i + 1,
        fileName: `${jobId}-slide-${String(i + 1).padStart(2, '0')}.png`,
        mimeType: 'image/png',
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        base64: buffer.toString('base64'),
      });
    }

    const pdfBuffer = await page.pdf({
      printBackground: true,
      width: `${VIEWPORT.width}px`,
      height: `${VIEWPORT.height}px`,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    const htmlBytes = Buffer.byteLength(payload.html, 'utf8');
    const qa = mergeQa(payload.qa_report, inspection.findings, {
      ...(payload.qa_report?.checks || {}),
      ...inspection.metrics,
      html_bytes: htmlBytes,
      repair_passes: repairPasses,
    });

    return {
      job_id: jobId,
      status: qa.status,
      qa_report: qa,
      screenshots,
      pdf_base64: pdfBuffer.toString('base64'),
      metrics: {
        viewport: VIEWPORT,
        repair_passes: repairPasses,
        renderer: 'playwright',
        rendered_slide_count: screenshots.length,
      },
    };
  } finally {
    await browser.close();
  }
}

async function handleRender(req, res) {
  if (TOKEN && bearer(req) !== TOKEN) {
    json(res, 401, { error: 'UNAUTHORIZED' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    json(res, 200, await renderDeck(payload));
  } catch (e) {
    const result = emptyQa(String(payload?.job_id || 'unknown'), 'failed', e instanceof Error ? e.message : String(e));
    json(res, 500, result);
  }
}

async function handleDeckBuild(req, res) {
  if (TOKEN && bearer(req) !== TOKEN) {
    json(res, 401, { error: 'UNAUTHORIZED' });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    json(res, 200, await buildArtifactToolDeck(payload));
  } catch (e) {
    const result = artifactToolUnavailableResult(String(payload?.job_id || 'unknown'), e);
    json(res, 500, result);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, service: 'marty-deck-renderer' });
    return;
  }
  if (req.method === 'POST' && req.url === '/render') {
    handleRender(req, res).catch(e => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/deck/build') {
    handleDeckBuild(req, res).catch(e => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  json(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  console.log(`[deck-renderer] listening on :${PORT}`);
});
