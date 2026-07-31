import { describe, expect, it, vi } from 'vitest';

import { createToolbarToggleController } from './toolbar-toggle';

function setup(initial = true) {
  let stored = initial;
  const action = {
    setIcon: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  };
  const readEnabled = vi.fn(async () => stored);
  const writeEnabled = vi.fn(async (enabled: boolean) => { stored = enabled; });
  return {
    action,
    controller: createToolbarToggleController({ action, readEnabled, writeEnabled }),
    readEnabled,
    stored: () => stored,
    writeEnabled,
  };
}

describe('toolbar toggle controller', () => {
  it('synchronizes the enabled icon and title on startup', async () => {
    const { action, controller } = setup(true);

    await controller.sync();

    expect(action.setIcon).toHaveBeenCalledWith({ path: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    } });
    expect(action.setTitle).toHaveBeenCalledWith({ title: 'Disable GitHub PR Overview' });
  });

  it('stores the inverse before applying disabled presentation', async () => {
    const { action, controller, stored, writeEnabled } = setup(true);

    await controller.toggle();

    expect(writeEnabled).toHaveBeenCalledWith(false);
    expect(stored()).toBe(false);
    expect(action.setIcon).toHaveBeenLastCalledWith({
      path: expect.objectContaining({ 16: 'icon/disabled/16.png' }),
    });
    expect(action.setTitle).toHaveBeenLastCalledWith({ title: 'Enable GitHub PR Overview' });
  });

  it('leaves presentation unchanged when storage rejects the toggle', async () => {
    const action = { setIcon: vi.fn(), setTitle: vi.fn() };
    const controller = createToolbarToggleController({
      action,
      readEnabled: vi.fn(async () => true),
      writeEnabled: vi.fn(async () => { throw new Error('quota'); }),
    });

    await expect(controller.toggle()).rejects.toThrow('quota');
    expect(action.setIcon).not.toHaveBeenCalled();
    expect(action.setTitle).not.toHaveBeenCalled();
  });

  it('warns, falls back to enabled after a failed read, and attempts to disable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeEnabled = vi.fn(async () => {});
    const controller = createToolbarToggleController({
      action: { setIcon: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
      readEnabled: vi.fn(async () => { throw new Error('read'); }),
      writeEnabled,
    });

    await controller.toggle();

    expect(writeEnabled).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith(
      'Unable to read toolbar enabled state; defaulting to enabled.',
    );
    warn.mockRestore();
  });

  it('keeps the stored toggle when toolbar presentation fails', async () => {
    let stored = true;
    const controller = createToolbarToggleController({
      action: {
        setIcon: vi.fn(async () => { throw new Error('icon'); }),
        setTitle: vi.fn(async () => {}),
      },
      readEnabled: vi.fn(async () => stored),
      writeEnabled: vi.fn(async (enabled) => { stored = enabled; }),
    });

    await expect(controller.toggle()).rejects.toThrow('icon');

    expect(stored).toBe(false);
  });

  it('serializes rapid clicks without losing a transition', async () => {
    const { controller, stored } = setup(true);

    await Promise.all([controller.toggle(), controller.toggle()]);

    expect(stored()).toBe(true);
  });
});
