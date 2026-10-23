import { requireThat } from '@webhaven/core';
import { normalizeUrl, validateTarget } from './urls.js';

export async function captureRenderedPage(options) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pendingResponses = new Set();
    await page.route('**/*', allowPublicReadRequest);
    page.on('response', (response) => {
      if (response.status() !== 200) return;
      const url = normalizeUrl(response.url());
      if (
        options.resources.has(url) ||
        pendingResponses.size + options.resources.size >= options.maxResources
      )
        return;
      const recording = recordPublicResponse(response, options).catch((error) =>
        options.reportIssue({ url, error: error.message }),
      );
      pendingResponses.add(recording);
      recording.finally(() => pendingResponses.delete(recording));
    });
    await page.goto(options.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(500);
    await Promise.allSettled([...pendingResponses]);
    await recordFinalDom(page, options);
  } finally {
    await browser.close();
  }
}

async function allowPublicReadRequest(route) {
  try {
    const request = route.request();
    const unsupportedType = ['xhr', 'fetch', 'media', 'websocket', 'eventsource'].includes(
      request.resourceType(),
    );
    if (!['GET', 'HEAD'].includes(request.method()) || unsupportedType) return await route.abort();
    await validateTarget(request.url());
    await route.continue();
  } catch {
    await route.abort();
  }
}

async function recordPublicResponse(response, { maxFileBytes, recordResource }) {
  const headers = await response.allHeaders();
  if (/\b(private|no-store)\b/i.test(headers['cache-control'] || '')) return;
  const bytes = await response.body();
  requireThat(bytes.length <= maxFileBytes, 'Browser asset too large', 413);
  const url = normalizeUrl(response.url());
  recordResource({
    url,
    finalUrl: url,
    body: bytes,
    type: (headers['content-type'] || 'application/octet-stream').split(';')[0],
  });
}

async function recordFinalDom(page, { url, recordResource }) {
  requireThat(
    (await page.locator('body').innerText()).trim().length >= 20,
    'No readable final page; possible access challenge',
    422,
  );
  // A challenge can use the same URL as the real page. Keep the final DOM, not the first response.
  recordResource({
    url,
    finalUrl: normalizeUrl(page.url()),
    type: 'text/html',
    body: Buffer.from(await page.content()),
  });
}
