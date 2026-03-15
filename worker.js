// Cloudflare Worker — chub-proxy + KV sync for hidden bots
// Bindings needed:
//   KV namespace: ROLEPLAY_KV (variable name: ROLEPLAY_KV)
//   Environment variable: KV_SECRET (any string you choose)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-KV-Token',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ── KV endpoints (?kv=hidden) ─────────────────────────────
    const kvAction = url.searchParams.get('kv');
    if (kvAction === 'hidden') {
      // Token check
      const token = request.headers.get('X-KV-Token');
      if (!env.KV_SECRET || token !== env.KV_SECRET) {
        return new Response('Unauthorized', { status: 401, headers: cors });
      }

      if (request.method === 'GET') {
        const value = await env.ROLEPLAY_KV.get('hidden-bots');
        return new Response(value || '[]', {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'POST') {
        const body = await request.text();
        await env.ROLEPLAY_KV.put('hidden-bots', body);
        return new Response('ok', { headers: cors });
      }
    }

    // ── Existing CORS proxy (?url=...) ────────────────────────
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response('Missing url param', { status: 400, headers: cors });
    }

    try {
      const proxied = await fetch(decodeURIComponent(target), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return new Response(proxied.body, {
        status:  proxied.status,
        headers: {
          ...cors,
          'Content-Type': proxied.headers.get('Content-Type') || 'application/json',
        },
      });
    } catch (err) {
      return new Response('Proxy error: ' + err.message, { status: 502, headers: cors });
    }
  },
};
