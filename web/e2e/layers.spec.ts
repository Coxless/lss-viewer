import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../../target/release/zspace-cli', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'zspace-layers-'));
const dataset = join(dir, 'dataset');

// A small dataset with a VAST-format catalog. Served without Range support on purpose.
test.beforeAll(() => {
  execFileSync(CLI, ['build', '--mock', '40000', '--seed', '3', '--out', dataset], { stdio: 'ignore' });
  const voids = JSON.parse(readFileSync(join(dataset, 'voids.json'), 'utf8')) as { center: number[]; radius: number }[];
  const holes = ['# x y z radius void'];
  const maximal = ['# x y z radius void edge r ra dec Reff'];
  voids.slice(0, 6).forEach((v, i) => {
    holes.push(`${v.center.join(' ')} ${v.radius} ${i}`);
    maximal.push(`${v.center.join(' ')} ${v.radius} ${i} 0 1 1 1 ${v.radius + 1}`);
  });
  writeFileSync(join(dir, 'h.txt'), holes.join('\n'));
  writeFileSync(join(dir, 'm.txt'), maximal.join('\n'));
  execFileSync(CLI, ['import-vast', '--dataset', dataset, '--holes', join(dir, 'h.txt'), '--maximal', join(dir, 'm.txt'), '--name', 'ボイド（VAST）'], { stdio: 'ignore' });
});

test('layers: VAST list first, its surface on demand, and no Range support is survivable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const served: string[] = [];
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/remote/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/remote/')[1];
    served.push(name);
    route.fulfill({ status: 200, body: readFileSync(join(dataset, name)), contentType: 'application/octet-stream' });
  });
  await page.goto('/?data=remote/');
  await page.waitForFunction(() => window.__zspace?.idle() && window.__zspace.stats().voids > 0, undefined, { timeout: 60_000 });

  expect(await page.evaluate(() => window.__zspace.stats().points)).toBeGreaterThan(1000);
  expect(served).not.toContain('shells-vast.bin.gz');
  await expect(page.locator('#vCount')).toHaveText('6 個');
  await expect(page.locator('#vMethod')).toHaveText('検出方法：VAST VoidFinder');
  await expect(page.locator('#listName')).toHaveText('ボイド（VAST）');

  // Layer names come from the metadata.
  const rows = page.locator('#layers .layer');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('ボイド');
  await expect(rows.nth(1)).toContainText('ボイド（VAST）');
  await rows.nth(1).locator('input[type=checkbox]').check();
  await expect.poll(() => served.includes('shells-vast.bin.gz')).toBe(true);

  await page.locator('#listChoice button', { hasText: '簡易検出' }).click();
  await expect(page.locator('#vMethod')).toHaveText('検出方法：簡易検出');
  await expect.poll(async () => Number((await page.locator('#vCount').textContent())!.split(' ')[0])).toBeGreaterThan(6);
  expect(errors).toEqual([]);
});

test('a missing dataset gives a readable error', async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto('/?data=nowhere/');
  await expect(page.locator('#err')).toContainText('metadata.json を取得できません');
});
