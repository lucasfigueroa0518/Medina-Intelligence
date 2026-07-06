// CSP violation report sink. The report-only policy in next.config.mjs
// points report-uri / Reporting-Endpoints here, so production
// violations land in Vercel function logs (console) instead of dying in
// end-user browser consoles nobody sees. This is the telemetry that
// decides when the CSP can flip from report-only to enforcing.
//
// Deliberately dependency-free and forgiving: reporters send several
// content types (application/csp-report, application/reports+json);
// we log a bounded slice of whatever arrives and always 204 — a broken
// report must never surface an error to the app.

export const dynamic = 'force-dynamic';

const MAX_LOGGED_BYTES = 4_000;

export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (body) {
      console.warn('[csp-report]', body.slice(0, MAX_LOGGED_BYTES));
    }
  } catch {
    // Malformed/aborted report bodies are dropped silently.
  }
  return new Response(null, { status: 204 });
}
