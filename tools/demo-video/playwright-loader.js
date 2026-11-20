'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolvePlaywright() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright', 'playwright-core');
  candidates.push(
    '/opt/homebrew/lib/node_modules/agent-browser/node_modules/playwright-core',
    '/opt/homebrew/lib/node_modules/playwright',
    '/opt/homebrew/lib/node_modules/playwright-core',
    '/usr/local/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright-core',
    path.join(home, '.claude/skills/gstack/node_modules/playwright'),
    path.join(home, '.agents/skills/gstack/node_modules/playwright')
  );

  const bunCache = path.join(home, '.bun/install/cache/playwright');
  if (fs.existsSync(bunCache)) {
    for (const entry of fs.readdirSync(bunCache)) {
      candidates.push(path.join(bunCache, entry));
    }
  }

  const npxDir = path.join(home, '.npm/_npx');
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      candidates.push(path.join(npxDir, entry, 'node_modules/playwright'));
    }
  }

  const errors = [];
  for (const spec of candidates) {
    try {
      const pw = require(spec);
      if (!pw?.chromium) continue;
      const execPath =
        process.env.CHROMIUM_PATH ||
        (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) {
        return { chromium: pw.chromium, executablePath: execPath, modulePath: spec };
      }
      errors.push(`${spec}: chromium binary not found at ${execPath || '(none)'}`);
    } catch (err) {
      errors.push(`${spec}: ${err.code || err.message}`);
    }
  }

  throw new Error(
    `Could not locate Playwright + Chromium. Set PLAYWRIGHT_MODULE / CHROMIUM_PATH or install playwright.\nTried:\n- ${errors.slice(0, 8).join('\n- ')}`
  );
}

module.exports = { resolvePlaywright };
