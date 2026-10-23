/**
 * 浏览器采集适配：记录公开静态响应与最终 DOM，结果交回统一归档流程。
 * 页面请求过滤属于应用约束，部署层仍需限制网络访问；这里不是完整浏览器沙箱。
 */
import { requireThat } from '@webhaven/core';
import { normalizeUrl, validateTarget } from './urls.js';

/**
 * 意图：保留浏览器最终看到的页面及其观察到的公开资源。
 * 步骤：安装请求过滤 → 收集受限响应 → 等待页面稳定 → 等待当前记录任务 → 保存最终 DOM。
 * options 提供资源工作集、限额和结果回调；返回前关闭浏览器，缺口通过回调记录。
 */
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

/** 仅放行通过目标检查的 GET/HEAD；阻止主动数据接口、媒体等未支持的请求类型。 */
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

/** 跳过明确私有或禁止缓存的响应，检查单资源体积后交回采集工作集。 */
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

/** 要求最终正文可读，再用最终 DOM 替换入口；该检查无法识别所有访问挑战。 */
async function recordFinalDom(page, { url, recordResource }) {
  requireThat(
    (await page.locator('body').innerText()).trim().length >= 20,
    'No readable final page; possible access challenge',
    422,
  );
  // 访问挑战与真实页面可能共用 URL，因此保留最终 DOM，而不是最早收到的页面。
  recordResource({
    url,
    finalUrl: normalizeUrl(page.url()),
    type: 'text/html',
    body: Buffer.from(await page.content()),
  });
}
