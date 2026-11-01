import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../../target/release/zspace-cli', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'zspace-csv-'));

function csvOf(n: number): string {
  const path = join(tmp, `mock-${n}.csv`);
  execFileSync(CLI, ['mock', '--n', String(n), '--seed', '11', '--out', path], { stdio: 'ignore' });
  return path;
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => window.__zspace?.idle() && window.__zspace.stats().source !== null, undefined, { timeout: 90_000 });
}

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
});

test('a 300,000 row CSV is displayed within 3 seconds (U9, section 8)', async ({ page }) => {
  const path = csvOf(300_000);
  await page.goto('/');
  await waitReady(page);
  const t0 = Date.now();
  await page.setInputFiles('#csv', path);
  await page.waitForFunction(() => window.__zspace.stats().source?.startsWith('mock-'), undefined, { timeout: 60_000 });
  await page.waitForFunction(() => window.__zspace.stats().points > 0, undefined, { timeout: 60_000 });
  const ms = Date.now() - t0;
  console.log(`CSV 300k: first points after ${ms} ms`);
  await waitReady(page);
  await expect(page.locator('#srcline')).toContainText('mock-300000.csv');
  const s = await page.evaluate(() => window.__zspace.stats());
  expect(s.voids).toBeGreaterThan(0);
  expect(s.transferred).toBe(0);
  expect(ms).toBeLessThan(3000);
});

test('the threshold also works on a dataset built in the browser (U5 + U9)', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  await page.setInputFiles('#csv', csvOf(60_000));
  await page.waitForFunction(() => window.__zspace.stats().source?.startsWith('mock-'), undefined, { timeout: 60_000 });
  await waitReady(page);
  const before = await page.evaluate(() => window.__zspace.stats().gpuBytes);
  await page.locator('#thr').fill('-40');
  await page.waitForFunction((b) => window.__zspace.idle() && window.__zspace.stats().gpuBytes !== b, before, { timeout: 30_000 });
});

test('a loaded CSV opens on its own view, not the one in the URL', async ({ page }) => {
  await page.goto('/#v=-230,-20,120,0.6,0.5,77');
  await waitReady(page);
  expect(await page.evaluate(() => window.__zspace.camera.dist)).toBe(77);
  await page.setInputFiles('#csv', csvOf(20_000));
  await page.waitForFunction(() => window.__zspace.stats().source?.startsWith('mock-'), undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__zspace.camera.dist)).toBeGreaterThan(300);
});

test('bad files give a readable error', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  const noHeader = join(tmp, 'bad.csv');
  writeFileSync(noHeader, 'a,b\n1,2\n');
  await page.setInputFiles('#csv', noHeader);
  await expect(page.locator('#err')).toContainText('列見出しが見つかりません');
  const few = join(tmp, 'few.csv');
  writeFileSync(few, 'ra,dec,z\n1,2,0.05\n');
  await page.setInputFiles('#csv', few);
  await expect(page.locator('#err')).toContainText('有効な行が 1 行');
  await expect(page.locator('#veil')).toHaveCSS('pointer-events', 'none');
});
