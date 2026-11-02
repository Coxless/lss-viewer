import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __lssViewer: {
      idle(): boolean;
      stats(): {
        points: number; nodes: number; cached: number; cachedPoints: number; transferred: number; gpuBytes: number;
        firstDraw: { ms: number; bytes: number } | null; frame: number; budget: number; voids: number; source: string | null;
        threshold: number; selected: number; listId: string | null;
        slab: { normal: number[]; center: number[]; thickness: number } | null; layersOn: Record<string, boolean>;
        highlighted: string[]; hasDensity: boolean;
      };
      camera: { dist: number; flying: boolean; target: number[] };
      bench: { frames: number; fps: number; fpsLow: number; avgPoints: number; transferredMB: number; budget: number } | null;
    };
  }
}

const VIEW = '#v=-230,-20,120,0.6,0.5,700';

async function settled(page: Page) {
  await page.waitForFunction(() => window.__lssViewer?.idle(), undefined, { timeout: 90_000 });
  // Wait until the state stays idle across a few frames.
  await page.waitForTimeout(250);
  await page.waitForFunction(() => window.__lssViewer.idle() && !window.__lssViewer.camera.flying, undefined, { timeout: 90_000 });
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  // Fonts and the visitor counter come from the network; tests must not depend on them.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route(/gc\.zgo\.at/, (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
});

test('loads the dataset, draws, and stops drawing when still (U8, 7.4)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await settled(page);
  const s = await page.evaluate(() => window.__lssViewer.stats());
  expect(s.points).toBeGreaterThan(1000);
  expect(s.voids).toBeGreaterThan(5);
  expect(s.firstDraw).not.toBeNull();
  await expect(page.locator('#srcline')).toContainText('模擬カタログ');
  await expect(page.locator('#veil')).toHaveCSS('pointer-events', 'none');
  const a = s.frame;
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.__lssViewer.stats())).frame).toBe(a);
  expect(errors).toEqual([]);
});

test('first display is under 1 MB (section 8)', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const s = await page.evaluate(() => window.__lssViewer.stats());
  console.log(`first display: ${s.firstDraw!.ms} ms, ${(s.firstDraw!.bytes / 1024).toFixed(0)} KB`);
  expect(s.firstDraw!.bytes).toBeLessThan(1_000_000);
});

test('tiles come through HTTP Range', async ({ page }) => {
  const seen: { status: number; range: string | undefined }[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('points.bin')) seen.push({ status: r.status(), range: r.request().headers().range });
  });
  await page.goto(`/${VIEW}`);
  await settled(page);
  expect(seen.length).toBeGreaterThan(1);
  for (const s of seen) {
    expect(s.status).toBe(206);
    expect(s.range).toMatch(/^bytes=\d+-\d+$/);
  }
});

test('density is not fetched until the threshold moves, then the surface and list update (U5)', async ({ page }) => {
  const errors = collectErrors(page);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/');
  await settled(page);
  expect(requests.some((u) => u.includes('density'))).toBe(false);
  expect(requests.some((u) => u.endsWith('.wasm'))).toBe(false);

  const before = await page.evaluate(() => window.__lssViewer.stats().gpuBytes);
  await page.locator('#thr').fill('-45');
  await expect(page.locator('#thrTxt')).toHaveText('δ = −0.45');
  await settled(page);
  expect(requests.some((u) => u.includes('density'))).toBe(true);
  await expect(page.locator('#thrStatus')).toHaveText('');
  const after = await page.evaluate(() => window.__lssViewer.stats());
  expect(after.gpuBytes).not.toBe(before);
  expect(after.voids).toBeGreaterThan(0);

  await page.locator('#thr').fill('-70');
  await expect(page.locator('#thrTxt')).toHaveText('δ = −0.70');
  await settled(page);
  expect(requests.filter((u) => u.includes('density')).length).toBe(1);
  expect(errors).toEqual([]);
});

test('moving the threshold with the layer off turns it on and ticks its box (U5)', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  const box = page.locator('#layers .layer').first().locator('input[type=checkbox]');
  await box.uncheck();
  await settled(page);
  expect((await page.evaluate(() => window.__lssViewer.stats())).layersOn.voids).toBe(false);
  await page.locator('#thr').fill('-50');
  await expect(box).toBeChecked();
  await settled(page);
  expect((await page.evaluate(() => window.__lssViewer.stats())).layersOn.voids).toBe(true);
});

test('the threshold sits inside the layer it changes', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#layers .layer').first().locator('#thr')).toHaveCount(1);
});

