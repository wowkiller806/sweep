
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { discoverFiles } from './fileUtils';
import { resolvePathAliases, resolveFullImportPath, isLocalImport } from './pathResolver';
import { MonorepoConfig } from './monorepo';

const DEFAULT_IGNORE = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.vercel',
  '.git',
  'coverage',
  'public',
  'static',
  'storybook-static',
  'tmp',
  'temp',
  '.cache',
  '.expo',
  '.idea',
  '.vscode'
];

const nextIgnores = [
  '**/pages/_app.*',
  '**/pages/_document.*',
  '**/pages/_error.*',
  '**/pages/_middleware.*',
  '**/pages/_api/**',
  '**/pages/_*',
  '**/app/_*',
  '**/app/layout.*',
  '**/app/error.*',
  '**/app/loading.*',
  '**/app/not-found.*',
  '**/app/head.*',
  '**/app/global-error.*'
];

export interface UnusedCodeItem {
  file: string;
  name: string;
  kind: string; // function | class | variable | type | interface
  exported: boolean;
  startLine: number | null;
  endLine: number | null;
}

interface FileAnalysis {
  declarations: { name: string; kind: string; exported: boolean; startLine: number | null; endLine: number | null }[];
  used: Set<string>;
  exports: Set<string>; // exported names
  defaultExport: string | null;
  reExports: Set<string>;
}
  // (stray/incorrect) Remove this line, only use allIgnores inside findUnusedCode
