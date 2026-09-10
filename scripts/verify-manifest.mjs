import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const EXPECTED_MATCH = 'https://github.com/*';
const EXPECTED_NAME = 'GitHub PR Overview';
const EXPECTED_ICONS = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  96: 'icon/96.png',
  128: 'icon/128.png',
};
const ACTION_FIELDS = new Set(['default_icon']);
const ALLOWED_FIELDS = new Set([
  'action',
  'background',
  'content_scripts',
  'description',
  'icons',
  'manifest_version',
  'name',
  'permissions',
  'version',
]);
const CONTENT_SCRIPT_FIELDS = new Set([
  'all_frames',
  'js',
  'matches',
  'run_at',
  'world',
]);

function equals(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateManifest(manifest) {
  const errors = [];

  for (const field of Object.keys(manifest).sort()) {
    if (!ALLOWED_FIELDS.has(field)) errors.push(`Unexpected manifest field: ${field}`);
  }

  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
  if (manifest.name !== EXPECTED_NAME) errors.push(`Manifest name must be ${EXPECTED_NAME}`);
  if (typeof manifest.description !== 'string' || manifest.description.length < 1 || manifest.description.length > 132) {
    errors.push('Manifest description must contain 1–132 characters');
  }
  if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    errors.push('Manifest version must use numeric dot notation');
  }
  if (
    !manifest.icons ||
    !equals(Object.keys(manifest.icons).sort((left, right) => Number(left) - Number(right)), Object.keys(EXPECTED_ICONS)) ||
    Object.entries(EXPECTED_ICONS).some(([size, path]) => manifest.icons[size] !== path)
  ) {
    errors.push('Manifest icons must be the packaged 16, 32, 48, 96, and 128px PNGs');
  }

  if (!isPlainObject(manifest.action)) {
    errors.push('Manifest action must be a plain object');
  } else {
    for (const field of Object.keys(manifest.action).sort()) {
      if (!ACTION_FIELDS.has(field)) errors.push(`Unexpected action field: ${field}`);
    }
    if (
      !isPlainObject(manifest.action.default_icon) ||
      !equals(
        Object.keys(manifest.action.default_icon)
          .sort((left, right) => Number(left) - Number(right)),
        Object.keys(EXPECTED_ICONS),
      ) ||
      Object.entries(EXPECTED_ICONS)
        .some(([size, path]) => manifest.action.default_icon[size] !== path)
    ) {
      errors.push(
        'Action icons must be the packaged 16, 32, 48, 96, and 128px PNGs',
      );
    }
  }

  if (!isPlainObject(manifest.background)) {
    errors.push('Manifest background must be a plain object');
  } else {
    for (const field of Object.keys(manifest.background).sort()) {
      if (!['service_worker', 'type'].includes(field)) {
        errors.push(`Unexpected background field: ${field}`);
      }
    }
    if (manifest.background.service_worker !== 'background.js') {
      errors.push('Background service worker must be background.js');
    }
    if (manifest.background.type !== 'module') {
      errors.push('Background service worker type must be module');
    }
  }

  if (!equals(manifest.permissions, ['storage'])) {
    errors.push('Manifest permissions must be exactly storage');
  }

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (contentScripts.length !== 1) errors.push('Expected exactly one content script');

  const contentScript = contentScripts[0];
  const invalidSoleContentScript = contentScripts.length === 1 && !isPlainObject(contentScript);
  if (invalidSoleContentScript) {
    errors.push('content_scripts[0] must be a plain object');
  }

  if (!invalidSoleContentScript) {
    const matches = contentScripts.flatMap((entry) => Array.isArray(entry?.matches) ? entry.matches : []);
    if (!equals(matches, [EXPECTED_MATCH])) errors.push(`Content script matches must be exactly ${EXPECTED_MATCH}`);
  }

  if (isPlainObject(contentScript)) {
    for (const field of Object.keys(contentScript).sort()) {
      if (!CONTENT_SCRIPT_FIELDS.has(field)) {
        errors.push(`Unexpected content_scripts[0] field: ${field}`);
      }
    }
    for (const field of CONTENT_SCRIPT_FIELDS) {
      if (!(field in contentScript)) {
        errors.push(`Missing content_scripts[0] field: ${field}`);
      }
    }
    if (!equals(contentScript.js, ['content-scripts/content.js'])) {
      errors.push('Content script must contain only content-scripts/content.js');
    }
    if (contentScript.all_frames !== false) errors.push('Content script all_frames must be false');
    if (contentScript.run_at !== 'document_idle') errors.push('Content script run_at must be document_idle');
    if (contentScript.world !== 'ISOLATED') errors.push('Content script world must be ISOLATED');
  }

  return errors;
}

export async function verifyManifest(manifestPath = 'output/chrome-mv3/manifest.json') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const errors = validateManifest(manifest);

  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Verified minimal MV3 manifest: ${manifestPath}\n`);
}

async function main() {
  await verifyManifest(process.argv[2] ?? 'output/chrome-mv3/manifest.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
