import {
  enabledFromStorageChange,
  readEnabled,
  writeEnabled,
} from '../lib/extension-toggle';
import { createToolbarToggleController } from '../lib/toolbar-toggle';

export default defineBackground({
  type: 'module',
  main() {
    const controller = createToolbarToggleController({
      action: browser.action,
      readEnabled: () => readEnabled(browser.storage.local),
      writeEnabled: (enabled) => writeEnabled(browser.storage.local, enabled),
    });
    const contain = (operation: Promise<void>) => {
      void operation.catch((error: unknown) => {
        console.warn('Unable to update toolbar state.', error);
      });
    };

    contain(controller.sync());
    browser.runtime.onStartup.addListener(() => contain(controller.sync()));
    browser.action.onClicked.addListener(() => contain(controller.toggle()));
    browser.storage.onChanged.addListener((changes, areaName) => {
      const enabled = enabledFromStorageChange(changes, areaName);
      if (enabled !== undefined) contain(controller.sync());
    });
  },
});
