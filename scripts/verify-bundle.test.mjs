import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateBundle, verifyBundle } from './verify-bundle.mjs';

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
const temporaryBundles = [];
let originalExitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
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

  it.each(['background.js', 'icon/disabled/16.png'])(
    'rejects a missing required %s file',
    (missing) => {
      const files = ALLOWED_FILES.filter((file) => file !== missing);
      expect(validateBundle(validBundle({
        files,
        sizes: files.map(() => 1),
      }))).toContain(`Missing bundle file: ${missing}`);
    },
  );

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

  it('rejects non-genuine typed-array lookalikes without throwing', () => {
    const taggedUint16Array = new Uint16Array(1);
    Object.defineProperty(taggedUint16Array, Symbol.toStringTag, { value: 'Uint8Array' });
    const invalidPayloads = [
      new Proxy(Buffer.alloc(1), {}),
      new Proxy(new Uint8Array(1), {}),
      Object.create(Uint8Array.prototype),
      new DataView(new ArrayBuffer(1)),
      new Uint16Array(1),
      taggedUint16Array,
    ];

    for (const contentScript of invalidPayloads) {
      expect(() => validateBundle(validBundle({ contentScript }))).not.toThrow();
      expect(validateBundle(validBundle({ contentScript })))
        .toEqual(['Content script must be a string, Buffer, or Uint8Array']);
    }
  });

  it('measures content-script strings in UTF-8 bytes', () => {
    expect(validateBundle(validBundle({
      contentScript: 'é',
      sizes: [2, ...ALLOWED_FILES.slice(1).map(() => 1)],
    }))).toEqual([]);
    expect(validateBundle(validBundle({
      contentScript: 'é',
      sizes: [1, ...ALLOWED_FILES.slice(1).map(() => 1)],
    }))).toEqual(['Content script size does not match payload: recorded 1, actual 2']);
  });

  it('rejects a Chrome package larger than 270,000 bytes', () => {
    expect(validateBundle(validBundle({
      sizes: [1, 270_000, ...ALLOWED_FILES.slice(2).map(() => 0)],
    }))).toEqual(['Chrome bundle exceeds 270000 bytes: 270001']);
  });

  it('rejects a bundle total that overflows a safe integer', () => {
    expect(validateBundle(validBundle({
      sizes: [1, Number.MAX_SAFE_INTEGER, ...ALLOWED_FILES.slice(2).map(() => 0)],
    }))).toEqual(['Chrome bundle size total must be a safe integer']);
  });

  it('accepts content and total sizes at their exact byte limits', () => {
    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_000),
      sizes: [250_000, 20_000, ...ALLOWED_FILES.slice(2).map(() => 0)],
    }))).toEqual([]);
  });

  it('rejects content and total sizes one byte past their limits', () => {
    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_001),
      sizes: [250_001, ...ALLOWED_FILES.slice(1).map(() => 0)],
    }))).toEqual(['Content script exceeds 250000 bytes: 250001']);

    expect(validateBundle(validBundle({
      contentScript: Buffer.alloc(250_000),
      sizes: [250_000, 20_001, ...ALLOWED_FILES.slice(2).map(() => 0)],
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
    ['a missing size', { sizes: ALLOWED_FILES.slice(0, -1).map(() => 1) }, 'Expected one size per bundle file: received 12 sizes for 13 files'],
    ['an extra size', { sizes: [...ALLOWED_FILES.map(() => 1), 1] }, 'Expected one size per bundle file: received 14 sizes for 13 files'],
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
      'Missing bundle file: background.js',
      'Missing bundle file: icon/128.png',
      'Missing bundle file: icon/16.png',
      'Missing bundle file: icon/32.png',
      'Missing bundle file: icon/48.png',
      'Missing bundle file: icon/96.png',
      'Missing bundle file: icon/disabled/128.png',
      'Missing bundle file: icon/disabled/16.png',
      'Missing bundle file: icon/disabled/32.png',
      'Missing bundle file: icon/disabled/48.png',
      'Missing bundle file: icon/disabled/96.png',
      'Expected one size per bundle file: received 1 size for 2 files',
      'Invalid bundle size at index 0: expected a non-negative safe integer',
      'Content script must be a string, Buffer, or Uint8Array',
    ]);
  });

  it('reports an actionable filesystem error from the CLI', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-bundle.mjs', 'output/missing-bundle'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to verify Chrome bundle at output/missing-bundle:');
  });

  it('uses the generated WXT Chrome directory by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'verify-bundle-default-'));
    temporaryBundles.push(directory);

    const result = spawnSync(process.execPath, [resolve('scripts/verify-bundle.mjs')], {
      cwd: directory,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to verify Chrome bundle at output/chrome-mv3:');
  });

  it('verifies a complete bundle through the in-process CLI path', async () => {
    const bundlePath = await createBundle();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await verifyBundle(bundlePath);

    expect(process.exitCode).toBeUndefined();
    expect(stdout).toHaveBeenCalledWith(`Verified Chrome bundle: ${bundlePath}\n`);
  });

  it('reports an invalid bundle through the in-process CLI path', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await verifyBundle('output/missing-bundle');

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      'Failed to verify Chrome bundle at output/missing-bundle:',
    ));
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

  it('accepts the disabled icon directory but rejects other nested icon directories', async () => {
    const bundlePath = await createBundle();
    await mkdir(join(bundlePath, 'icon', 'other'), { recursive: true });

    const result = outputFor(bundlePath);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('Unexpected bundle directory: icon/disabled');
    expect(result.stderr).toContain('Unexpected bundle directory: icon/other');
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
