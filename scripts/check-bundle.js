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
 * Session replay (1.8.0): no bundle checked here may contain rrweb (the recorder is
 * the separate dl.replay.<v>.js, loaded on demand), and with --dist the freshly built
 * dist/datalyr.min.js + dist/datalyr.replay.min.js are checked too, with the replay
 * bundle's size reported.
 *
 * Usage:
 *   node scripts/check-bundle.js [bundle ...]
 *   node scripts/check-bundle.js --dist     (this package's dist/ after `npm run build`)
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

// rrweb fingerprints: rrweb's own serialized attribute names and its public API names.
// None of them may appear in dl.js; the replay bundle must contain them.
const RRWEB_MARKERS = ['rr_dataURL', 'rr_mediaState', 'takeFullSnapshot', 'addCustomEvent'];
// Heat mode (1.9.0): its snapshot serializer (rrweb-snapshot) and click capture must also
// stay out of dl.js; the replay bundle must carry them.
const HEAT_MARKERS = ['mode=heat', 'y_pct_max'];
const MAX_REPLAY_GZIP_BYTES = 40 * 1024; // measured 1.8.0: ~28 KB gz; 1.9.0 (+ rrweb-snapshot for heat mode): ~37 KB gz

const args = process.argv.slice(2);
const distMode = args.includes('--dist');
const targets = args.filter(a => a !== '--dist');
const distDir = path.resolve(__dirname, '..', 'dist');
const files = distMode
  ? [path.join(distDir, 'datalyr.min.js'), ...targets]
  : (targets.length > 0 ? targets : DEFAULT_TARGETS);
// dist/datalyr.min.js is the raw rollup output: the script-tag bootstrap is only
// concatenated in by datalyr-v2's tracking build, so it is not required there.
const bootstrapOptional = new Set(distMode ? [path.join(distDir, 'datalyr.min.js')] : []);

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
    if (marker === 'data-workspace-id' && bootstrapOptional.has(file)) continue;
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

  const rrweb = RRWEB_MARKERS.concat(HEAT_MARKERS).filter(m => content.includes(m));
  if (rrweb.length > 0) {
    problems.push(`contains rrweb code (${rrweb.join(', ')}) — the recorder must stay in dl.replay.<v>.js`);
  }

  if (problems.length > 0) {
    console.error(`✗ ${path.basename(file)} — ${problems.join('; ')}`);
    failures++;
  } else {
    console.log(`✓ ${path.basename(file)} — ${bootstrapOptional.has(file) ? 'markers present' : 'bootstrap present'}, sdk_version ${expectedVersion}, no rrweb`);
  }
}

if (distMode) {
  const replayFile = path.join(distDir, 'datalyr.replay.min.js');
  if (!fs.existsSync(replayFile)) {
    console.error(`✗ ${replayFile} — NOT FOUND`);
    failures++;
  } else {
    const content = fs.readFileSync(replayFile, 'utf8');
    const problems = [];
    const versionMatch = content.match(/replay_version\s*[:=]\s*["']([^"']+)["']/);
    if (!versionMatch) problems.push('no replay_version literal found');
    else if (versionMatch[1] !== expectedVersion) problems.push(`replay_version "${versionMatch[1]}" !== package.json "${expectedVersion}"`);
    const missing = RRWEB_MARKERS.concat(HEAT_MARKERS).filter(m => !content.includes(m));
    if (missing.length > 0) problems.push(`rrweb markers missing (${missing.join(', ')})`);
    const raw = Buffer.byteLength(content);
    const gz = require('zlib').gzipSync(content, { level: 9 }).length;
    if (gz > MAX_REPLAY_GZIP_BYTES) problems.push(`gzip ${gz} B > ${MAX_REPLAY_GZIP_BYTES} B budget`);
    if (problems.length > 0) {
      console.error(`✗ ${path.basename(replayFile)} — ${problems.join('; ')}`);
      failures++;
    } else {
      console.log(`✓ ${path.basename(replayFile)} — replay_version ${expectedVersion}, ${raw} B min / ${gz} B gzip`);
    }
    const dl = path.join(distDir, 'datalyr.min.js');
    if (fs.existsSync(dl)) {
      const dlContent = fs.readFileSync(dl);
      console.log(`  datalyr.min.js — ${dlContent.length} B min / ${require('zlib').gzipSync(dlContent, { level: 9 }).length} B gzip`);
    }
  }
}

if (failures > 0) {
  console.error(`\nBundle guard FAILED for ${failures} file(s). Do NOT deploy.`);
  console.error('If dl.dev.js lost the bootstrap, restore it (do NOT cp dist over dl.dev.js).');
  process.exit(1);
}

console.log(`\nBundle guard passed for ${files.length + (distMode ? 1 : 0)} file(s).`);
