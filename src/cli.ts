#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { analyzeAndClean, ImportCleanupResult } from './analyzer';
import { discoverFiles } from './fileUtils';
import { findUnusedCode, UnusedCodeItem } from './unusedCode';
import { detectMonorepo, MonorepoConfig } from './monorepo';

// Simple p-limit implementation to avoid dependency
function pLimit(concurrency: number) {
  const queue: (() => Promise<void>)[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  const run = async (fn: () => Promise<any>, resolve: (value: any) => void, reject: (reason?: any) => void) => {
    activeCount++;
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      next();
    }
  };

  const enqueue = (fn: () => Promise<any>, resolve: (value: any) => void, reject: (reason?: any) => void) => {
    queue.push(() => run(fn, resolve, reject));
    if (activeCount < concurrency) {
      const nextFn = queue.shift();
      if (nextFn) nextFn();
    }
  };

  return (fn: () => Promise<any>) => new Promise((resolve, reject) => enqueue(fn, resolve, reject));
}

interface ListItem { file: string; specifiers: string[]; }
interface CleanSummary { filesChanged: number; totalSpecifiersRemoved: number; }

async function listUnusedImports(target: string, extensions: string[], ignore: string[], checkLocal: boolean, monorepoConfig: MonorepoConfig): Promise<ListItem[]> {
  const files = await discoverFiles(target, { root: process.cwd(), extensions, ignore });
  const projectRoot = process.cwd();
  const items: ListItem[] = [];
  const limit = pLimit(10); // Concurrency limit

  const tasks = files.map(file => limit(async () => {
    try {
      const result: ImportCleanupResult = await analyzeAndClean(file, true, {
        checkLocalImports: checkLocal,
        projectRoot,
        monorepoConfig
      });
      if (result.changed) {
        const flat = result.removed.flatMap(r => r.specifiers);
        items.push({ file, specifiers: flat });
      }
    } catch (error) {
      console.error(chalk.red(`Error analyzing ${file}:`), error);
    }
  }));

  await Promise.all(tasks);
  return items;
}

