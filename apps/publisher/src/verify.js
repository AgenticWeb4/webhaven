/**
 * 静态依赖验收：检查清单内 HTML、CSS 与可解析模块引用是否可在本地解析。
 * 仅覆盖可观察静态依赖，不能证明任意 JavaScript 运行时行为完整。
 */
import { transform } from './rewrite.js';

/**
 * 意图：让缺少资源的版本显式带有缺口，而不是自动获得发布资格。
 * 步骤：建立文件路径集合 → 检查可迁移性 → 复用解析器枚举引用 → 收集缺口。
 * bodies 为摘要到已校验字节的 Map；返回问题数组，页面导航不作为静态资源要求。
 */
export function dependencyIssues(files, bodies) {
  const paths = new Set(files.map((f) => f.path));
  const issues = [];
  for (const file of files) {
    const bytes = bodies.get(file.sha256);
    if (
      ![
        'text/html',
        'application/xhtml+xml',
        'text/css',
        'application/javascript',
        'text/javascript',
      ].includes(file.type)
    )
      continue;
    const text = bytes.toString();
    if (/(?:src|href|poster)\s*=\s*["']\/(?!\/)|url\(\s*["']?\/(?!\/)/i.test(text))
      issues.push({
        path: file.path,
        error: 'Root-relative resource paths require a relocatable bundle',
      });
    try {
      // 使用保留域名作为虚拟根，外部主机、查询串或清单外路径都会留下缺口。
      transform(bytes, file.type, 'https://webhaven.invalid/' + file.path, (url, kind) => {
        if (kind === 'page') return null;
        const ref = new URL(url);
        const target = decodeURIComponent(ref.pathname.slice(1));
        if (ref.host !== 'webhaven.invalid' || ref.search || !paths.has(target))
          issues.push({ path: file.path, error: 'Unresolved static dependency', reference: url });
        return null;
      });
    } catch (e) {
      issues.push({ path: file.path, error: 'Cannot validate static content: ' + e.message });
    }
  }
  return issues;
}
