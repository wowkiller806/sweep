#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { analyzeAndClean, ImportCleanupResult } from './analyzer';
import { discoverFiles } from './fileUtils';
import { findUnusedCode, UnusedCodeItem } from './unusedCode';
import { detectMonorepo, MonorepoConfig } from './monorepo';

interface ListItem { file: string; specifiers: string[]; }
interface CleanSummary { filesChanged: number; totalSpecifiersRemoved: number; }

async function listUnusedImports(target: string, extensions: string[], ignore: string[], checkLocal: boolean, monorepoConfig: MonorepoConfig): Promise<ListItem[]> {
  const files = await discoverFiles(target, { root: process.cwd(), extensions, ignore });
  const projectRoot = process.cwd();
  const items: ListItem[] = [];
  for (const file of files) {
    const result: ImportCleanupResult = await analyzeAndClean(file, true, {
      checkLocalImports: checkLocal,
      projectRoot,
      monorepoConfig
    });
    if (result.changed) {
      const flat = result.removed.flatMap(r => r.specifiers);
      items.push({ file, specifiers: flat });
    }
  }
  return items;
}

async function cleanUnusedImports(target: string, extensions: string[], ignore: string[], checkLocal: boolean, monorepoConfig: MonorepoConfig): Promise<CleanSummary> {
  const files = await discoverFiles(target, { root: process.cwd(), extensions, ignore });
  const projectRoot = process.cwd();
  let filesChanged = 0;
  let totalRemoved = 0;
  for (const file of files) {
    const result: ImportCleanupResult = await analyzeAndClean(file, false, {
      checkLocalImports: checkLocal,
      projectRoot,
      monorepoConfig
    });
    if (result.changed) {
      filesChanged++;
      const flat = result.removed.flatMap(r => r.specifiers);
      totalRemoved += flat.length;
      console.log(chalk.green(`✔ ${path.relative(process.cwd(), file)} removed: ${flat.join(', ')}`));
    }
  }
  return { filesChanged, totalSpecifiersRemoved: totalRemoved };
}

