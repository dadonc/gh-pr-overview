import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { validateBundle } from './verify-bundle.mjs';

const ALLOWED_FILES = [
  'content-scripts/content.js',
  'icon/128.png',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/96.png',
  'manifest.json',
];
const temporaryBundles = [];

afterEach(async () => {
  await Promise.all(temporaryBundles.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function validBundle(overrides = {}) {
  return {
    files: ALLOWED_FILES,
    contentScript: Buffer.alloc(1),
    sizes: ALLOWED_FILES.map(() => 1),
    ...overrides,
  };
}

function outputFor(bundlePath) {
  return spawnSync(process.execPath, ['scripts/verify-bundle.mjs', bundlePath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

async function createBundle() {
  const bundlePath = await mkdtemp(join(tmpdir(), 'verify-bundle-'));
  temporaryBundles.push(bundlePath);

  await Promise.all(ALLOWED_FILES.map(async (file) => {
    const path = join(bundlePath, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'x');
  }));

  return bundlePath;
}

describe('validateBundle', () => {
  it('accepts the exact unpacked Chrome extension package', () => {
    expect(validateBundle(validBundle())).toEqual([]);
  });

  it('rejects files outside the exact package allowlist', () => {
    expect(validateBundle(validBundle({
      files: [...ALLOWED_FILES, 'content-scripts/content.css'],
      sizes: [...ALLOWED_FILES.map(() => 1), 1],
    }))).toEqual(['Unexpected bundle file: content-scripts/content.css']);
  });

  it('rejects a missing required package file', () => {
    expect(validateBundle(validBundle({
      files: ALLOWED_FILES.filter((file) => file !== 'icon/16.png'),
      sizes: ALLOWED_FILES.filter((file) => file !== 'icon/16.png').map(() => 1),
    }))).toEqual(['Missing bundle file: icon/16.png']);
  });

  it('rejects a content script larger than 250,000 bytes', () => {
    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_001),
      sizes: [250_001, ...ALLOWED_FILES.slice(1).map(() => 1)],
    }))).toEqual(['Content script exceeds 250000 bytes: 250001']);
  });

  it('uses true typed-array view lengths despite shadowed byteLength properties', () => {
    const oversizedBuffer = Buffer.alloc(250_001);
    Object.defineProperty(oversizedBuffer, 'byteLength', { value: 1 });
    const oversizedUint8Array = new Uint8Array(250_001);
    Object.defineProperty(oversizedUint8Array, 'byteLength', { value: 1 });

    for (const contentScript of [oversizedBuffer, oversizedUint8Array]) {
      expect(validateBundle(validBundle({
        contentScript,
        sizes: [1, ...ALLOWED_FILES.slice(1).map(() => 1)],
      }))).toEqual([
        'Content script exceeds 250000 bytes: 250001',
        'Content script size does not match payload: recorded 1, actual 250001',
      ]);
    }

    const slicedView = new Uint8Array(300_000).subarray(50_000, 250_001);
    expect(validateBundle(validBundle({
      contentScript: slicedView,
      sizes: [200_001, ...ALLOWED_FILES.slice(1).map(() => 1)],
    }))).toEqual([]);
    expect(validateBundle(validBundle({
      contentScript: slicedView,
      sizes: [200_000, ...ALLOWED_FILES.slice(1).map(() => 1)],
    }))).toEqual(['Content script size does not match payload: recorded 200000, actual 200001']);
  });

  it('rejects a Chrome package larger than 270,000 bytes', () => {
    expect(validateBundle(validBundle({
      sizes: [1, 270_000, 0, 0, 0, 0, 0],
    }))).toEqual(['Chrome bundle exceeds 270000 bytes: 270001']);
  });

  it('rejects a bundle total that overflows a safe integer', () => {
    expect(validateBundle(validBundle({
      sizes: [1, Number.MAX_SAFE_INTEGER, 0, 0, 0, 0, 0],
    }))).toEqual(['Chrome bundle size total must be a safe integer']);
  });

  it('accepts content and total sizes at their exact byte limits', () => {
    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_000),
      sizes: [250_000, 20_000, 0, 0, 0, 0, 0],
    }))).toEqual([]);
  });

  it('rejects content and total sizes one byte past their limits', () => {
    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_001),
      sizes: [250_001, 0, 0, 0, 0, 0, 0],
    }))).toEqual(['Content script exceeds 250000 bytes: 250001']);

    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_000),
      sizes: [250_000, 20_001, 0, 0, 0, 0, 0],
    }))).toEqual(['Chrome bundle exceeds 270000 bytes: 270001']);
  });

  it('normalizes portable paths but rejects duplicate normalized files', () => {
    expect(validateBundle(validBundle({
      files: ALLOWED_FILES.map((file) => file.replace('/', '\\')),
    }))).toEqual([]);

    expect(validateBundle(validBundle({
      files: [...ALLOWED_FILES, './manifest.json'],
      sizes: [...ALLOWED_FILES.map(() => 1), 1],
    }))).toEqual(['Duplicate bundle file: manifest.json']);
  });

  it.each([
    ['a missing size', { sizes: ALLOWED_FILES.slice(0, -1).map(() => 1) }, 'Expected one size per bundle file: received 6 sizes for 7 files'],
    ['an extra size', { sizes: [...ALLOWED_FILES.map(() => 1), 1] }, 'Expected one size per bundle file: received 8 sizes for 7 files'],
    ['a NaN size', { sizes: [Number.NaN, ...ALLOWED_FILES.slice(1).map(() => 1)] }, 'Invalid bundle size at index 0: expected a non-negative safe integer'],
    ['a negative size', { sizes: [-1, ...ALLOWED_FILES.slice(1).map(() => 1)] }, 'Invalid bundle size at index 0: expected a non-negative safe integer'],
    ['an unsafe size', { sizes: [Number.MAX_SAFE_INTEGER + 1, ...ALLOWED_FILES.slice(1).map(() => 1)] }, 'Invalid bundle size at index 0: expected a non-negative safe integer'],
  ])('rejects %s', (_name, overrides, error) => {
    expect(validateBundle(validBundle(overrides))).toContain(error);
  });

  it('rejects malformed payloads and mismatched content-script sizes', () => {
    expect(validateBundle({ files: null, contentScript: Buffer.alloc(0), sizes: [] }))
      .toContain('Bundle files must be an array');
    expect(validateBundle({ files: ALLOWED_FILES, contentScript: Buffer.alloc(1), sizes: null }))
      .toContain('Bundle sizes must be an array');
    expect(validateBundle(validBundle({ contentScript: { byteLength: 1 } })))
      .toContain('Content script must be a string, Buffer, or Uint8Array');
    expect(validateBundle(validBundle({ sizes: [2, ...ALLOWED_FILES.slice(1).map(() => 1)] })))
      .toContain('Content script size does not match payload: recorded 2, actual 1');
  });

  it('reports compound invalid inputs in deterministic order', () => {
    const payload = {
      files: ['manifest.json', './manifest.json'],
      contentScript: { byteLength: 2 },
      sizes: [Number.NaN],
    };

    expect(validateBundle(payload)).toEqual([
      'Duplicate bundle file: manifest.json',
      'Missing bundle file: content-scripts/content.js',
      'Missing bundle file: icon/128.png',
      'Missing bundle file: icon/16.png',
      'Missing bundle file: icon/32.png',
      'Missing bundle file: icon/48.png',
      'Missing bundle file: icon/96.png',
      'Expected one size per bundle file: received 1 size for 2 files',
      'Invalid bundle size at index 0: expected a non-negative safe integer',
      'Content script must be a string, Buffer, or Uint8Array',
    ]);
  });

  it('reports an actionable filesystem error from the CLI', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-bundle.mjs', '.output/missing-bundle'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to verify Chrome bundle at .output/missing-bundle:');
  });

  it('rejects symbolic links and unexpected empty directories in a bundle', async () => {
    const bundlePath = await createBundle();
    await symlink(join(bundlePath, 'manifest.json'), join(bundlePath, 'icon', 'linked-manifest.json'));
    await mkdir(join(bundlePath, 'unused'), { recursive: true });

    const result = outputFor(bundlePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported bundle filesystem entry: icon/linked-manifest.json (symbolic link)');
    expect(result.stderr).toContain('Unexpected bundle directory: unused');
  });

  it('rejects a symbolic-link bundle root without traversing it', async () => {
    const bundlePath = await createBundle();
    const linkedBundlePath = `${bundlePath}-link`;
    temporaryBundles.push(linkedBundlePath);
    await symlink(bundlePath, linkedBundlePath);

    const result = outputFor(linkedBundlePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Bundle root must not be a symbolic link: ${linkedBundlePath}`);
  });

  it('rejects special filesystem entries without silently ignoring them', async () => {
    const bundlePath = await createBundle();
    const fifoPath = join(bundlePath, 'icon', 'bundle.fifo');
    execFileSync('mkfifo', [fifoPath]);

    const result = outputFor(bundlePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported bundle filesystem entry: icon/bundle.fifo (special file)');
  });
});
