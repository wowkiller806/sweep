import fg from 'fast-glob';
import path from 'path';

export interface DiscoverOptions {
  root: string;
  extensions: string[];
  ignore: string[];
}

export async function discoverFiles(patternOrDir: string, opts: DiscoverOptions): Promise<string[]> {
  const isDir = !/[?*]/.test(patternOrDir);
  const base = path.resolve(patternOrDir);
  const extsPattern = opts.extensions.map(e => e.startsWith('.') ? e.slice(1) : e).join(',');

  // Always ignore node_modules and .git
  const defaultIgnore = ['**/node_modules/**', '**/.git/**', '**/*.d.ts'];
  const userIgnore = opts.ignore.map(i => i.replace(/\\/g, '/'));
  const ignore = [...defaultIgnore, ...userIgnore];

  const globPattern = isDir
    ? `${base.replace(/\\/g, '/')}/**/*.{${extsPattern}}`
    : patternOrDir.replace(/\\/g, '/');

  return fg(globPattern, {
    ignore,
    dot: false,
    onlyFiles: true,
    absolute: true
  });
}
