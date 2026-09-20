import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8').catch(() => '');
const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8').catch(() => '');
const js = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8').catch(() => '');

test('public site contains the complete VERIFAI marketing story', () => {
  // The 18 Sep frontend consolidated the old deep-audit/report/fix anchors into
  // the product demo + workflow application shell. Keep this assertion tied to
  // the published DOM rather than obsolete prototype section IDs.
  for (const id of ['product','demo','how','workflow','security','developers']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /Start Verification/);
  assert.match(html, /Evidence-backed/);
  assert.match(html, /Know if your software actually works\./);
  assert.match(html, /Your users should not be your first real-world test\./);
});

test('frontend is wired to the real Deep Audit endpoint and live run state', () => {
  assert.match(js, /\/api\/audits/);
  assert.match(js, /fetchSwarm/);
  assert.match(js, /applySwarm/);
  assert.match(js, /\/swarm/);
  assert.match(js, /\/steer/);
  assert.match(js, /runFlagshipAudit/);
  assert.match(js, /runResult/);
  assert.match(js, /REAL SWARM/);
});

test('motion system includes scroll, connector, counter, typing, sticky and reduced-motion behavior', () => {
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /data-counter/);
  assert.match(js, /typeStatus/);
  assert.match(css, /stroke-dasharray/);
  assert.match(css, /position:\s*sticky/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@keyframes\s+cursorMove/);
});

test('responsive rules explicitly redesign mobile workflow layouts', () => {
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /\.hero-graph/);
  assert.match(css, /grid-template-columns:\s*1fr/);
  assert.match(css, /overflow-x:\s*hidden/);
});


test('Deep Audit UI is live-state driven and contains no hard-coded demo verdicts', () => {
  assert.doesNotMatch(js, /task\.state==='completed'\?'Verified'/);
  assert.match(js, /report\?\.findingState\|\|'Completed'/);
  assert.match(js, /Run Deep Audit to collect executed evidence before showing a verdict\./);
  for (const fake of [
    /my-store/,
    /Payment-provider latency/,
    /Run #482/,
    /9f712c8/,
    /3 \/ 3 failed/,
    /10 \/ 10 passed/,
    /verifiai-fix-17/,
    /github\.com\/acme\/checkout/,
  ]) {
    assert.doesNotMatch(html, fake);
    assert.doesNotMatch(js, fake);
  }
  assert.match(html, /id="drawer"/);
  assert.match(html, /id="deepStatus"/);
  assert.match(html, /id="agentList"/);
  assert.match(html, /id="feed"/);
  assert.match(html, /id="reportBody"/);
  assert.match(html, /Results appear only after the API returns executed evidence\./);
  assert.match(html, /Locked until verified/);
});
