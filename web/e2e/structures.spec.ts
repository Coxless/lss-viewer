import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../../target/release/zspace-cli', import.meta.url).pathname;
const CATALOG = new URL('../test/structures-test.json', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'zspace-structures-'));
const dataset = join(dir, 'dataset');
const VIEW = '#v=-200,-20,120,0,0.9,600';

test.beforeAll(() => {
  execFileSync(CLI, ['build', '--mock', '60000', '--seed', '3', '--out', dataset], { stdio: 'ignore' });
  execFileSync(CLI, ['import-structures', '--dataset', dataset, '--catalog', CATALOG], { stdio: 'ignore' });
});

async function open(page: Page, hash = VIEW) {
  const served: string[] = [];
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/remote/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/remote/')[1];
    served.push(name);
    route.fulfill({ status: 200, body: readFileSync(join(dataset, name)), contentType: 'application/octet-stream' });
  });
  await page.goto(`/?data=remote/${hash}`);
  await settled(page);
  return served;
}

async function settled(page: Page) {
  await page.waitForFunction(() => window.__zspace?.idle() && !window.__zspace.camera.flying, undefined, { timeout: 90_000 });
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__zspace.idle() && !window.__zspace.camera.flying, undefined, { timeout: 90_000 });
}

/** The canvas alone: the panel and the readout on top of it change with the cache. */
async function picture(page: Page) {
  const style = await page.addStyleTag({ content: 'body > *:not(#sky) { visibility: hidden !important; }' });
  const shot = await page.locator('#sky').screenshot();
  await style.evaluate((e) => (e as HTMLElement).remove());
  return shot;
}

const row = (page: Page, id: string) => page.locator(`[data-structure="${id}"]`);
const check = (page: Page, id: string) => row(page, id).locator('input[type=checkbox]');
const highlighted = (page: Page) => page.evaluate(() => window.__zspace.stats().highlighted);

test('structures: a check colours the map, names it, and fetches the density once', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const served = await open(page);

  await expect(page.locator('#structureList > li')).toHaveCount(9);
  expect(served).toContain('structures.json');
  // Nothing checked: the density grid stays on the server.
  expect(served).not.toContain('density.bin.gz');
  await expect(page.locator('#dimRow')).toBeHidden();
  const before = await picture(page);

  await check(page, 'box').check();
  await settled(page);
  expect(served.filter((f) => f === 'density.bin.gz')).toHaveLength(1);
  expect(await page.evaluate(() => window.__zspace.stats().hasDensity)).toBe(true);
  const after = await picture(page);
  expect(after.equals(before)).toBe(false);
  await expect(page.locator('.label.structure', { hasText: 'テストの壁' })).toBeVisible();
  await expect(page.locator('#dimRow')).toBeVisible();

  // The dimming slider changes the picture.
  await page.locator('#dim').fill('100');
  await settled(page);
  expect((await picture(page)).equals(after)).toBe(false);

  // A second structure does not fetch the grid again; turning all off restores the first picture.
  await check(page, 's1').check();
  await settled(page);
  expect(served.filter((f) => f === 'density.bin.gz')).toHaveLength(1);
  await check(page, 's1').uncheck();
  await check(page, 'box').uncheck();
  await settled(page);
  await expect(page.locator('.label.structure:visible')).toHaveCount(0);
  expect((await picture(page)).equals(before)).toBe(true);
  expect(errors).toEqual([]);
});

test('structures: a void is outlined and does not dim the map', async ({ page }) => {
  await open(page);
  const before = await picture(page);
  await check(page, 'hole').check();
  await settled(page);
  expect((await picture(page)).equals(before)).toBe(false);
  // A void needs its surroundings to be seen, so nothing dims and there is nothing to adjust.
  await expect(page.locator('#dimRow')).toBeHidden();
  await check(page, 's1').check();
  await expect(page.locator('#dimRow')).toBeVisible();
});

