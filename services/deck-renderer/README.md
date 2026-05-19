# MARTy Deck Renderer

Node/Playwright service for MARTy's premium deck pipeline. Cloudflare Workers orchestrate deck jobs, but browser screenshots, artifact-tool deck builds, contact sheets, and PPTX/PDF/HTML exports run here.

## Local

```bash
npm --prefix services/deck-renderer install
npm --prefix services/deck-renderer exec playwright install chromium
DECK_RENDERER_TOKEN=dev-token npm --prefix services/deck-renderer start
```

Smoke test:

```bash
DECK_RENDERER_TOKEN=dev-token npm --prefix services/deck-renderer run smoke
```

Premium `/deck/build` requires `@oai/artifact-tool`. In local Codex sessions the renderer will try the bundled runtime automatically. On a container host, mount or install the runtime and set either `ARTIFACT_TOOL_NODE_MODULES` to the runtime `node_modules` directory or `ARTIFACT_TOOL_PATH` to the package entrypoint. If artifact-tool is unavailable, premium deck jobs fail visibly instead of falling back to the old handwritten renderer.

## Production Activation

1. Deploy this directory as a Docker service on a Node/container host.
2. Set the service env var:

```bash
DECK_RENDERER_TOKEN=<shared-secret>
PORT=4317
ARTIFACT_TOOL_NODE_MODULES=/path/to/node_modules
```

3. Set both Cloudflare Workers to the same renderer config:

```bash
npx wrangler secret put DECK_RENDERER_TOKEN
npx wrangler secret put DECK_RENDERER_TOKEN --config wrangler.pipelines.toml
npx wrangler deploy --var DECK_RENDERER_ENABLED:true --var DECK_RENDERER_URL:https://<renderer-host>
npx wrangler deploy --config wrangler.pipelines.toml --var DECK_RENDERER_ENABLED:true --var DECK_RENDERER_URL:https://<renderer-host>
```

If using `wrangler.toml` vars instead of deploy-time vars, add `DECK_RENDERER_ENABLED` and `DECK_RENDERER_URL` to both `wrangler.toml` and `wrangler.pipelines.toml`, keep the token as a secret, then redeploy both Workers.
