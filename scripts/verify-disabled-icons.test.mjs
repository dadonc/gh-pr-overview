import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateDisabledIcons,
  verifyDisabledIcons,
} from './verify-disabled-icons.mjs';

const ICON_SIZES = [16, 32, 48, 96, 128];
const SOURCE_PATH = resolve('assets/icon-disabled.svg');
const ICONS_DIRECTORY = resolve('public/icon/disabled');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

async function copyDisabledIconAssets() {
  const directory = await mkdtemp(join(tmpdir(), 'verify-disabled-icons-'));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, 'icon-disabled.svg');
  const iconsDirectory = join(directory, 'disabled');
  await mkdir(iconsDirectory);
  await copyFile(SOURCE_PATH, sourcePath);
  await Promise.all(ICON_SIZES.map((size) =>
    copyFile(join(ICONS_DIRECTORY, `${size}.png`), join(iconsDirectory, `${size}.png`))));
  return { iconsDirectory, sourcePath };
}

describe('disabled icon verification', () => {
  it('regenerates deterministic grayscale+alpha PNGs from the SVG render', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'generate-disabled-icons-'));
    temporaryDirectories.push(directory);
    const iconsDirectory = join(directory, 'disabled');

    await generateDisabledIcons({ iconsDirectory, sourcePath: SOURCE_PATH });

    await expect(verifyDisabledIcons({ iconsDirectory, sourcePath: SOURCE_PATH }))
      .resolves.toEqual([]);
    for (const size of ICON_SIZES) {
      const png = await readFile(join(iconsDirectory, `${size}.png`));
      expect(png[25], `${size}px PNG color type`).toBe(4);
    }
  });

  it('accepts neutral grayscale PNGs rendered from the checked-in SVG', async () => {
    await expect(verifyDisabledIcons({
      iconsDirectory: ICONS_DIRECTORY,
      sourcePath: SOURCE_PATH,
    })).resolves.toEqual([]);
  });

  it('rejects a chromatic source palette', async () => {
    const paths = await copyDisabledIconAssets();
    const source = await readFile(paths.sourcePath, 'utf8');
    const firstColor = source.match(/#[0-9a-f]{6}/i)?.[0];
    expect(firstColor).toBeDefined();
    await writeFile(paths.sourcePath, source.replace(firstColor, '#010203'));

    const errors = await verifyDisabledIcons(paths);

    expect(errors).toContain(
      'Disabled icon SVG palette must use neutral grayscale colors: #010203',
    );
  });

  it('rejects checked PNGs that drift from a neutral SVG render', async () => {
    const paths = await copyDisabledIconAssets();
    const source = await readFile(paths.sourcePath, 'utf8');
    const firstColor = source.match(/#[0-9a-f]{6}/i)?.[0];
    expect(firstColor).toBeDefined();
    const replacement = firstColor?.toLowerCase() === '#000000' ? '#ffffff' : '#000000';
    await writeFile(paths.sourcePath, source.replace(firstColor, replacement));

    const errors = await verifyDisabledIcons(paths);

    expect(errors.some((error) =>
      error.startsWith('Disabled icon 128px PNG differs from its SVG render'))).toBe(true);
  });
});
