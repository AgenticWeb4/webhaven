import { transform } from './rewrite.js';

// Checks the static dependencies we can observe; it is not a proof of arbitrary JS behavior.
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
