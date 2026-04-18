// Shared response helpers
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function errorResponse(code: string, status: number, details?: string): Response {
  return jsonResponse({ error: code, details }, status);
}

export function parseSearchParams(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k in out) {
      const prev = out[k];
      out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
