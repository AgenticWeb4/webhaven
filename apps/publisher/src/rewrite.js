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
export const filename = (url, type) => `${hash(url)}.${extensions[type] || 'bin'}`;

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

export function rewriteJs(text, base, visit) {
  let imports;
  try {
    [imports] = parse(text);
  } catch {
    return text;
  }
  for (const item of imports.toReversed()) {
    if (!item.n) continue;
    // Bare module specifiers are not network URLs; retain import-map semantics.
    if (!/^(?:\.{0,2}\/|https?:\/\/)/.test(item.n)) continue;
    const replacement = reference(item.n, base, visit, 'script');
    const value = item.d >= 0 ? JSON.stringify(replacement) : replacement;
    text = text.slice(0, item.s) + value + text.slice(item.e);
  }
  return text;
}

export function rewriteHtml(text, base, visit, { archive = false } = {}) {
  const $ = load(text);
  try {
    base = normalizeUrl($('base[href]').first().attr('href') || base, base);
  } catch {
    /* Use response URL. */
  }
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
  $('style').each((_, element) => {
    try {
      $(element).text(rewriteCss($(element).text(), base, visit));
    } catch {
      /* Keep malformed source CSS. */
    }
  });
  $('[style]').each((_, element) => {
    const node = $(element);
    node.attr('style', cssValue(node.attr('style'), base, visit));
  });
  $('script[type="module"]:not([src])').each((_, element) => {
    $(element).text(rewriteJs($(element).text(), base, visit));
  });
  if (archive) {
    $('base, meta[http-equiv="Content-Security-Policy"], meta[http-equiv="refresh"]').remove();
    $('[integrity]').removeAttr('integrity');
    $('[crossorigin]').removeAttr('crossorigin');
  }
  return $.html();
}

export function transform(body, type, base, visit, options) {
  if (type === 'text/html' || type === 'application/xhtml+xml')
    return Buffer.from(rewriteHtml(body.toString(), base, visit, options));
  if (type === 'text/css') return Buffer.from(rewriteCss(body.toString(), base, visit));
  if (type.includes('javascript')) return Buffer.from(rewriteJs(body.toString(), base, visit));
  return body;
}
