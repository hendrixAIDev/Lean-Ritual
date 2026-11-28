/**
 * Cloudflare Worker entrypoint for Lean Ritual external uptime monitor.
 *
 * Kept strictly to a default ExportedHandler export because workerd rejects
 * non-handler named exports (such as primitive constants) on the Worker
 * entrypoint module. Helper functions and constants live in ./monitor.js.
 */

import { runCheck } from "./monitor.js";

export default {
  async fetch() {
    return new Response("Not Found\n", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  },

  async scheduled(_controller, env) {
    await runCheck(env);
  }
};
