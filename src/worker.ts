/**
 * Router. Everything about the slot lives in one Durable Object, so this file
 * only decides what is an API call and what is a file.
 */

export { Slot } from './slot.ts';

const API = new Set(['/api/state', '/api/claim', '/api/cancel', '/api/stream']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!API.has(url.pathname)) return env.ASSETS.fetch(request);

    // A single named object, so every visitor is looking at the same slot.
    const slot = env.SLOT.get(env.SLOT.idFromName('the-slot'));
    const response = await slot.fetch(request);

    // Nimiq Pay loads the app from its own origin inside a WebView, and whether
    // Origin arrives as null differs by platform and is undocumented. The API
    // holds no secrets and no cookies, so it answers anyone.
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
