import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_FILES = [
  'content-scripts/content.js',
  'icon/128.png',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/96.png',
  'manifest.json',
];
const ALLOWED_FILE_SET = new Set(ALLOWED_FILES);
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';
const MAX_CONTENT_SCRIPT_BYTES = 250_000;
const MAX_BUNDLE_BYTES = 270_000;

function normalizeFilePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function byteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value && typeof value.byteLength === 'number') return value.byteLength;
  return 0;
}

export function validateBundle({ files, contentScript, sizes }) {
  const errors = [];
  const normalizedFiles = files.map(normalizeFilePath).sort();
  const fileSet = new Set(normalizedFiles);

  for (const file of normalizedFiles) {
    if (!ALLOWED_FILE_SET.has(file)) errors.push(`Unexpected bundle file: ${file}`);
  }
  for (const file of ALLOWED_FILES) {
    if (!fileSet.has(file)) errors.push(`Missing bundle file: ${file}`);
  }

  const contentScriptBytes = byteLength(contentScript);
  if (contentScriptBytes > MAX_CONTENT_SCRIPT_BYTES) {
    errors.push(`Content script exceeds ${MAX_CONTENT_SCRIPT_BYTES} bytes: ${contentScriptBytes}`);
  }

  const totalBytes = sizes.reduce((total, size) => total + size, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) {
    errors.push(`Chrome bundle exceeds ${MAX_BUNDLE_BYTES} bytes: ${totalBytes}`);
  }

  return errors;
}

async function collectFiles(bundlePath) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        files.push(filePath);
      }
    }
  }

  await visit(bundlePath);
  return files;
}

async function main() {
  const bundlePath = process.argv[2] ?? '.output/chrome-mv3';

  try {
    const paths = await collectFiles(bundlePath);
    const files = paths.map((filePath) => normalizeFilePath(relative(bundlePath, filePath).split(sep).join('/')));
    const sizes = await Promise.all(paths.map(async (filePath) => (await stat(filePath)).size));
    const contentScriptPath = paths.find(
      (filePath) => normalizeFilePath(relative(bundlePath, filePath).split(sep).join('/')) === CONTENT_SCRIPT_FILE,
    );
    const contentScript = contentScriptPath ? await readFile(contentScriptPath) : Buffer.alloc(0);
    const errors = validateBundle({ files, contentScript, sizes });

    if (errors.length > 0) {
      process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`Verified Chrome bundle: ${bundlePath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to verify Chrome bundle at ${bundlePath}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