test('structures: the highlighted picture matches its reference', async ({ page }) => {
  await open(page, `${VIEW}&s=box,s3,hole`);
  await page.mouse.move(0, 0);
  await expect(page.locator('#sky')).toHaveScreenshot('structures.png', { maxDiffPixelRatio: 0.02, threshold: 0.2 });
});

test('structures: at most eight at once, and rows out of reach cannot be chosen', async ({ page }) => {
  await open(page);
  for (const id of ['box', 's1', 's2', 's3', 's4', 's5', 's6', 's7']) await check(page, id).check();
  await expect(page.locator('#sNote')).toContainText('8 個まで');
  await expect(check(page, 'hole')).toBeDisabled();
  await check(page, 's7').uncheck();
  await expect(check(page, 'hole')).toBeEnabled();
  await expect(page.locator('#sNote')).toBeHidden();

  await expect(page.locator('#structureOut > li')).toHaveCount(2);
  await expect(row(page, 'away')).toContainText('観測範囲の外です');
  await expect(row(page, 'deep')).toContainText('遠すぎます');
  await expect(row(page, 'away').locator('input')).toHaveCount(0);
  await expect(row(page, 'away').locator('.st-fly')).toHaveCount(0);
});

test('structures: the URL restores the checks and follows them', async ({ page }) => {
  await open(page, `${VIEW}&s=box,nope,away,s2`);
  // Unknown ids and structures out of reach are dropped.
  expect((await highlighted(page)).sort()).toEqual(['box', 's2']);
  await expect(check(page, 'box')).toBeChecked();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('s=box,s2');
  await check(page, 'box').uncheck();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/&s=s2$/);
  await page.evaluate((v) => { location.hash = v; }, `${VIEW}&s=s1`);
  await expect.poll(() => highlighted(page)).toEqual(['s1']);
});

test('structures: flying checks the structure, a wall as a fan and a cluster as an orbit', async ({ page }) => {
  await open(page);
  await row(page, 'box').locator('.st-fly').click();
  await settled(page);
  expect(await highlighted(page)).toEqual(['box']);
  const slab = await page.evaluate(() => window.__zspace.stats().slab);
  expect(slab?.thickness).toBe(30);
  await expect(page.locator('#slabTxt')).toHaveText('厚さ 30 Mpc/h');

  await row(page, 's1').locator('.st-fly').click();
  await settled(page);
  expect((await highlighted(page)).sort()).toEqual(['box', 's1']);
  expect(await page.evaluate(() => window.__zspace.stats().slab)).toBeNull();
  await expect(page.locator('#slabTxt')).toHaveText('オフ');
});

test('structures: the explanation opens with sources, sections fold, mock data has no list', async ({ page }) => {
  await open(page);
  const detail = row(page, 'box').locator('.st-detail');
  await expect(detail).toBeHidden();
  await row(page, 'box').locator('.st-more').click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('領域の根拠');
  await expect(detail.locator('a')).toHaveAttribute('href', 'https://example.org/');
  // Out-of-reach rows explain themselves too.
  await row(page, 'away').locator('.st-more').click();
  await expect(row(page, 'away').locator('.st-detail')).toBeVisible();

  const list = page.locator('#structureList');
  await page.locator('#structuresSec > h2').click();
  await expect(list).toBeHidden();
  await page.locator('#structuresSec > h2').press('Enter');
  await expect(list).toBeVisible();

  await page.goto('/');
  await page.waitForFunction(() => window.__zspace?.idle(), undefined, { timeout: 90_000 });
  await expect(page.locator('#structuresSec')).toBeHidden();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('flying closes the sheet', async ({ page }) => {
    await open(page);
    await page.locator('#grip').click();
    await expect(page.locator('#sheet')).not.toHaveClass(/collapsed/);
    await row(page, 's1').locator('.st-fly').click();
    await expect(page.locator('#sheet')).toHaveClass(/collapsed/);
    expect(await highlighted(page)).toEqual(['s1']);
  });
});