function collectFileAnalysis(code: string): FileAnalysis {
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  // Only scan user codebase folders, never node_modules or build/system folders
  const DEFAULT_IGNORE = [
    'node_modules',
    'dist',
    'build',
    'out',
    '.next',
    '.vercel',
    '.git',
    'coverage',
    'public',
    'static',
    'storybook-static',
    'tmp',
    'temp',
    '.cache',
    '.expo',
    '.idea',
    '.vscode'
  ];
  } catch {
    return { declarations: [], used: new Set(), exports: new Set(), defaultExport: null, reExports: new Set() };
  }

  const declarations: { name: string; kind: string; exported: boolean; startLine: number | null; endLine: number | null }[] = [];
  const used = new Set<string>();
  const exports = new Set<string>();
  let defaultExport: string | null = null;
  const reExports = new Set<string>();

  traverse(ast, {
    Identifier(path) {
      if (path.findParent(p => p.isImportDeclaration())) return;
      const parent = path.parent;
      if (t.isVariableDeclarator(parent) && parent.id === path.node) return;
      if ((t.isFunctionDeclaration(parent) || t.isFunctionExpression(parent) || t.isArrowFunctionExpression(parent)) && parent.params.includes(path.node as any)) return;
      used.add(path.node.name);
    },
    TSTypeReference(path) {
      if (t.isIdentifier(path.node.typeName)) used.add(path.node.typeName.name);
    }
  });

  traverse(ast, {
    ExportDefaultDeclaration(path) {
      // Track default export name if possible
      const node = path.node;
      if (t.isIdentifier(node.declaration)) {
        defaultExport = node.declaration.name;
      } else if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
        defaultExport = node.declaration.id.name;
      } else if (t.isClassDeclaration(node.declaration) && node.declaration.id) {
        defaultExport = node.declaration.id.name;
      } else {
        defaultExport = 'default';
      }
    },
    ExportNamedDeclaration(path) {
      const node = path.node;
      if (node.declaration) {
        if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
          declarations.push({ name: node.declaration.id.name, kind: 'function', exported: true, startLine: node.declaration.loc?.start.line ?? null, endLine: node.declaration.loc?.end.line ?? null });
          exports.add(node.declaration.id.name);
        } else if (t.isClassDeclaration(node.declaration) && node.declaration.id) {
          declarations.push({ name: node.declaration.id.name, kind: 'class', exported: true, startLine: node.declaration.loc?.start.line ?? null, endLine: node.declaration.loc?.end.line ?? null });
          exports.add(node.declaration.id.name);
        } else if (t.isVariableDeclaration(node.declaration)) {
          node.declaration.declarations.forEach(d => {
            if (t.isIdentifier(d.id)) {
              declarations.push({
                name: d.id.name,
                kind: 'variable',
                exported: true,
                startLine: d.loc?.start.line ?? node.declaration?.loc?.start.line ?? null,
                endLine: d.loc?.end.line ?? node.declaration?.loc?.end.line ?? null
              });
              exports.add(d.id.name);
            }
          });
        } else if (t.isTSTypeAliasDeclaration(node.declaration) && t.isIdentifier(node.declaration.id)) {
          declarations.push({ name: node.declaration.id.name, kind: 'type', exported: true, startLine: node.declaration.loc?.start.line ?? null, endLine: node.declaration.loc?.end.line ?? null });
          exports.add(node.declaration.id.name);
        } else if (t.isTSInterfaceDeclaration(node.declaration) && t.isIdentifier(node.declaration.id)) {
          declarations.push({ name: node.declaration.id.name, kind: 'interface', exported: true, startLine: node.declaration.loc?.start.line ?? null, endLine: node.declaration.loc?.end.line ?? null });
          exports.add(node.declaration.id.name);
        }
      }
      if (node.specifiers) {
        node.specifiers.forEach(spec => {
          if (t.isExportSpecifier(spec)) {
            const name = spec.local.name;
            const existing = declarations.find(d => d.name === name);
            if (existing) {
              existing.exported = true;
            } else {
              declarations.push({ name, kind: 'variable', exported: true, startLine: spec.loc?.start.line ?? null, endLine: spec.loc?.end.line ?? null }); // kind unknown; treat as variable
            }
            exports.add(name);
          }
        });
      }
      // Track re-exports: export { foo } from './bar'
      if (node.source && node.specifiers) {
        node.specifiers.forEach(spec => {
          if (t.isExportSpecifier(spec)) {
            const exportedName = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
            reExports.add(exportedName);
          }
        });
      }
    },
    FunctionDeclaration(path) {
      if (!path.node.id) return;
      if (!declarations.some(d => d.name === path.node.id!.name)) {
        declarations.push({ name: path.node.id.name, kind: 'function', exported: false, startLine: path.node.loc?.start.line ?? null, endLine: path.node.loc?.end.line ?? null });
      }
    },
    ClassDeclaration(path) {
      if (!path.node.id) return;
      if (!declarations.some(d => d.name === path.node.id!.name)) {
        declarations.push({ name: path.node.id.name, kind: 'class', exported: false, startLine: path.node.loc?.start.line ?? null, endLine: path.node.loc?.end.line ?? null });
      }
    },
    VariableDeclaration(path) {
      path.node.declarations.forEach(d => {
        if (t.isIdentifier(d.id)) {
          const varName = d.id.name;
          if (!declarations.some(dd => dd.name === varName)) {
            declarations.push({
              name: varName,
              kind: 'variable',
              exported: false,
              startLine: d.loc?.start.line ?? path.node.loc?.start.line ?? null,
              endLine: d.loc?.end.line ?? path.node.loc?.end.line ?? null
            });
          }
        }
      });
    },
    TSTypeAliasDeclaration(path) {
      if (t.isIdentifier(path.node.id) && !declarations.some(dd => dd.name === path.node.id.name)) {
        declarations.push({ name: path.node.id.name, kind: 'type', exported: false, startLine: path.node.loc?.start.line ?? null, endLine: path.node.loc?.end.line ?? null });
      }
    },
    TSInterfaceDeclaration(path) {
      if (t.isIdentifier(path.node.id) && !declarations.some(dd => dd.name === path.node.id.name)) {
        declarations.push({ name: path.node.id.name, kind: 'interface', exported: false, startLine: path.node.loc?.start.line ?? null, endLine: path.node.loc?.end.line ?? null });
      }
    }
  });

  return { declarations, used, exports, defaultExport, reExports };
}


