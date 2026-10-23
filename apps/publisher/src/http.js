/**
 * Publisher 控制接口：把 HTTP 请求映射到采集、候选归档与发布动作。
 * 集合令牌控制 submit/publish 权限；这里不提供公开内容文件服务。
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { body, respond, identifier, requireThat } from '@webhaven/core';
import { prepareVersionInput, publishIfQualified } from './captures.js';

/**
 * 创建控制服务，调用者负责 listen 与进程生命周期。
 * 请求意图：识别集合路由 → 校验令牌及权限 → 执行动作 → 输出稳定状态或预期拒绝。
 * tokens 必须预先配置；普通异常隐藏细节，已发送响应时通过断开连接结束失败。
 */
export function createPublisherServer(archive, releasePublisher, captureQueue, tokens) {
  validateTokenConfiguration(tokens);
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz')
        return respond(response, 200, { status: 'ok' });
      const { collection, route } = parseCollectionRoute(request.url);
      requirePermission(request, tokens, collection, route === 'publish' ? 'publish' : 'submit');
      const result = await handleCollectionRequest(request, collection, route, {
        archive,
        releasePublisher,
        captureQueue,
      });
      respond(response, result.status, result.value);
    } catch (error) {
      if (!response.headersSent)
        respond(response, error.status || (error instanceof SyntaxError ? 400 : 500), {
          error:
            error.status || error instanceof SyntaxError
              ? error.message
              : 'Internal publisher error',
        });
      else response.destroy();
    }
  });
}

/** 在接收请求前验证令牌长度和集合范围，避免带着无效认证配置启动。 */
function validateTokenConfiguration(tokens) {
  requireThat(
    Array.isArray(tokens) && tokens.length > 0,
    'At least one publisher token is required',
  );
  for (const token of tokens) {
    requireThat(
      typeof token.token === 'string' && token.token.length >= 24,
      'Token must have at least 24 characters',
    );
    requireThat(
      Array.isArray(token.collections) && Array.isArray(token.permissions),
      'Invalid token scope',
    );
    token.collections.forEach(identifier);
  }
}

/** 等长令牌用常量时间比较，再检查集合与动作权限；缺少认证为 401，越权为 403。 */
function requirePermission(request, tokens, collection, permission) {
  const offered = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
  const token = tokens.find((token) => {
    const expected = Buffer.from(token.token);
    return expected.length === offered.length && timingSafeEqual(expected, offered);
  });
  requireThat(token, 'Authentication required', 401);
  requireThat(
    token.collections.includes(collection) && token.permissions.includes(permission),
    'Permission denied',
    403,
  );
}

/** 直接解析原始相对路径；集合名必须通过统一标识校验。 */
function parseCollectionRoute(requestUrl) {
  const path = decodeURIComponent(requestUrl.split('?')[0]);
  const match = path.match(/^\/v1\/collections\/([^/]+)\/(.+)$/);
  requireThat(match, 'Not found', 404);
  return { collection: identifier(match[1]), route: match[2] };
}

/** 将 head/candidates/captures/publish 映射为领域动作；返回 HTTP 状态与响应值。 */
async function handleCollectionRequest(request, collection, route, services) {
  const { archive, releasePublisher, captureQueue } = services;
  if (request.method === 'GET' && route === 'head')
    return {
      status: 200,
      value: (await releasePublisher.readPublishedRelease(collection)).record || { revision: 0 },
    };
  if (request.method === 'POST' && route === 'candidates') {
    const input = await readJsonRequest(request, 1048576);
    const prepared = await prepareVersionInput(archive, releasePublisher, collection, input);
    return { status: 201, value: await archive.beginVersion(collection, prepared) };
  }
  if (request.method === 'POST' && route === 'captures')
    return {
      status: 202,
      value: await captureQueue.startCapture(collection, await readJsonRequest(request, 1048576)),
    };
  const capture = route.match(/^captures\/([^/]+)$/);
  if (request.method === 'GET' && capture)
    return { status: 200, value: await captureQueue.readCapture(collection, capture[1]) };
  const candidate = route.match(/^candidates\/([^/]+)(?:\/(.*))?$/);
  if (candidate)
    return handleCandidateRequest(
      request,
      collection,
      identifier(candidate[1]),
      candidate[2],
      services,
    );
  if (request.method === 'POST' && route === 'publish') {
    const input = await readJsonRequest(request, 16384);
    return {
      status: 200,
      value: await releasePublisher.publishVersion(collection, identifier(input.version), input),
    };
  }
  return { status: 404, value: { error: 'Not found' } };
}

/** 候选路由只允许读取、上传已声明对象和完成；部分内容的人工批准走 publish 路由。 */
async function handleCandidateRequest(
  request,
  collection,
  version,
  action,
  { archive, releasePublisher },
) {
  if (request.method === 'GET' && !action)
    return { status: 200, value: await archive.readCandidate(collection, version) };
  const object = action?.match(/^objects\/([a-f0-9]{64})$/);
  if (request.method === 'PUT' && object) {
    await archive.storeCandidateObject(
      collection,
      version,
      object[1],
      await body(request, archive.limits.fileBytes || 20971520),
    );
    return { status: 200, value: { stored: true } };
  }
  if (request.method === 'POST' && action === 'finalize') {
    const options = await readJsonRequest(request, 16384);
    const candidate = await archive.finalizeVersion(collection, version);
    return {
      status: 200,
      value: await publishIfQualified(releasePublisher, collection, candidate, options),
    };
  }
  return { status: 404, value: { error: 'Not found' } };
}

/** 先执行请求体字节上限，再解析 JSON；语法错误由外层统一映射为 400。 */
async function readJsonRequest(request, limit) {
  return JSON.parse(await body(request, limit));
}
