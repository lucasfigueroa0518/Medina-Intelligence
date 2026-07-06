import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Security response headers (all routes) ---
//
// Enforced set: safe-by-construction for an HTTPS app that is never
// embedded in third-party frames (this one isn't — document previews
// iframe INTO the app, not the app into others).
//
// CSP ships REPORT-ONLY first, deliberately: a wrong enforced CSP
// white-screens the app, and the true production surface (API origin,
// Vercel preview tooling) is only observable live. Violations land in
// the browser console; tighten → enforce is the documented follow-up
// (see the PR / CLAUDE.md security-header baseline).
//
// connect-src derives from NEXT_PUBLIC_API_URL at build time — Vercel
// sets it per environment, so previews and production each get their
// own correct API origin without hardcoding either here.
const apiOrigin = (() => {
  try {
    return process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : '';
  } catch {
    return '';
  }
})();

// Vercel preview deployments inject live-feedback tooling (vercel.live
// + its pusher websocket). Scope those sources to previews so the
// production policy stays tight.
const isVercelPreview = process.env.VERCEL_ENV === 'preview';
const previewScript = isVercelPreview ? ' https://vercel.live' : '';
const previewConnect = isVercelPreview ? ' https://vercel.live wss://*.pusher.com https://*.pusher.com' : '';

const contentSecurityPolicy = [
  `default-src 'self'`,
  // 'unsafe-inline'/'unsafe-eval' are what report-only mode is here to
  // measure — Next's bootstrap requires inline today; nonce-based
  // script-src is the strict end-state.
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'${previewScript}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:`,
  `font-src 'self' data:`,
  `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''}${previewConnect}`,
  `worker-src 'self' blob:`,
  // blob: is load-bearing: the app's own document previews (PDF/HTML)
  // iframe URL.createObjectURL blob: URLs (file-preview, document
  // modals). Without it, enforcing this policy would break previews —
  // caught as a report-only violation by the round-1 audit.
  `frame-src 'self' blob:${isVercelPreview ? ' https://vercel.live' : ''}`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `frame-ancestors 'none'`,
  // Violations POST to our own sink (app/api/csp-report) and land in
  // Vercel function logs — the telemetry that decides when this policy
  // flips to enforcing. Deliberately report-uri ONLY: when report-to is
  // also present Chrome prefers it, and Reporting-API delivery is
  // batched/delayed — short sessions never flush (proven in the drill:
  // zero reports with both directives, immediate with report-uri
  // alone). The Reporting-Endpoints header below stays as the
  // documented future switch once batched delivery is acceptable.
  `report-uri /api/csp-report`,
].join('; ');

const securityHeaders = [
  // 2 years; includeSubDomains but no preload — preload-list submission
  // is a hard commitment and an explicit owner call.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // frame-ancestors cannot break a non-embedded app, so this one
  // directive is enforced immediately; the full policy above reports.
  { key: 'Content-Security-Policy', value: `frame-ancestors 'none'` },
  { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy },
  // Named endpoint for the CSP report-to directive above.
  { key: 'Reporting-Endpoints', value: 'csp-endpoint="/api/csp-report"' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