export async function findUnusedCode(target: string, extensions: string[], ignore: string[], monorepoConfig: MonorepoConfig): Promise<UnusedCodeItem[]> {
  // Add built-in Next.js ignore patterns

  // Always strictly ignore system folders regardless of user input
  const allIgnores = Array.from(new Set([...(ignore || []), ...DEFAULT_IGNORE, ...nextIgnores]));
  const projectRoot = process.cwd();
  const aliasMap = resolvePathAliases(projectRoot);
  const files = await discoverFiles(target, { root: projectRoot, extensions, ignore: allIgnores });

  // Batch file reads with concurrency limit to avoid EMFILE
  const BATCH_SIZE = 32;
  async function batchReadFiles(fileList: string[]): Promise<string[]> {
    const results: string[] = [];
    for (let i = 0; i < fileList.length; i += BATCH_SIZE) {
      const batch = fileList.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async f => {
        try {
          return await fs.readFile(f, 'utf8');
        } catch (err) {
          const code = (err as any)?.code || (err instanceof Error ? err.message : String(err));
          console.warn(`[sweepp] Skipped unreadable file: ${f} (${code})`);
          return '';
        }
      }));
      results.push(...batchResults);
    }
    return results;
  }

  const fileContents = await batchReadFiles(files);
  const fileAnalyses: Record<string, FileAnalysis> = {};
  const asts: Record<string, t.File | null> = {};
  files.forEach((file, i) => {
    try {
      if (!fileContents[i]) throw new Error('Empty file');
      asts[file] = parse(fileContents[i], { sourceType: 'module', plugins: ['typescript', 'jsx'] });
      fileAnalyses[file] = collectFileAnalysis(fileContents[i]);
    } catch (err) {
      asts[file] = null;
      fileAnalyses[file] = { declarations: [], used: new Set(), exports: new Set(), defaultExport: null, reExports: new Set() };
      if (fileContents[i]) {
        const code = (err as any)?.code || (err instanceof Error ? err.message : String(err));
        console.warn(`[sweepp] Skipped unparseable file: ${file} (${code})`);
      }
    }
  });

  // Build import/export dependency graph in a single pass
  files.forEach(file => {
    const ast = asts[file];
    if (!ast) return;
    traverse(ast, {
      ImportDeclaration(p) {
        const src = p.node.source.value;
        const isLocal = isLocalImport(src) || aliasMap.has(src.split('/')[0]);
        if (!isLocal) return;
        const resolved = resolveFullImportPath(src, file, projectRoot, aliasMap, monorepoConfig);
        if (!resolved || !fileAnalyses[resolved]) return;
        p.node.specifiers.forEach(spec => {
          if (t.isImportSpecifier(spec)) {
            const importedName = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
            fileAnalyses[resolved].used.add(importedName);
          } else if (t.isImportNamespaceSpecifier(spec)) {
            fileAnalyses[resolved].exports.forEach(name => fileAnalyses[resolved].used.add(name));
          } else if (t.isImportDefaultSpecifier(spec)) {
            if (fileAnalyses[resolved].defaultExport) {
              fileAnalyses[resolved].used.add(fileAnalyses[resolved].defaultExport);
            }
          }
        });
      }
    });
  });

  // Mark re-exported symbols as used if imported elsewhere
  files.forEach(file => {
    const analysis = fileAnalyses[file];
    if (!analysis) return;
    for (const reExport of analysis.reExports) {
      if (analysis.used.has(reExport)) continue;
      for (const otherFile of files) {
        if (otherFile === file) continue;
        if (fileAnalyses[otherFile]?.used.has(reExport)) {
          analysis.used.add(reExport);
          break;
        }
      }
    }
  });

  // Collect unused code
  const unused: UnusedCodeItem[] = [];
  for (const [file, analysis] of Object.entries(fileAnalyses)) {
    const rel = path.relative(projectRoot, file);
    const isNextPages = /\\pages\\|\/pages\//.test(rel) || /\\app\\|\/app\//.test(rel);
    for (const decl of analysis.declarations) {
      if (isNextPages && decl.exported) continue;
      if (!analysis.used.has(decl.name)) {
        unused.push({ file, name: decl.name, kind: decl.kind, exported: decl.exported, startLine: decl.startLine, endLine: decl.endLine });
      }
    }
  }
  return unused.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}
