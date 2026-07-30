import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

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

function validBundle(overrides = {}) {
  return {
    files: ALLOWED_FILES,
    contentScript: Buffer.alloc(1),
    sizes: ALLOWED_FILES.map(() => 1),
    ...overrides,
  };
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
    }))).toEqual(['Content script exceeds 250000 bytes: 250001']);
  });

  it('rejects a Chrome package larger than 270,000 bytes', () => {
    expect(validateBundle(validBundle({
      sizes: [270_001],
    }))).toEqual(['Chrome bundle exceeds 270000 bytes: 270001']);
  });

  it('reports an actionable filesystem error from the CLI', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-bundle.mjs', '.output/missing-bundle'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Failed to verify Chrome bundle at .output/missing-bundle:');
  });
});
