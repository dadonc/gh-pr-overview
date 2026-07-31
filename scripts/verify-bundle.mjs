import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isUint8Array } from 'node:util/types';

const ALLOWED_FILES = [
  'content-scripts/content.js',
  'background.js',
  'icon/128.png',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/96.png',
  'icon/disabled/128.png',
  'icon/disabled/16.png',
  'icon/disabled/32.png',
  'icon/disabled/48.png',
  'icon/disabled/96.png',
  'manifest.json',
];
const ALLOWED_FILE_SET = new Set(ALLOWED_FILES);
const ALLOWED_DIRECTORIES = new Set(['content-scripts', 'icon', 'icon/disabled']);
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';
const MAX_CONTENT_SCRIPT_BYTES = 250_000;
const MAX_BUNDLE_BYTES = 270_000;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
).get;

function normalizeFilePath(file) {
  return posix.normalize(file.replaceAll('\\', '/')).replace(/^(?:\.\/)+/, '');
}

function isContentScriptPayload(value) {
  if (typeof value === 'string') return true;
  try {
    return ArrayBuffer.isView(value) && isUint8Array(value);
  } catch {
    return false;
  }
}

function contentScriptByteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return typedArrayByteLength.call(value);
  } catch {
    return null;
  }
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function validateBundle(input) {
  const { files, contentScript, sizes } = input && typeof input === 'object' ? input : {};
  const errors = [];
  const fileValues = Array.isArray(files) ? files : [];
  const sizeValues = Array.isArray(sizes) ? sizes : [];

  if (!Array.isArray(files)) errors.push('Bundle files must be an array');
  if (!Array.isArray(sizes)) errors.push('Bundle sizes must be an array');

  const normalizedFiles = [];
  fileValues.forEach((file, index) => {
    if (typeof file !== 'string') {
      errors.push(`Invalid bundle file at index ${index}: expected a string`);
      return;
    }
    normalizedFiles.push({ index, path: normalizeFilePath(file) });
  });

  const paths = normalizedFiles.map(({ path }) => path).sort();
  const fileCounts = new Map();
  for (const path of paths) fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
  for (const path of [...fileCounts.keys()].sort()) {
    if (fileCounts.get(path) > 1) errors.push(`Duplicate bundle file: ${path}`);
  }
  for (const path of paths) {
    if (!ALLOWED_FILE_SET.has(path)) errors.push(`Unexpected bundle file: ${path}`);
  }

  const fileSet = new Set(paths);
  for (const file of ALLOWED_FILES) {
    if (!fileSet.has(file)) errors.push(`Missing bundle file: ${file}`);
  }

  const hasSizes = Array.isArray(sizes);
  const hasMatchingSizeCount = hasSizes && sizeValues.length === fileValues.length;
  if (hasSizes && !hasMatchingSizeCount) {
    errors.push(`Expected one size per bundle file: received ${sizeValues.length} ${plural(sizeValues.length, 'size')} for ${fileValues.length} ${plural(fileValues.length, 'file')}`);
  }

  const validSizes = sizeValues.map((size, index) => {
    const valid = Number.isSafeInteger(size) && size >= 0;
    if (!valid) errors.push(`Invalid bundle size at index ${index}: expected a non-negative safe integer`);
    return valid;
  });

  const measuredContentScriptSize = isContentScriptPayload(contentScript)
    ? contentScriptByteLength(contentScript)
    : null;
  const validContentScript = measuredContentScriptSize !== null;
  if (!validContentScript) {
    errors.push('Content script must be a string, Buffer, or Uint8Array');
  }

  const actualContentScriptSize = validContentScript ? measuredContentScriptSize : 0;
  if (validContentScript && actualContentScriptSize > MAX_CONTENT_SCRIPT_BYTES) {
    errors.push(`Content script exceeds ${MAX_CONTENT_SCRIPT_BYTES} bytes: ${actualContentScriptSize}`);
  }

  const contentScriptEntries = normalizedFiles.filter(({ path }) => path === CONTENT_SCRIPT_FILE);
  if (validContentScript && hasMatchingSizeCount && validSizes.every(Boolean) && contentScriptEntries.length === 1) {
    const recordedSize = sizeValues[contentScriptEntries[0].index];
    if (recordedSize !== actualContentScriptSize) {
      errors.push(`Content script size does not match payload: recorded ${recordedSize}, actual ${actualContentScriptSize}`);
    }
  }

  if (hasMatchingSizeCount && validSizes.every(Boolean)) {
    let totalBytes = 0;
    for (const size of sizeValues) {
      if (totalBytes > Number.MAX_SAFE_INTEGER - size) {
        errors.push('Chrome bundle size total must be a safe integer');
        break;
      }
      totalBytes += size;
    }
    if (Number.isSafeInteger(totalBytes) && totalBytes > MAX_BUNDLE_BYTES) {
      errors.push(`Chrome bundle exceeds ${MAX_BUNDLE_BYTES} bytes: ${totalBytes}`);
    }
  }

  return errors;
}

