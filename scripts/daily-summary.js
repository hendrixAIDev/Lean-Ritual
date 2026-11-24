#!/usr/bin/env node
"use strict";

const {
  USAGE,
  parseCliArgs,
  collectDailySummary,
  formatSummaryText
} = require("../lib/daily-summary");

async function main() {
  const opts = parseCliArgs(process.argv.slice(2), process.env);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const summary = await collectDailySummary({
    sinceMs: opts.sinceMs,
    nowMs: opts.nowMs ?? undefined,
    journalFile: opts.journalFile,
    unit: opts.unit,
    backupRoot: opts.backupRoot,
    deployBackupRoot: opts.deployBackupRoot,
    includeFeedbackExcerpts: opts.includeFeedbackExcerpts,
    noJournal: opts.noJournal,
    noSystemd: opts.noSystemd
  });
  console.log(opts.json ? JSON.stringify(summary, null, 2) : formatSummaryText(summary));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