async function run() {
  const pkg = require('../package.json');
  const program = new Command();
  program
    .name('sweepp')
    .description('Sweep unused imports and code from JS/TS projects')
    .version(pkg.version, '-v, --version', 'Show version')
    .alias('swp');

  // Short commands
  program
    .argument('[cmd]', 'Command: list, clean, unuse, version, or .')
    .argument('[dir]', 'Directory (default: .)')
    .option('--ext <exts>', 'File extensions', 'ts,tsx,js,jsx')
    .option('--ignore <patterns>', 'Ignore patterns', '')
    .action(async (cmd = '.', dir = '.', opts) => {
      // If no directory specified, scan only src, apps, packages
      if (!dir || dir === '.' || dir === '') {
        const roots = ['src', 'apps', 'packages'];
        dir = roots.filter(r => require('fs').existsSync(r)).join(',');
        if (!dir) dir = '.';
      }
      if (cmd === '.' || cmd === 'list') {
        // Use local listUnusedImports logic
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        // Always ignore node_modules
        const ignore = Array.from(new Set([
          ...opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean),
          'node_modules'
        ]));
        const checkLocal = opts.checkLocal || false;
        const monorepoConfig = detectMonorepo(process.cwd());
        const items = await listUnusedImports(dir, extensions, ignore, checkLocal, monorepoConfig);
        if (items.length === 0) {
          console.log('No unused imports found.');
          return;
        }
        // Print simple ASCII table
        const maxFileLength = Math.max(...items.map(it => path.relative(process.cwd(), it.file).length), 'File'.length);
        const maxCountLength = Math.max(...items.map(it => it.specifiers.length.toString().length), 'Count'.length);
        const fileHeader = 'File'.padEnd(maxFileLength);
        const countHeader = 'Count'.padEnd(maxCountLength);
        const specsHeader = 'Unused Imports';
        console.log(`${fileHeader} | ${countHeader} | ${specsHeader}`);
        console.log('-'.repeat(maxFileLength + maxCountLength + 30));
        for (const it of items) {
          const fileName = path.relative(process.cwd(), it.file).padEnd(maxFileLength);
          const count = it.specifiers.length.toString().padEnd(maxCountLength);
          const specs = it.specifiers.join(', ');
          console.log(`${fileName} | ${count} | ${specs}`);
        }
        const totalSpecifiers = items.reduce((a, b) => a + b.specifiers.length, 0);
        console.log('-'.repeat(maxFileLength + maxCountLength + 30));
        console.log(`Summary: ${items.length} file(s) with ${totalSpecifiers} unused import(s)`);
      } else if (cmd === 'clean') {
        // Use local cleanUnusedImports logic
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        // Always ignore node_modules
        const ignore = Array.from(new Set([
          ...opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean),
          'node_modules'
        ]));
        const checkLocal = opts.checkLocal || false;
        const monorepoConfig = detectMonorepo(process.cwd());
        const summary = await cleanUnusedImports(dir, extensions, ignore, checkLocal, monorepoConfig);
        console.log('\nClean Summary');
        console.log(`Files changed: ${summary.filesChanged}`);
        console.log(`Total specifiers removed: ${summary.totalSpecifiersRemoved}`);
      } else if (cmd === 'unuse') {
        // Use unused code logic from unused-code command
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
        const monorepoConfig = detectMonorepo(process.cwd());
        const items: UnusedCodeItem[] = await findUnusedCode(dir, extensions, ignore, monorepoConfig);
        if (items.length === 0) {
          console.log('No unused code candidates found.');
          return;
        }
        // Minimal ASCII table, no color
        const rel = (f: string) => path.relative(process.cwd(), f);
        const maxFile = Math.max(...items.map(i => rel(i.file).length), 'File'.length);
        const maxName = Math.max(...items.map(i => i.name.length), 'Name'.length);
        const colWidths = [maxFile, maxName, 8, 5, 5, 8];
        const headers = ['File', 'Name', 'Kind', 'Start', 'End', 'Exported'];
        const pad = (s: string, w: number) => s.padEnd(w);
        const border = '+' + colWidths.map(w => '-'.repeat(w + 2)).join('+') + '+';
        const divider = '|' + colWidths.map(w => '-'.repeat(w + 2)).join('+') + '|';
        console.log('\n' + border);
        console.log('| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |');
        console.log(divider);
        for (const it of items) {
          const fileCell = pad(rel(it.file), colWidths[0]);
          const nameCell = pad(it.name, colWidths[1]);
          const kindCell = pad(it.kind, colWidths[2]);
          const startCell = pad((it.startLine ?? '-').toString(), colWidths[3]);
          const endCell = pad((it.endLine ?? '-').toString(), colWidths[4]);
          const expCell = pad(it.exported ? 'yes' : 'no', colWidths[5]);
          console.log('| ' + [fileCell, nameCell, kindCell, startCell, endCell, expCell].join(' | ') + ' |');
        }
        console.log(border);
        console.log(`\nSummary: ${items.length} unused code candidate(s).`);
        console.log('Note: Heuristic detection. Pages/app router exports in Next.js treated as used. Default exports and re-exports are now traced. Review before removal.');
      } else if (cmd === 'version') {
        console.log(pkg.version);
      } else {
        // If just 'sweepp' or 'swp', default to list .
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
        const checkLocal = opts.checkLocal || false;
        const monorepoConfig = detectMonorepo(process.cwd());
        const items = await listUnusedImports('.', extensions, ignore, checkLocal, monorepoConfig);
        if (items.length === 0) {
          console.log('No unused imports found.');
          return;
        }
        // Print table
        const maxFileLength = Math.max(...items.map(it => path.relative(process.cwd(), it.file).length), 'File'.length);
        const maxCountLength = Math.max(...items.map(it => it.specifiers.length.toString().length), 'Count'.length);
        const fileHeader = 'File'.padEnd(maxFileLength);
        const countHeader = 'Count'.padEnd(maxCountLength);
        const specsHeader = 'Unused Imports';
        console.log(`${fileHeader}  ${countHeader}  ${specsHeader}`);
        console.log('-'.repeat(maxFileLength + maxCountLength + 50));
        for (const it of items) {
          const fileName = path.relative(process.cwd(), it.file).padEnd(maxFileLength);
          const count = it.specifiers.length.toString().padEnd(maxCountLength);
          const specs = it.specifiers.join(', ');
          console.log(`${fileName}  ${count}  ${specs}`);
        }
        const totalSpecifiers = items.reduce((a, b) => a + b.specifiers.length, 0);
        console.log('-'.repeat(maxFileLength + maxCountLength + 50));
        console.log(`\nSummary: ${items.length} file(s) with ${totalSpecifiers} unused import(s)\n`);
      }
    });

  program.parse();

  const common = (cmd: Command) => cmd
    .option('--ext <list>', 'Comma separated extensions', 'ts,tsx,js,jsx')
    .option('--ignore <list>', 'Comma separated ignore globs', 'node_modules')
    .option('--check-local', 'Check if local imports exist in project (supports @/ and path aliases)', false);

  // Unused code command (added after common definition to avoid TS hoist error)
  common(program.command('unused-code [target]')
    .alias('dead')
    .alias('unuse')
    .description('List potentially unused exported or top-level code (safe preview)')
    .action(async (target, opts) => {
      // If no target specified, scan only src, apps, packages
      if (!target || target === '.' || target === '') {
        const roots = ['src', 'apps', 'packages'];
        target = roots.filter(r => require('fs').existsSync(r)).join(',');
        if (!target) target = '.';
      }
      const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
      const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);

      // Detect monorepo
      const monorepoConfig = detectMonorepo(process.cwd());
      if (monorepoConfig.type !== 'none') {
        console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
      }

      const items: UnusedCodeItem[] = await findUnusedCode(target, extensions, ignore, monorepoConfig);
      if (items.length === 0) {
        console.log(chalk.green.bold('✔ No unused code candidates found.'));
        return;
      }

      // Print simple list: file name kind exported (no table, no start/end columns)
      const rel = (f: string) => path.relative(process.cwd(), f);
      const allowedRoots = ['src', 'apps', 'packages'];
      for (const it of items) {
        const relFile = rel(it.file);
        // Only show files from main source folders
        if (!allowedRoots.some(root => relFile.startsWith(root + path.sep))) continue;
        console.log(`${relFile} ${it.name} ${it.kind} ${it.exported ? 'yes' : 'no'}`);
      }
    }));

  common(program.command('list [target]').description('List unused import specifiers').action(async (target = '.', opts) => {
      // If no target specified, scan only src, apps, packages
      if (!target || target === '.' || target === '') {
        const roots = ['src', 'apps', 'packages'];
        target = roots.filter(r => require('fs').existsSync(r)).join(',');
        if (!target) target = '.';
      }
      const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
      const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
      const checkLocal = opts.checkLocal || false;
      // Detect monorepo
      const monorepoConfig = detectMonorepo(process.cwd());
      if (monorepoConfig.type !== 'none') {
        console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
      }
      const items = await listUnusedImports(target, extensions, ignore, checkLocal, monorepoConfig);
      if (items.length === 0) {
        console.log(chalk.green('No unused imports found.'));
        return;
      }
      console.log(chalk.bold.cyan('\nUnused Imports Report\n'));
      // Calculate column widths
      const maxFileLength = Math.max(...items.map(it => path.relative(process.cwd(), it.file).length), 'File'.length);
      const maxCountLength = Math.max(...items.map(it => it.specifiers.length.toString().length), 'Count'.length);
      // Print table header
      const fileHeader = 'File'.padEnd(maxFileLength);
      const countHeader = 'Count'.padEnd(maxCountLength);
      const specsHeader = 'Unused Imports';
      console.log(chalk.bold.white(`${fileHeader}  ${countHeader}  ${specsHeader}`));
      console.log(chalk.gray('─'.repeat(maxFileLength + maxCountLength + 50)));
      // Print table rows
      for (const it of items) {
        const fileName = path.relative(process.cwd(), it.file).padEnd(maxFileLength);
        const count = it.specifiers.length.toString().padEnd(maxCountLength);
        const specs = it.specifiers.join(', ');
        console.log(`${chalk.yellow(fileName)}  ${chalk.cyan(count)}  ${chalk.gray(specs)}`);
      }
      // Print summary
      const totalSpecifiers = items.reduce((a, b) => a + b.specifiers.length, 0);
      console.log(chalk.gray('─'.repeat(maxFileLength + maxCountLength + 50)));
      console.log(chalk.bold(`\nSummary: ${chalk.yellow(items.length)} file(s) with ${chalk.cyan(totalSpecifiers)} unused import(s)\n`));
    }));

  common(program.command('clean [target]').description('Remove unused imports and show summary').action(async (target = '.', opts) => {
      // If no target specified, scan only src, apps, packages
      if (!target || target === '.' || target === '') {
        const roots = ['src', 'apps', 'packages'];
        target = roots.filter(r => require('fs').existsSync(r)).join(',');
        if (!target) target = '.';
      }
      const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
      const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
      const checkLocal = opts.checkLocal || false;
      // Detect monorepo
      const monorepoConfig = detectMonorepo(process.cwd());
      if (monorepoConfig.type !== 'none') {
        console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
      }
      const summary = await cleanUnusedImports(target, extensions, ignore, checkLocal, monorepoConfig);
      console.log('\n' + chalk.bold('Clean Summary'));
      console.log(`Files changed: ${summary.filesChanged}`);
      console.log(`Total specifiers removed: ${summary.totalSpecifiersRemoved}`);
    }));

  program.command('version').description('Show version').action(() => console.log(program.version()));

  // default to list if no subcommand or if first arg looks like a path/target
  if (process.argv.length <= 2) {
    process.argv.push('list');
  } else if (process.argv.length === 3 && !['list', 'clean', 'version', 'unused-code', 'dead'].includes(process.argv[2])) {
    // If single argument and it's not a known command, treat it as "list <target>"
    process.argv.splice(2, 0, 'list');
  }
  
  program.parseAsync(process.argv).catch(err => {
    console.error(chalk.red('Unexpected error:'), err);
    process.exit(1);
  });
}

run();
