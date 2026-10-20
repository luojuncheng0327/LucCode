/* global Response */

/**
 * Cloudflare Workers entry point. It owns nothing but the wiring: the KV
 * binding, the environment bag and the platform clock go into core.mjs, which
 * holds every decision this service makes.
 */

import { handleRequest } from "./core.mjs";

export default {
  async fetch(request, env, _ctx) {
    try {
      return await handleRequest(request, { kv: env.INVITE_KV, env });
    } catch (error) {
      // handleRequest already turns its own failures into JSON; anything
      // arriving here is a wiring fault, and it still leaves as JSON so the
      // desktop client can read `error` the same way it reads every other
      // rejection.
      return new Response(
        JSON.stringify({ ok: false, error: error?.message || String(error) }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
};
