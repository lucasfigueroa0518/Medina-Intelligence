// Client-side error-boundary beacon sink. SSR crashes already reach
// Vercel function logs via the boundary's console.error, but CLIENT
// render crashes previously died in the user's browser console —
// invisible to ops. app/error.tsx and app/global-error.tsx POST a
// bounded, PII-light payload here (message, digest, path, source),
// which lands in Vercel function logs.

export const dynamic = 'force-dynamic';

const MAX_FIELD = 500;

export async function POST(request: Request) {
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const clamp = (v: unknown) => String(v ?? '').slice(0, MAX_FIELD);
    console.error(
      '[client-error]',
      JSON.stringify({
        source: clamp(raw.source),
        message: clamp(raw.message),
        digest: clamp(raw.digest),
        path: clamp(raw.path),
      })
    );
  } catch {
    // Never let a broken beacon produce a user-visible error.
  }
  return new Response(null, { status: 204 });
}
