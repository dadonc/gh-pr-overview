import {
  ACTIVE_ICON_PATHS,
  INACTIVE_ICON_PATHS,
  type IconPaths,
} from './extension-toggle';

const ENABLED_TITLE = 'Disable GitHub PR Overview';
const DISABLED_TITLE = 'Enable GitHub PR Overview';

export interface ToolbarActionPort {
  setIcon(details: { path: IconPaths }): Promise<void>;
  setTitle(details: { title: string }): Promise<void>;
}

export interface ToolbarToggleOptions {
  action: ToolbarActionPort;
  readEnabled(): Promise<boolean>;
  writeEnabled(enabled: boolean): Promise<void>;
}

export interface ToolbarToggleController {
  sync(): Promise<void>;
  toggle(): Promise<void>;
}

export function createToolbarToggleController(
  options: ToolbarToggleOptions,
): ToolbarToggleController {
  let transition = Promise.resolve();

  const applyNow = async (enabled: boolean) => {
    await options.action.setIcon({
      path: enabled ? ACTIVE_ICON_PATHS : INACTIVE_ICON_PATHS,
    });
    await options.action.setTitle({
      title: enabled ? ENABLED_TITLE : DISABLED_TITLE,
    });
  };

  const readWithDefault = async () => {
    try {
      return await options.readEnabled();
    } catch {
      console.warn('Unable to read toolbar enabled state; defaulting to enabled.');
      return true;
    }
  };

  const enqueue = (operation: () => Promise<void>) => {
    const next = transition
      .catch((error: unknown) => {
        console.warn('Previous toolbar update failed; continuing queued transition.', error);
      })
      .then(operation);
    transition = next;
    return next;
  };

  const sync = () => enqueue(async () => {
    await applyNow(await readWithDefault());
  });

  const toggle = () => enqueue(async () => {
    const enabled = await readWithDefault();
    const newEnabled = !enabled;
    await options.writeEnabled(newEnabled);
    await applyNow(newEnabled);
  });

  return { sync, toggle };
}
