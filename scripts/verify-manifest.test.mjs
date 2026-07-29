import { describe, expect, it } from 'vitest';

import { validateManifest } from './verify-manifest.mjs';

const expectedManifest = {
  content_scripts: [
    {
      all_frames: false,
      js: ['content-scripts/content.js'],
      matches: ['https://github.com/*/*/pulls*'],
      run_at: 'document_idle',
      world: 'ISOLATED',
    },
  ],
  description: 'Adds compact comment, review-thread, diff, and AI-agent summaries to GitHub pull request lists.',
  icons: {
    16: 'icon/16.png',
    32: 'icon/32.png',
    48: 'icon/48.png',
    96: 'icon/96.png',
    128: 'icon/128.png',
  },
  manifest_version: 3,
  name: 'GitHub PR Overview',
  version: '0.1.0',
};

describe('validateManifest', () => {
  it('accepts the minimal generated MV3 manifest', () => {
    expect(validateManifest(expectedManifest)).toEqual([]);
  });

  it.each([
    'action',
    'background',
    'host_permissions',
    'optional_host_permissions',
    'optional_permissions',
    'permissions',
    'storage',
    'web_accessible_resources',
  ])('rejects the unnecessary %s field', (field) => {
    expect(validateManifest({ ...expectedManifest, [field]: [] })).toContain(`Unexpected manifest field: ${field}`);
  });

  it('rejects extra content scripts and broader match patterns', () => {
    const broadContentScript = {
      ...expectedManifest.content_scripts[0],
      matches: ['https://github.com/*'],
    };

    expect(validateManifest({
      ...expectedManifest,
      content_scripts: [expectedManifest.content_scripts[0], broadContentScript],
    })).toEqual([
      'Expected exactly one content script',
      'Content script matches must be exactly https://github.com/*/*/pulls*',
    ]);
  });

  it('rejects invalid MV3 metadata and content-script settings', () => {
    expect(validateManifest({
      ...expectedManifest,
      description: 'x'.repeat(133),
      manifest_version: 2,
      name: 'WXT starter',
      version: 'v1',
      content_scripts: [{
        all_frames: true,
        js: ['content-scripts/content.js', 'remote.js'],
        matches: expectedManifest.content_scripts[0].matches,
        run_at: 'document_start',
        world: 'MAIN',
      }],
    })).toEqual([
      'manifest_version must be 3',
      'Manifest name must be GitHub PR Overview',
      'Manifest description must contain 1–132 characters',
      'Manifest version must use numeric dot notation',
      'Content script must contain only content-scripts/content.js',
      'Content script all_frames must be false',
      'Content script run_at must be document_idle',
      'Content script world must be ISOLATED',
    ]);
  });

  it('rejects missing or unexpected icon entries', () => {
    expect(validateManifest({
      ...expectedManifest,
      icons: {
        16: 'icon/16.png',
        128: 'starter.svg',
      },
    })).toContain('Manifest icons must be the packaged 16, 32, 48, 96, and 128px PNGs');
  });
});
