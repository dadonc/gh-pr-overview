import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_ICON_PATHS,
  ENABLED_STORAGE_KEY,
  INACTIVE_ICON_PATHS,
  enabledFromStorageChange,
  enabledFromStoredValue,
  readEnabled,
  writeEnabled,
} from './extension-toggle';

describe('extension toggle contract', () => {
  it.each([
    [undefined, true],
    [null, true],
    ['false', true],
    [0, true],
    [{}, true],
    [true, true],
    [false, false],
  ])('maps stored value %j to %s', (value, expected) => {
    expect(enabledFromStoredValue(value)).toBe(expected);
  });

  it('reads only the enabled key and defaults malformed data to enabled', async () => {
    const storage = {
      get: vi.fn(async () => ({ enabled: 'invalid' })),
      set: vi.fn(),
    };

    await expect(readEnabled(storage)).resolves.toBe(true);
    expect(storage.get).toHaveBeenCalledWith(ENABLED_STORAGE_KEY);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('writes exactly one boolean preference', async () => {
    const storage = { get: vi.fn(), set: vi.fn(async () => {}) };

    await writeEnabled(storage, false);

    expect(storage.set).toHaveBeenCalledWith({ enabled: false });
  });

  it('extracts only local enabled changes and treats removal as enabled', () => {
    expect(enabledFromStorageChange({ enabled: { newValue: false } }, 'local')).toBe(false);
    expect(enabledFromStorageChange({ enabled: {} }, 'local')).toBe(true);
    expect(enabledFromStorageChange({ enabled: { newValue: false } }, 'sync')).toBeUndefined();
    expect(enabledFromStorageChange({ other: { newValue: false } }, 'local')).toBeUndefined();
  });

  it('publishes the exact active and inactive icon paths', () => {
    expect(ACTIVE_ICON_PATHS).toEqual({
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    });
    expect(INACTIVE_ICON_PATHS).toEqual({
      16: 'icon/disabled/16.png',
      32: 'icon/disabled/32.png',
      48: 'icon/disabled/48.png',
      96: 'icon/disabled/96.png',
      128: 'icon/disabled/128.png',
    });
  });
});
