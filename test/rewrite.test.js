import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCss, rewriteHtml, rewriteJs } from '../apps/publisher/src/rewrite.js';

const mapped = (url) => `/local/${new URL(url).pathname.split('/').at(-1)}`;
test('HTML resolves base URLs, CSS, srcset and strips integrity/CSP for transformed archives', () => {
  const html = rewriteHtml(
    `<base href="https://cdn.example.com/v1/"><meta http-equiv="Content-Security-Policy" content="default-src none">
    <link rel="stylesheet" href="main.css" integrity="abc"><img srcset="a.png 1x, b.png 2x"><style>p{background:url(bg.png)}</style>`,
    'https://example.com/',
    mapped,
    { archive: true },
  );
  assert.match(html, /href="\/local\/main.css"/);
  assert.match(html, /\/local\/a.png 1x, \/local\/b.png 2x/);
  assert.match(html, /url\(\/local\/bg.png\)/);
  assert.doesNotMatch(html, /<base|integrity=|http-equiv=/);
});
test('CSS handles nested imports, url functions, fragments and data URLs', () => {
  const css = rewriteCss(
    '@import "nested.css" screen; x{mask:url(icon.svg#id);background:url(data:image/png;base64,AAAA)}',
    'https://example.com/a.css',
    mapped,
  );
  assert.match(css, /"\/local\/nested.css" screen/);
  assert.match(css, /\/local\/icon.svg#id/);
  assert.match(css, /data:image\/png;base64,AAAA/);
});
test('ES modules rewrite static and dynamic imports while leaving bare imports intact', () => {
  const js = rewriteJs(
    'import x from "./x.js"; import("../y.js"); import z from "pkg";',
    'https://example.com/scripts/app.js',
    mapped,
  );
  assert.match(js, /from "\/local\/x.js"/);
  assert.match(js, /import\("\/local\/y.js"\)/);
  assert.match(js, /from "pkg"/);
});
