'use strict';

/**
 * Demo-video server preload (`node --require tools/demo-video/demo-ai-block.js server.js`).
 *
 * Keeps the demo server hermetic and fail-closed: any outbound fetch or HTTP(S)
 * request targeting a non-loopback host (e.g. OpenRouter or Gemini if a Playwright
 * route interception is ever missed) is rejected locally before opening a socket.
 *
 * Lives strictly under tools/demo-video/ (excluded from Docker and release bundles)
 * so production server.js / lib/ai.js have zero mock or bypass code paths.
 */

const http = require('node:http');
const https = require('node:https');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(host) {
  if (!host) return true;
  const norm = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(norm) || norm.startsWith('127.');
}

function extractTarget(input) {
  if (!input) return { host: '', origin: '' };
  if (typeof input === 'string') {
    try {
      const u = new URL(input);
      return { host: u.hostname, origin: u.origin };
    } catch {
      return { host: '', origin: '' };
    }
  }
  if (input instanceof URL) {
    return { host: input.hostname, origin: input.origin };
  }
  if (typeof input === 'object') {
    if (typeof input.url === 'string') return extractTarget(input.url);
    if (typeof input.href === 'string') return extractTarget(input.href);
    const host = input.hostname || (typeof input.host === 'string' ? input.host.replace(/:\d+$/, '') : '');
    const proto = input.protocol || 'https:';
    return { host, origin: host ? `${proto}//${host}` : '' };
  }
  return { host: '', origin: '' };
}

function blockedError(origin) {
  const err = new Error(`Demo server blocked outbound request to ${origin || 'external host'}`);
  err.code = 'DEMO_OUTBOUND_BLOCKED';
  return err;
}

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = function demoGuardedFetch(input, init) {
    const { host, origin } = extractTarget(input);
    if (host && !isLoopbackHost(host)) {
      return Promise.reject(blockedError(origin));
    }
    return origFetch(input, init);
  };
}

function guardNodeRequest(mod) {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);

  mod.request = function demoGuardedRequest(urlOrOpts, ...rest) {
    const { host, origin } = extractTarget(urlOrOpts);
    if (host && !isLoopbackHost(host)) {
      throw blockedError(origin);
    }
    return origRequest(urlOrOpts, ...rest);
  };

  mod.get = function demoGuardedGet(urlOrOpts, ...rest) {
    const { host, origin } = extractTarget(urlOrOpts);
    if (host && !isLoopbackHost(host)) {
      throw blockedError(origin);
    }
    return origGet(urlOrOpts, ...rest);
  };
}

guardNodeRequest(http);
guardNodeRequest(https);

module.exports = { isLoopbackHost, extractTarget };
