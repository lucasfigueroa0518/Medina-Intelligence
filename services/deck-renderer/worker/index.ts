import { Container } from '@cloudflare/containers';

export class DeckRendererContainer extends Container {
  defaultPort = 4317;
  requiredPorts = [4317];
  sleepAfter = '20m';
  enableInternet = true;
  env = {
    NODE_ENV: 'production',
    PORT: '4317',
    ARTIFACT_TOOL_NODE_MODULES: '/app/node_modules',
  };
}

interface Env {
  DECK_RENDERER_CONTAINER: DurableObjectNamespace<DeckRendererContainer>;
  DECK_RENDERER_TOKEN?: string;
}

function bearer(request: Request): string {
  const raw = request.headers.get('authorization') || '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.DECK_RENDERER_TOKEN || '';
  if (!expected) return false;
  return bearer(request) === expected;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const container = env.DECK_RENDERER_CONTAINER.getByName('primary');

    if (request.method === 'GET' && url.pathname === '/health') {
      const upstream = await container.fetch(request);
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    if (!isAuthorized(request, env)) {
      return json({ error: 'UNAUTHORIZED' }, { status: 401 });
    }

    return container.fetch(request);
  },
};