test('the fan button cuts through the observer and looks straight at the slab (U4)', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.click('#slabFan');
  await expect(page.locator('#slabTxt')).toHaveText('厚さ 23 Mpc/h');
  await settled(page);
  const r = await page.evaluate(() => {
    const c = window.__lssViewer.camera as unknown as { eye(): number[]; target: number[] };
    return { slab: window.__lssViewer.stats().slab!, eye: c.eye(), target: c.target };
  });
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // The plane contains the observer at the origin.
  expect(Math.abs(dot(r.slab.normal, r.slab.center))).toBeLessThan(1e-6);
  // The camera looks along the normal, within the pitch limit.
  const view = [r.eye[0] - r.target[0], r.eye[1] - r.target[1], r.eye[2] - r.target[2]];
  const cos = dot(view, r.slab.normal) / Math.hypot(view[0], view[1], view[2]);
  expect(cos).toBeGreaterThan(0.99);
});

test('using the panel dismisses the hint', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#hint')).toHaveCSS('opacity', '1');
  await page.click('#home');
  await expect(page.locator('#hint')).toHaveCSS('opacity', '0');
});

test('no survey note for a survey that fills its box', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#surveyNote')).toBeHidden();
});

test('display modes change what is drawn (U2)', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  const auto = (await page.evaluate(() => window.__lssViewer.stats())).points;
  expect(auto).toBeGreaterThan(0);
  await page.click('#mShell');
  await settled(page);
  expect((await page.evaluate(() => window.__lssViewer.stats())).points).toBe(0);
  await page.click('#mGal');
  await settled(page);
  expect((await page.evaluate(() => window.__lssViewer.stats())).points).toBeGreaterThanOrEqual(auto);
});

test('zooming in shows more galaxies than the far view (U2)', async ({ page }) => {
  await page.goto('/#v=-230,-20,120,0.6,0.5,900');
  await settled(page);
  const far = (await page.evaluate(() => window.__lssViewer.stats())).points;
  await page.goto('/#v=-230,-20,120,0.6,0.5,120');
  await page.reload();
  await settled(page);
  const near = (await page.evaluate(() => window.__lssViewer.stats())).points;
  expect(near).toBeGreaterThan(far);
});

test('next void flies inside it and marks it (U3)', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await page.click('#nextVoid');
  await expect(page.locator('#voidList button[aria-current="true"]')).toHaveCount(1);
  await settled(page);
  const s = await page.evaluate(() => ({ dist: window.__lssViewer.camera.dist, sel: window.__lssViewer.stats().selected }));
  expect(s.sel).toBe(0);
  expect(s.dist).toBeLessThan(60);
  await expect(page.locator('.label.void')).toContainText('いま内部');
});

test('slice reduces the galaxies and its controls work (U4)', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  await page.click('#mGal');
  await settled(page);
  const all = (await page.evaluate(() => window.__lssViewer.stats())).nodes;
  await page.locator('#slab').fill('20');
  await expect(page.locator('#slabTxt')).toHaveText(/厚さ \d+ Mpc\/h/);
  await settled(page);
  expect((await page.evaluate(() => window.__lssViewer.stats())).nodes).toBeLessThan(all);
  await page.locator('#slab').fill('0');
  await expect(page.locator('#slabTxt')).toHaveText('オフ');
  await page.click('#slabAlign');
  await expect(page.locator('#slabTxt')).toHaveText(/厚さ/);
});

test('frame, observer label and scale bar are shown (U6, U7)', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('.label.me')).toHaveText('天の川銀河（私たち）');
  await expect(page.locator('.label', { hasText: 'z≈' }).first()).toBeVisible();
  await expect(page.locator('#scaleTxt')).toContainText('Mpc/h ≈');
  await page.uncheck('#showFrame');
  await settled(page);
  await expect(page.locator('.label:not([hidden])', { hasText: 'z≈' })).toHaveCount(0);
});

test('point budget switch (U10)', async ({ page }) => {
  await page.goto(`/?budget=0#v=-230,-20,120,0.6,0.5,250`);
  await settled(page);
  await page.click('#mGal');
  await settled(page);
  const standard = await page.evaluate(() => window.__lssViewer.stats());
  expect(standard.points).toBeLessThanOrEqual(400_000);
  await page.click('#q1');
  await settled(page);
  const light = await page.evaluate(() => window.__lssViewer.stats());
  expect(light.budget).toBe(150_000);
  expect(light.points).toBeLessThanOrEqual(150_000);
  await page.click('#q3');
  await settled(page);
  const high = await page.evaluate(() => window.__lssViewer.stats());
  expect(high.budget).toBe(1_000_000);
  expect(high.points).toBeGreaterThanOrEqual(light.points);
});

