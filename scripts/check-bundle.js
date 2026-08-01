#!/usr/bin/env node
/**
 * Build-time bundle guard. (FSR-46 + FSR-103)
 *
 * The deployable bundles (datalyr-v2/infra/tracking/dl.dev.js, dl.js, dl.min.js) are
 * a hand-maintained concatenation of the rollup dist + the script-tag bootstrap that
 * auto-inits `data-workspace-id` installs. On 2026-05-26 a `cp dist over dl.dev.js`
 * dropped that bootstrap and took customer tracking down for hours; it recurred as a
 * near-miss on 2026-05-30. The build had NO automated check — a bootstrap-less input
 * produced bootstrap-less production bundles silently.
 *
 * This script fails hard (exit 1) unless every target bundle contains BOTH:
 *   1. the `data-workspace-id` script-tag bootstrap, AND
 *   2. a current feature literal (`checkoutChampDomains`) — proves the bundle is built
 *      from current source, not a stale concatenation,
 * and unless the bundle's `sdk_version` matches package.json "version" (FSR-103 drift).
 *
 * Usage:
 *   node scripts/check-bundle.js [bundle ...]
 * With no args it checks the three public bundles relative to this package.
 */

const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);
const expectedVersion = pkg.version;

// Markers every healthy bundle must contain.
const REQUIRED_MARKERS = [
  'data-workspace-id',    // the script-tag bootstrap (the 2026-05-26 outage marker)
  'checkoutChampDomains', // a current feature literal — proves it's built from current src
  'buy.stripe.com',       // D1 Stripe Payment Link auto-decoration (1.7.4+)
  'dl_kprofile_id',       // Klaviyo deterministic profile binding (1.7.8+)
  'dl_ksource',           // additive Klaviyo source authority (1.7.10+)
  'dl_kmessage_id'        // additive Klaviyo message join (1.7.10+)
];

// Default targets: the LIVE deployable bundles in the sibling
// datalyr-v2/infra/tracking (the R2/track.datalyr.com source of truth).
// 9.A.3: these used to point at datalyr-app/public — datalyr-app was deprecated and
// its infra consolidated into datalyr-v2 on 2026-06-26, so the guard was validating
// a stale copy while the bundles that actually deploy went unchecked.
const DEFAULT_TARGETS = [
  path.resolve(__dirname, '..', '..', '..', 'datalyr-v2', 'infra', 'tracking', 'dl.dev.js'),
  path.resolve(__dirname, '..', '..', '..', 'datalyr-v2', 'infra', 'tracking', 'dl.js'),
  path.resolve(__dirname, '..', '..', '..', 'datalyr-v2', 'infra', 'tracking', 'dl.min.js'),
];

const targets = process.argv.slice(2);
const files = targets.length > 0 ? targets : DEFAULT_TARGETS;

let failures = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${file} — NOT FOUND`);
    failures++;
    continue;
  }

  const content = fs.readFileSync(file, 'utf8');
  const problems = [];

  for (const marker of REQUIRED_MARKERS) {
    if (!content.includes(marker)) {
      problems.push(`missing required marker "${marker}"`);
    }
  }

  // sdk_version must match package.json (handles `sdk_version: "x"` and minified
  // `sdk_version:"x"`).
  const versionMatch = content.match(/sdk_version\s*[:=]\s*["']([^"']+)["']/);
  if (!versionMatch) {
    problems.push('no sdk_version literal found');
  } else if (versionMatch[1] !== expectedVersion) {
    problems.push(`sdk_version "${versionMatch[1]}" !== package.json "${expectedVersion}"`);
  }

  if (problems.length > 0) {
    console.error(`✗ ${path.basename(file)} — ${problems.join('; ')}`);
    failures++;
  } else {
    console.log(`✓ ${path.basename(file)} — bootstrap present, sdk_version ${expectedVersion}`);
  }
}

if (failures > 0) {
  console.error(`\nBundle guard FAILED for ${failures} file(s). Do NOT deploy.`);
  console.error('If dl.dev.js lost the bootstrap, restore it (do NOT cp dist over dl.dev.js).');
  process.exit(1);
}

console.log(`\nBundle guard passed for ${files.length} file(s).`);
