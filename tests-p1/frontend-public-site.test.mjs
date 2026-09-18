import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8').catch(() => '');
const css = await readFile(new URL('../apps/web/styles.css', import.meta.url), 'utf8').catch(() => '');
const js = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8').catch(() => '');

test('public site contains the complete VERIFIAI marketing story', () => {
  for (const id of ['product','deep-audit','how-it-works','security','developers','live-audit','evidence','report','fix-verification','memory']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /Is your app actually ready for the real world\?/);
  assert.match(html, /Your users shouldn't be your first real-world test\./);
});

test('frontend is wired to the real Deep Audit endpoint and live run state', () => {
  assert.match(js, /\/api\/demo\/deep-audit/);
  assert.match(js, /pollLiveRun/);
  assert.match(js, /runFlagshipAudit/);
  assert.match(js, /runResult/);
  assert.match(js, /fixDiff/);
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
