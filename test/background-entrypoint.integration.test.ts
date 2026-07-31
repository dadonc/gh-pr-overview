import { afterEach, expect, it, vi } from 'vitest';

const actionListeners: Array<() => void> = [];
const startupListeners: Array<() => void> = [];
const storageListeners: Array<
  (
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    areaName: string,
  ) => void
> = [];
let storedEnabled = true;
let definition!: { type?: string; main(): void };

const browserMock = {
  action: {
    onClicked: {
      addListener: vi.fn((listener: () => void) => actionListeners.push(listener)),
    },
    setIcon: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  },
  runtime: {
    onStartup: {
      addListener: vi.fn((listener: () => void) => startupListeners.push(listener)),
    },
  },
  storage: {
    local: {
      get: vi.fn(async () => ({ enabled: storedEnabled })),
      set: vi.fn(async ({ enabled }: { enabled: boolean }) => {
        storedEnabled = enabled;
      }),
    },
    onChanged: {
      addListener: vi.fn((listener: (typeof storageListeners)[number]) => {
        storageListeners.push(listener);
      }),
    },
  },
};

afterEach(() => {
  actionListeners.length = 0;
  startupListeners.length = 0;
  storageListeners.length = 0;
  storedEnabled = true;
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('registers one popup-free action and synchronizes clicks, startup, and storage changes', async () => {
  vi.stubGlobal('defineBackground', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('browser', browserMock);
  await import('../entrypoints/background');

  definition.main();

  expect(definition.type).toBe('module');
  expect(actionListeners).toHaveLength(1);
  expect(startupListeners).toHaveLength(1);
  expect(storageListeners).toHaveLength(1);
  await vi.waitFor(() => {
    expect(browserMock.action.setTitle)
      .toHaveBeenCalledWith({ title: 'Disable GitHub PR Overview' });
  });

  await actionListeners[0]!();
  await vi.waitFor(() => {
    expect(browserMock.storage.local.set).toHaveBeenCalledWith({ enabled: false });
  });

  storedEnabled = true;
  storageListeners[0]!({ enabled: { newValue: true } }, 'local');
  await vi.waitFor(() => {
    expect(browserMock.action.setTitle)
      .toHaveBeenLastCalledWith({ title: 'Disable GitHub PR Overview' });
  });

  storedEnabled = false;
  expect(startupListeners[0]!()).toBeUndefined();
  await vi.waitFor(() => {
    expect(browserMock.action.setIcon).toHaveBeenLastCalledWith({
      path: {
        16: 'icon/disabled/16.png',
        32: 'icon/disabled/32.png',
        48: 'icon/disabled/48.png',
        96: 'icon/disabled/96.png',
        128: 'icon/disabled/128.png',
      },
    });
    expect(browserMock.action.setTitle)
      .toHaveBeenLastCalledWith({ title: 'Enable GitHub PR Overview' });
  });
});

it('warns when a contained toolbar operation fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  browserMock.storage.local.set.mockRejectedValueOnce(new Error('quota'));
  vi.stubGlobal('defineBackground', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('browser', browserMock);
  await import('../entrypoints/background');
  definition.main();
  await vi.waitFor(() => {
    expect(browserMock.action.setTitle).toHaveBeenCalled();
  });

  actionListeners[0]!();

  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith('Unable to update toolbar state.', expect.any(Error));
  });
});
