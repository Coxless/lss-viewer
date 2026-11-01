import { expect, test } from '@playwright/test';

// Section 8: within 2 seconds on 4G. Chrome's "Fast 4G" preset: 9 Mbit/s down, 60 ms latency.
test('first display on 4G takes under 2 seconds', async ({ page, context }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__lssViewer?.stats().firstDraw !== null, undefined, { timeout: 60_000 });
  const f = await page.evaluate(() => window.__lssViewer.stats().firstDraw!);
  console.log(`first display on 4G: ${f.ms} ms, ${(f.bytes / 1024).toFixed(0)} KB of data`);
  expect(f.ms).toBeLessThan(2000);
  expect(f.bytes).toBeLessThan(1_000_000);
});