test('LRU keeps the GPU within budget x 2.2 (7.3)', async ({ page }) => {
  await page.goto(`/?budget=50000#v=-230,-20,120,0.6,0.5,200`);
  await settled(page);
  const stops = ['-400,100,60', '-100,250,300', '-300,-200,200', '-50,50,50', '-350,300,350'];
  for (const c of stops) {
    await page.evaluate((v) => { location.hash = v; }, `#v=${c},0.3,0.5,150`);
    await settled(page);
  }
  const s = await page.evaluate(() => window.__lssViewer.stats());
  expect(s.cachedPoints).toBeLessThanOrEqual(50_000 * 2.2 + 4096 * 8);
});

test('the URL hash holds the view and restores it (7.5)', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  expect(await page.evaluate(() => window.__lssViewer.camera.dist)).toBe(700);
  await page.locator('#sky').hover();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(700);
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toMatch(/^#v=/);
  const dist = await page.evaluate(() => window.__lssViewer.camera.dist);
  expect(dist).toBeGreaterThan(700);
  await page.reload();
  await settled(page);
  expect(await page.evaluate(() => window.__lssViewer.camera.dist)).toBeCloseTo(dist, 1);
});

test('drag rotates and right drag pans (U1)', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  const read = () => page.evaluate(() => {
    const c = window.__lssViewer.camera as unknown as { yaw: number; target: number[] };
    return { yaw: c.yaw, target: [...c.target] };
  });
  const a = await read();
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(460, 420);
  await page.mouse.up();
  const b = await read();
  expect(b.yaw).not.toBe(a.yaw);
  expect(b.target).toEqual(a.target);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(500, 460);
  await page.mouse.up({ button: 'right' });
  expect((await read()).target).not.toEqual(a.target);
});

test('fixed view matches its reference image (mesh and points)', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  await page.addStyleTag({ content: '.hud,.sheet,.hint,.scale,#labels{display:none!important}' });
  await expect(page.locator('#sky')).toHaveScreenshot('home.png', { maxDiffPixelRatio: 0.02, threshold: 0.2 });
});

test('fixed view, mesh only, matches its reference image', async ({ page }) => {
  await page.goto(`/${VIEW}`);
  await settled(page);
  await page.click('#mShell');
  await settled(page);
  await page.addStyleTag({ content: '.hud,.sheet,.hint,.scale,#labels{display:none!important}' });
  await expect(page.locator('#sky')).toHaveScreenshot('shell.png', { maxDiffPixelRatio: 0.02, threshold: 0.2 });
});

test('?bench=1 plays the camera path and reports the numbers (section 11)', async ({ page }) => {
  await page.goto('/?bench=1&seconds=3&budget=150000');
  await page.waitForFunction(() => window.__lssViewer?.bench !== null, undefined, { timeout: 60_000 });
  const b = await page.evaluate(() => window.__lssViewer.bench!);
  console.log(`bench (software rendering): ${JSON.stringify(b)}`);
  expect(b.frames).toBeGreaterThan(0);
  expect(b.avgPoints).toBeGreaterThan(0);
  expect(b.budget).toBe(150_000);
  expect(b.transferredMB).toBeGreaterThan(0);
  await expect(page.locator('#benchOut')).toContainText('"fps"');
});

test('credits match the data', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.locator('#creditMock')).toBeAttached();
  expect(await page.locator('#creditMock').isHidden()).toBe(false);
  expect(await page.locator('#creditSdss').isHidden()).toBe(true);
  expect(await page.locator('#creditVast').isHidden()).toBe(true);
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });

  test('uses the bottom sheet and the phone budget (7.5, U10)', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    const sheet = page.locator('#sheet');
    await expect(sheet).toHaveClass(/collapsed/);
    await expect(page.locator('#nextVoid')).toBeVisible();
    await expect(page.locator('#slab')).toBeHidden();
    await page.click('#grip');
    await expect(page.locator('#slab')).toBeVisible();
    await page.click('#grip');
    await expect(page.locator('#q2')).toHaveText('標準 25万');
    const s = await page.evaluate(() => ({ b: window.__lssViewer.stats().budget, w: document.documentElement.scrollWidth }));
    expect(s.b).toBe(250_000);
    expect(s.w).toBeLessThanOrEqual(390);
  });

  test('the fan button closes the sheet so the view can be seen', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await page.click('#grip');
    await page.click('#slabFan');
    await expect(page.locator('#sheet')).toHaveClass(/collapsed/);
    await expect(page.locator('#slabTxt')).toBeHidden();
  });
});