function relativeBundlePath(bundlePath, filePath) {
  return normalizeFilePath(relative(bundlePath, filePath).split(sep).join('/'));
}

function filesystemError(action, filePath, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `${action}: ${filePath}: ${message}`;
}

async function scanBundle(bundlePath) {
  const errors = [];
  const records = [];

  const rootMetadata = await lstat(bundlePath);
  if (rootMetadata.isSymbolicLink()) {
    return { errors: [`Bundle root must not be a symbolic link: ${bundlePath}`], records };
  }
  if (!rootMetadata.isDirectory()) {
    return { errors: [`Bundle root is not a directory: ${bundlePath}`], records };
  }

  async function scanDirectory(directory, directoryPath) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(filesystemError('Unable to read bundle directory', directoryPath || '.', error));
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(directory, entry.name);
      const path = relativeBundlePath(bundlePath, filePath);
      let metadata;
      try {
        metadata = await lstat(filePath);
      } catch (error) {
        errors.push(filesystemError('Unable to inspect bundle entry', path, error));
        continue;
      }

      if (metadata.isSymbolicLink()) {
        errors.push(`Unsupported bundle filesystem entry: ${path} (symbolic link)`);
      } else if (metadata.isDirectory()) {
        if (ALLOWED_DIRECTORIES.has(path)) {
          await scanDirectory(filePath, path);
        } else {
          errors.push(`Unexpected bundle directory: ${path}`);
        }
      } else if (metadata.isFile()) {
        records.push({ path, filePath });
      } else {
        errors.push(`Unsupported bundle filesystem entry: ${path} (special file)`);
      }
    }
  }

  await scanDirectory(bundlePath, '');
  return { errors, records: records.sort((left, right) => left.path.localeCompare(right.path)) };
}

async function readBundleFiles(records) {
  const errors = [];
  const files = [];
  const sizes = [];
  let contentScript = Buffer.alloc(0);

  for (const record of records) {
    try {
      const metadata = await lstat(record.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        errors.push(`Unsupported bundle filesystem entry: ${record.path} (not a regular file)`);
        continue;
      }
      const content = await readFile(record.filePath);
      files.push(record.path);
      sizes.push(content.byteLength);
      if (record.path === CONTENT_SCRIPT_FILE) contentScript = content;
    } catch (error) {
      errors.push(filesystemError('Unable to read bundle file', record.path, error));
    }
  }

  return { contentScript, errors, files, sizes };
}

export async function verifyBundle(bundlePath = 'output/chrome-mv3') {
  try {
    const scan = await scanBundle(bundlePath);
    const bundle = await readBundleFiles(scan.records);
    const errors = [...scan.errors, ...bundle.errors, ...validateBundle(bundle)];

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

async function main() {
  await verifyBundle(process.argv[2] ?? 'output/chrome-mv3');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
