/**
 * 资源引用转换：HTML、CSS、ES 模块共用 visit(url, kind) 回调。
 * 发现阶段回调返回空值，仅枚举依赖；归档阶段返回相对路径，生成可本地访问的字节。
 */
import { load } from 'cheerio';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import parseSrcset from 'parse-srcset';
import { init, parse } from 'es-module-lexer';
import { hash, normalizeUrl } from './urls.js';

await init;
const extensions = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'application/wasm': 'wasm',
  'text/plain': 'txt',
};
/** 使用完整 URL 摘要避免同名资源碰撞；扩展名只取决于已知 MIME 类型。 */
export const filename = (url, type) => `${hash(url)}.${extensions[type] || 'bin'}`;

/** 统一解析资源身份、保留原片段；内联协议及不可解析引用原样保留，由后续验收记录可见缺口。 */
function reference(value, base, visit, kind) {
  if (!value || /^(?:data:|blob:|#|javascript:|mailto:|tel:)/i.test(value.trim())) return value;
  try {
    const original = new URL(value, base);
    const replacement = visit(normalizeUrl(value, base), kind);
    return replacement ? replacement + original.hash : value;
  } catch {
    return value;
  }
}

/** 通过语法树改写 url() 参数，保留其余 CSS 值结构，避免正则破坏嵌套表达式。 */
function cssValue(value, base, visit) {
  const tree = valueParser(value);
  tree.walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const child = node.nodes.find((part) => part.type === 'string' || part.type === 'word');
    if (child) child.value = reference(child.value, base, visit, 'asset');
    return false;
  });
  return tree.toString();
}

/** 先处理声明中的 url()，再处理 @import 的字符串或 url()，返回重建的 CSS。 */
export function rewriteCss(text, base, visit) {
  const tree = postcss.parse(text, { from: undefined, map: false });
  tree.walkDecls((decl) => {
    decl.value = cssValue(decl.value, base, visit);
  });
  tree.walkAtRules('import', (rule) => {
    const value = valueParser(rule.params);
    const first = value.nodes[0];
    if (first?.type === 'string') first.value = reference(first.value, base, visit, 'stylesheet');
    rule.params = cssValue(value.toString(), base, visit);
  });
  return tree.toString();
}

/**
 * 意图：只改写能够静态识别的网络模块引用。
 * 步骤：解析导入区间 → 从后向前替换 → 保留裸模块名与不可解析源码。
 * 逆序编辑可保持前方字符偏移有效；动态导入的替换值须带字符串引号。
 */
export function rewriteJs(text, base, visit) {
  let imports;
  try {
    [imports] = parse(text);
  } catch {
    return text;
  }
  for (const item of imports.toReversed()) {
    if (!item.n) continue;
    // 裸模块名依赖 import map 等解析规则，不作为网络地址强行替换。
    if (!/^(?:\.{0,2}\/|https?:\/\/)/.test(item.n)) continue;
    const replacement = reference(item.n, base, visit, 'script');
    const value = item.d >= 0 ? JSON.stringify(replacement) : replacement;
    text = text.slice(0, item.s) + value + text.slice(item.e);
  }
  return text;
}

/**
 * 意图：保留页面结构，将可观察资源交给统一引用回调处理。
 * 步骤：确定基准 URL → 普通属性 → 候选图片 → 内嵌 CSS/模块 → 清理归档冲突项。
 * archive 模式移除原 CSP、跳转、base 及失效完整性属性；这不等于清除任意脚本行为。
 */
export function rewriteHtml(text, base, visit, { archive = false } = {}) {
  const $ = load(text);
  try {
    base = normalizeUrl($('base[href]').first().attr('href') || base, base);
  } catch {
    /* base 无效时继续使用响应 URL。 */
  }
  // 意图一：按链接用途区分页面导航、脚本、样式和其他资源。
  for (const element of $('[src], [href], [poster], [data-src]').toArray()) {
    const tag = element.tagName;
    const node = $(element);
    const rel = (node.attr('rel') || '').toLowerCase();
    if (tag === 'base' || (tag === 'link' && /dns-prefetch|preconnect/.test(rel))) continue;
    const kind =
      tag === 'a'
        ? 'page'
        : tag === 'script'
          ? 'script'
          : tag === 'link' && rel.includes('stylesheet')
            ? 'stylesheet'
            : 'asset';
    for (const attr of ['src', 'href', 'poster', 'data-src']) {
      if (node.attr(attr)) node.attr(attr, reference(node.attr(attr), base, visit, kind));
    }
  }
  // 意图二：分别处理每个图片候选，保留宽度或像素密度描述。
  $('[srcset], [data-srcset]').each((_, element) => {
    const node = $(element);
    for (const attr of ['srcset', 'data-srcset']) {
      if (!node.attr(attr)) continue;
      const candidates = parseSrcset(node.attr(attr));
      node.attr(
        attr,
        candidates
          .map(
            (part) =>
              reference(part.url, base, visit, 'asset') +
              (part.w ? ` ${part.w}w` : part.d ? ` ${part.d}x` : ''),
          )
          .join(', '),
      );
    }
  });
  // 意图三：页面内部样式与模块也可能引用外部资源，复用相同解析规则。
  $('style').each((_, element) => {
    try {
      $(element).text(rewriteCss($(element).text(), base, visit));
    } catch {
      /* 内嵌 CSS 无法解析时保留源码，后续依赖验收仍可报告可见缺口。 */
    }
  });
  $('[style]').each((_, element) => {
    const node = $(element);
    node.attr('style', cssValue(node.attr('style'), base, visit));
  });
  $('script[type="module"]:not([src])').each((_, element) => {
    $(element).text(rewriteJs($(element).text(), base, visit));
  });
  // 意图四：原站策略和完整性值对应原始字节，转换后需要由 Mirror 的响应策略接管。
  if (archive) {
    $('base, meta[http-equiv="Content-Security-Policy"], meta[http-equiv="refresh"]').remove();
    $('[integrity]').removeAttr('integrity');
    $('[crossorigin]').removeAttr('crossorigin');
  }
  return $.html();
}

/** 按 MIME 类型选择解析器并返回 Buffer；未知类型保持原字节，不做猜测性重写。 */
export function transform(body, type, base, visit, options) {
  if (type === 'text/html' || type === 'application/xhtml+xml')
    return Buffer.from(rewriteHtml(body.toString(), base, visit, options));
  if (type === 'text/css') return Buffer.from(rewriteCss(body.toString(), base, visit));
  if (type.includes('javascript')) return Buffer.from(rewriteJs(body.toString(), base, visit));
  return body;
}