async function cleanUnusedImports(target: string, extensions: string[], ignore: string[], checkLocal: boolean, monorepoConfig: MonorepoConfig): Promise<CleanSummary> {
  const files = await discoverFiles(target, { root: process.cwd(), extensions, ignore });
  const projectRoot = process.cwd();
  let filesChanged = 0;
  let totalRemoved = 0;
  const limit = pLimit(10);

  const tasks = files.map(file => limit(async () => {
    try {
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
    } catch (error) {
      console.error(chalk.red(`Error cleaning ${file}:`), error);
    }
  }));

  await Promise.all(tasks);
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

  const commonOptions = (cmd: Command) => cmd
    .argument('[target]', 'Directory or file to scan', '.')
    .option('--ext <list>', 'Comma separated extensions', 'ts,tsx,js,jsx')
    .option('--ignore <list>', 'Comma separated ignore globs', '')
    .option('--check-local', 'Check if local imports exist in project (supports @/ and path aliases)', false);

  program
    .command('list')
    .description('List unused import specifiers')
    .addHelpText('after', '\nExample:\n  $ sweepp list src\n  $ sweepp list --ext ts,tsx')
    .argument('[target]', 'Directory or file to scan', '.')
    .option('--ext <list>', 'Comma separated extensions', 'ts,tsx,js,jsx')
    .option('--ignore <list>', 'Comma separated ignore globs', '')
    .option('--check-local', 'Check if local imports exist in project (supports @/ and path aliases)', false)
    .action(async (target, opts) => {
      try {
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
        const checkLocal = opts.checkLocal || false;
        const monorepoConfig = detectMonorepo(process.cwd());

        if (monorepoConfig.type !== 'none') {
          console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
        }

        console.log(chalk.blue(`Scanning ${target}...`));
        const items = await listUnusedImports(target, extensions, ignore, checkLocal, monorepoConfig);

        if (items.length === 0) {
          console.log(chalk.green('No unused imports found.'));
          return;
        }

        console.log(chalk.bold.cyan('\nUnused Imports Report\n'));

        const maxFileLength = Math.min(Math.max(...items.map(it => path.relative(process.cwd(), it.file).length), 'File'.length), 60);
        const maxCountLength = Math.max(...items.map(it => it.specifiers.length.toString().length), 'Count'.length);

        const fileHeader = 'File'.padEnd(maxFileLength);
        const countHeader = 'Count'.padEnd(maxCountLength);
        const specsHeader = 'Unused Imports';

        console.log(chalk.bold.white(`${fileHeader}  ${countHeader}  ${specsHeader}`));
        console.log(chalk.gray('─'.repeat(maxFileLength + maxCountLength + 50)));

        for (const it of items) {
          let fileName = path.relative(process.cwd(), it.file);
          if (fileName.length > maxFileLength) {
            fileName = '...' + fileName.slice(-(maxFileLength - 3));
          }
          const count = it.specifiers.length.toString().padEnd(maxCountLength);
          const specs = it.specifiers.join(', ');
          console.log(`${chalk.yellow(fileName.padEnd(maxFileLength))}  ${chalk.cyan(count)}  ${chalk.gray(specs)}`);
        }

        const totalSpecifiers = items.reduce((a, b) => a + b.specifiers.length, 0);
        console.log(chalk.gray('─'.repeat(maxFileLength + maxCountLength + 50)));
        console.log(chalk.bold(`\nSummary: ${chalk.yellow(items.length)} file(s) with ${chalk.cyan(totalSpecifiers)} unused import(s)\n`));
      } catch (err) {
        console.error(chalk.red('Error:'), err);
        process.exit(1);
      }
    });

  program
    .command('clean')
    .description('Remove unused imports and show summary')
    .argument('[target]', 'Directory or file to scan', '.')
    .option('--ext <list>', 'Comma separated extensions', 'ts,tsx,js,jsx')
    .option('--ignore <list>', 'Comma separated ignore globs', '')
    .option('--check-local', 'Check if local imports exist in project (supports @/ and path aliases)', false)
    .action(async (target, opts) => {
      try {
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
        const checkLocal = opts.checkLocal || false;
        const monorepoConfig = detectMonorepo(process.cwd());

        if (monorepoConfig.type !== 'none') {
          console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
        }

        console.log(chalk.blue(`Cleaning ${target}...`));
        const summary = await cleanUnusedImports(target, extensions, ignore, checkLocal, monorepoConfig);

        console.log('\n' + chalk.bold('Clean Summary'));
        console.log(`Files changed: ${summary.filesChanged}`);
        console.log(`Total specifiers removed: ${summary.totalSpecifiersRemoved}`);
      } catch (err) {
        console.error(chalk.red('Error:'), err);
        process.exit(1);
      }
    });

  program
    .command('unused-code')
    .alias('dead')
    .alias('unuse')
    .description('List potentially unused exported or top-level code (safe preview)')
    .argument('[target]', 'Directory or file to scan', '.')
    .option('--ext <list>', 'Comma separated extensions', 'ts,tsx,js,jsx')
    .option('--ignore <list>', 'Comma separated ignore globs', '')
    .action(async (target, opts) => {
      try {
        const extensions = opts.ext.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ignore = opts.ignore.split(',').map((s: string) => s.trim()).filter(Boolean);
        const monorepoConfig = detectMonorepo(process.cwd());

        if (monorepoConfig.type !== 'none') {
          console.log(chalk.gray(`Detected ${monorepoConfig.type} monorepo with ${monorepoConfig.packages.length} package(s)\n`));
        }

        console.log(chalk.blue(`Scanning for unused code in ${target}...`));
        const items: UnusedCodeItem[] = await findUnusedCode(target, extensions, ignore, monorepoConfig);

        if (items.length === 0) {
          console.log(chalk.green.bold('✔ No unused code candidates found.'));
          return;
        }

        const rel = (f: string) => path.relative(process.cwd(), f);
        const allowedRoots = ['src', 'apps', 'packages'];

        console.log(chalk.bold.cyan('\nUnused Code Candidates\n'));

        for (const it of items) {
          const relFile = rel(it.file);
          // Only show files from main source folders if scanning root
          if (target === '.' && !allowedRoots.some(root => relFile.startsWith(root + path.sep) || relFile === root)) {
            // Optional: skip files outside common source dirs if scanning root to reduce noise
            // But if user specified target, show everything.
            // Keeping original logic's spirit but making it safer.
          }

          console.log(`${chalk.yellow(relFile)} ${chalk.white(it.name)} ${chalk.gray(it.kind)} ${it.exported ? chalk.magenta('exported') : ''}`);
        }

        console.log(`\nSummary: ${items.length} unused code candidate(s).`);
        console.log(chalk.gray('Note: Heuristic detection. Review before removal.'));
      } catch (err) {
        console.error(chalk.red('Error:'), err);
        process.exit(1);
      }
    });

  // Default action if no command provided
  program.action(() => {
    program.help();
  });

  await program.parseAsync(process.argv);
}

run().catch(err => {
  console.error(chalk.red('Fatal Error:'), err);
  process.exit(1);
});
