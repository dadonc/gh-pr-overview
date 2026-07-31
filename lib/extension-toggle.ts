export const ENABLED_STORAGE_KEY = 'enabled' as const;

type IconSize = 16 | 32 | 48 | 96 | 128;
export type IconPaths = Record<IconSize, string>;

export const ACTIVE_ICON_PATHS: IconPaths = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  96: 'icon/96.png',
  128: 'icon/128.png',
};

export const INACTIVE_ICON_PATHS: IconPaths = {
  16: 'icon/disabled/16.png',
  32: 'icon/disabled/32.png',
  48: 'icon/disabled/48.png',
  96: 'icon/disabled/96.png',
  128: 'icon/disabled/128.png',
};

export interface StorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

export interface LocalStoragePort {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function enabledFromStoredValue(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

export function enabledFromStorageChange(
  changes: Record<string, StorageChange>,
  areaName: string,
): boolean | undefined {
  if (areaName !== 'local' || !(ENABLED_STORAGE_KEY in changes)) return undefined;
  return enabledFromStoredValue(changes[ENABLED_STORAGE_KEY]?.newValue);
}

export async function readEnabled(storage: LocalStoragePort): Promise<boolean> {
  try {
    const values = await storage.get(ENABLED_STORAGE_KEY);
    return enabledFromStoredValue(values[ENABLED_STORAGE_KEY]);
  } catch {
    console.warn('Unable to read extension enabled preference; defaulting to enabled.');
    return true;
  }
}

export async function writeEnabled(
  storage: LocalStoragePort,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [ENABLED_STORAGE_KEY]: enabled });
}
