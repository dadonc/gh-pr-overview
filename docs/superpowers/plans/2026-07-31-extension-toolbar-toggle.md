# Extension Toolbar Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, global, one-click toolbar toggle that immediately enables or disables GitHub PR Overview in every open matching GitHub tab and reflects the state with full-color or dimmed grayscale icons.

**Architecture:** A focused shared module defines the local-storage contract and static icon paths. A WXT Manifest V3 background service worker serializes toolbar clicks and owns toolbar presentation, while the content entrypoint observes the same stored boolean and drives a reversible content runtime that creates or destroys a fresh page reconciler without reloading tabs.

**Tech Stack:** TypeScript 5.9, WXT 0.20, React 19, Chrome Manifest V3 `action` and `storage` APIs, Vitest 4, Playwright 1.62, Chromium, SVG, PNG.

## Global Constraints

- The preference key is exactly `enabled` in `chrome.storage.local`.
- A missing, unreadable, or malformed stored value means enabled.
- The extension defaults to enabled on first install.
- The toggle is global and persistent within the current browser profile; it is not synchronized across devices.
- A successful toggle applies immediately to every open matching GitHub tab without reloading.
- The enabled toolbar icons are exactly `icon/{size}.png`.
- The disabled toolbar icons are exactly `icon/disabled/{size}.png`.
- Both icon families contain 16, 32, 48, 96, and 128 pixel PNGs.
- Enabled uses the existing full-color artwork; disabled uses the same geometry and transparency with dimmed grayscale artwork and no badge, text, slash, or new symbol.
- The enabled title is exactly `Disable GitHub PR Overview`.
- The disabled title is exactly `Enable GitHub PR Overview`.
- The action has no popup.
- The only new extension permission is `storage`.
- Keep the existing content-script match exactly `https://github.com/*/*/pulls*`.
- Do not add host permissions, optional permissions, web-accessible resources, analytics, or storage of GitHub data.
- Preserve all unrelated workspace changes. Do not begin implementation while the repository has unresolved conflicts in files this plan modifies.

---

### Task 1: Define the shared preference and icon contract

**Files:**
- Create: `lib/extension-toggle.ts`
- Create: `lib/extension-toggle.test.ts`

**Interfaces:**
- Produces: `ENABLED_STORAGE_KEY: 'enabled'`.
- Produces: `ACTIVE_ICON_PATHS` and `INACTIVE_ICON_PATHS`, each typed as `Record<16 | 32 | 48 | 96 | 128, string>`.
- Produces: `enabledFromStoredValue(value: unknown): boolean`.
- Produces: `enabledFromStorageChange(changes: Record<string, StorageChange>, areaName: string): boolean | undefined`.
- Produces: `readEnabled(storage: LocalStoragePort): Promise<boolean>`.
- Produces: `writeEnabled(storage: LocalStoragePort, enabled: boolean): Promise<void>`.
- Consumes: a narrow `LocalStoragePort` with Promise-based `get` and `set`.

- [ ] **Step 1: Write the failing shared-contract tests**

Create `lib/extension-toggle.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx vitest run lib/extension-toggle.test.ts
```

Expected: FAIL because `lib/extension-toggle.ts` does not exist.

- [ ] **Step 3: Implement the narrow shared contract**

Create `lib/extension-toggle.ts`:

```ts
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
  const values = await storage.get(ENABLED_STORAGE_KEY);
  return enabledFromStoredValue(values[ENABLED_STORAGE_KEY]);
}

export async function writeEnabled(
  storage: LocalStoragePort,
  enabled: boolean,
): Promise<void> {
  await storage.set({ [ENABLED_STORAGE_KEY]: enabled });
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npx vitest run lib/extension-toggle.test.ts
npm run compile
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the shared contract**

```bash
git add lib/extension-toggle.ts lib/extension-toggle.test.ts
git commit -m "feat: define extension toggle state"
```

---

### Task 2: Add the popup-free toolbar action, icons, and strict package contract

**Files:**
- Create: `assets/icon-disabled.svg`
- Create: `public/icon/disabled/16.png`
- Create: `public/icon/disabled/32.png`
- Create: `public/icon/disabled/48.png`
- Create: `public/icon/disabled/96.png`
- Create: `public/icon/disabled/128.png`
- Create: `lib/toolbar-toggle.ts`
- Create: `lib/toolbar-toggle.test.ts`
- Create: `entrypoints/background.ts`
- Create: `test/background-entrypoint.integration.test.ts`
- Modify: `wxt.config.ts`
- Modify: `scripts/verify-manifest.mjs`
- Modify: `scripts/verify-manifest.test.mjs`
- Modify: `scripts/verify-bundle.mjs`
- Modify: `scripts/verify-bundle.test.mjs`

**Interfaces:**
- Consumes: `readEnabled`, `writeEnabled`, `enabledFromStorageChange`, `ACTIVE_ICON_PATHS`, and `INACTIVE_ICON_PATHS` from Task 1.
- Produces: `createToolbarToggleController(options: ToolbarToggleOptions): ToolbarToggleController`.
- Produces: `ToolbarToggleController.sync(): Promise<void>`.
- Produces: `ToolbarToggleController.toggle(): Promise<void>`, serialized in call order.
- Produces: a WXT module background service worker with one action listener and one storage-change listener.
- Produces: a generated MV3 manifest containing the exact action, background, and `storage` permission.

- [ ] **Step 1: Write failing controller and background-entrypoint tests**

Create `lib/toolbar-toggle.test.ts` with tests for startup synchronization,
successful toggles, failed writes, read fallback, storage-event application,
and rapid-click serialization:

```ts
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

  it('falls back to enabled after a failed read and attempts to disable', async () => {
    const writeEnabled = vi.fn(async () => {});
    const controller = createToolbarToggleController({
      action: { setIcon: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
      readEnabled: vi.fn(async () => { throw new Error('read'); }),
      writeEnabled,
    });

    await controller.toggle();

    expect(writeEnabled).toHaveBeenCalledWith(false);
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
```

Create `test/background-entrypoint.integration.test.ts` and stub
`defineBackground` plus a narrow `browser` object. Capture the registered
`action.onClicked` and `storage.onChanged` listeners, run `definition.main()`,
and assert:

```ts
import { afterEach, expect, it, vi } from 'vitest';

const actionListeners: Array<() => void> = [];
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
  storage: {
    local: {
      get: vi.fn(async () => ({ enabled: storedEnabled })),
      set: vi.fn(async ({ enabled }: { enabled: boolean }) => {
        storedEnabled = enabled;
      }),
    },
    onChanged: {
      addListener: vi.fn((listener) => storageListeners.push(listener)),
    },
  },
};

afterEach(() => {
  actionListeners.length = 0;
  storageListeners.length = 0;
  storedEnabled = true;
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('registers one popup-free action and synchronizes clicks and storage changes', async () => {
  vi.stubGlobal('defineBackground', (value: typeof definition) => {
    definition = value;
    return value;
  });
  vi.stubGlobal('browser', browserMock);
  await import('../entrypoints/background');

  definition.main();

expect(definition.type).toBe('module');
expect(actionListeners).toHaveLength(1);
expect(storageListeners).toHaveLength(1);
await vi.waitFor(() => {
  expect(browserMock.action.setTitle)
    .toHaveBeenCalledWith({ title: 'Disable GitHub PR Overview' });
});

await actionListeners[0]!();
expect(browserMock.storage.local.set).toHaveBeenCalledWith({ enabled: false });

storedEnabled = true;
storageListeners[0]!({ enabled: { newValue: true } }, 'local');
await vi.waitFor(() => {
  expect(browserMock.action.setTitle)
    .toHaveBeenLastCalledWith({ title: 'Disable GitHub PR Overview' });
});
});
```

- [ ] **Step 2: Update verifier tests to describe the exact new package**

In `scripts/verify-manifest.test.mjs`, change `expectedManifest` to include:

```js
action: {
  default_icon: {
    16: 'icon/16.png',
    32: 'icon/32.png',
    48: 'icon/48.png',
    96: 'icon/96.png',
    128: 'icon/128.png',
  },
},
background: {
  service_worker: 'background.js',
  type: 'module',
},
permissions: ['storage'],
```

Replace the old test that rejects all `action`, `background`, and `permissions`
fields with these focused cases:

```js
it('accepts the exact popup-free action, module worker, and storage permission', () => {
  expect(validateManifest(expectedManifest)).toEqual([]);
});

it('rejects a popup and non-packaged action icon', () => {
  expect(validateManifest({
    ...expectedManifest,
    action: {
      ...expectedManifest.action,
      default_icon: { 16: 'other.png' },
      default_popup: 'popup.html',
    },
  })).toEqual([
    'Unexpected action field: default_popup',
    'Action icons must be the packaged 16, 32, 48, 96, and 128px PNGs',
  ]);
});

it('rejects extra permissions and a non-module background worker', () => {
  expect(validateManifest({
    ...expectedManifest,
    background: { service_worker: 'worker.js' },
    permissions: ['storage', 'tabs'],
  })).toEqual([
    'Background service worker must be background.js',
    'Background service worker type must be module',
    'Manifest permissions must be exactly storage',
  ]);
});

it.each([
  'host_permissions',
  'optional_host_permissions',
  'optional_permissions',
  'web_accessible_resources',
])('rejects the forbidden %s field', (field) => {
  expect(validateManifest({ ...expectedManifest, [field]: [] }))
    .toContain(`Unexpected manifest field: ${field}`);
});
```

In `scripts/verify-bundle.test.mjs`, expand `ALLOWED_FILES` with:

```js
'background.js',
'icon/disabled/128.png',
'icon/disabled/16.png',
'icon/disabled/32.png',
'icon/disabled/48.png',
'icon/disabled/96.png',
```

Add focused tests that remove `background.js` and
`icon/disabled/16.png` in turn and expect the corresponding exact missing-file
errors. Add:

```js
it.each(['background.js', 'icon/disabled/16.png'])(
  'rejects a missing required %s file',
  (missing) => {
    const files = ALLOWED_FILES.filter((file) => file !== missing);
    expect(validateBundle(validBundle({
      files,
      sizes: files.map(() => 1),
    }))).toContain(`Missing bundle file: ${missing}`);
  },
);

it('accepts the disabled icon directory but rejects other nested icon directories', async () => {
  const bundlePath = await createBundle();
  await mkdir(join(bundlePath, 'icon', 'other'), { recursive: true });

  const result = outputFor(bundlePath);

  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('Unexpected bundle directory: icon/disabled');
  expect(result.stderr).toContain('Unexpected bundle directory: icon/other');
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
npx vitest run lib/toolbar-toggle.test.ts test/background-entrypoint.integration.test.ts scripts/verify-manifest.test.mjs scripts/verify-bundle.test.mjs
```

Expected: FAIL because the toolbar controller, background entrypoint, disabled
icons, and new verifier allowances do not exist.

- [ ] **Step 4: Create the dimmed grayscale icon source and PNG assets**

Create `assets/icon-disabled.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g opacity=".58">
    <rect x="4" y="4" width="120" height="120" rx="28" fill="#20252b"/>
    <rect x="7" y="7" width="114" height="114" rx="25" fill="none" stroke="#59616a" stroke-width="6"/>
    <path d="M35 42v44" fill="none" stroke="#c3c8ce" stroke-linecap="round" stroke-width="8"/>
    <circle cx="35" cy="32" r="11" fill="#c3c8ce"/>
    <circle cx="35" cy="96" r="11" fill="#c3c8ce"/>
    <circle cx="90" cy="32" r="11" fill="#9299a1"/>
    <path d="M90 43v18c0 14-11 25-25 25H53" fill="none" stroke="#9299a1" stroke-linecap="round" stroke-width="8"/>
    <circle cx="91" cy="93" r="17" fill="#666d75" stroke="#20252b" stroke-width="5"/>
    <path d="m83 93 6 6 11-13" fill="none" stroke="#d8dce1" stroke-linecap="round" stroke-linejoin="round" stroke-width="5"/>
  </g>
</svg>
```

Generate the five checked-in PNGs:

```bash
mkdir -p public/icon/disabled
for size in 16 32 48 96 128; do
  rsvg-convert assets/icon-disabled.svg -w "$size" -h "$size" \
    -o "public/icon/disabled/$size.png"
done
```

Inspect `public/icon/disabled/128.png` visually and compare it with
`public/icon/128.png`. Confirm identical geometry, grayscale channels, and lower
visual intensity before continuing.

- [ ] **Step 5: Implement the toolbar controller**

Create `lib/toolbar-toggle.ts`:

```ts
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
      return true;
    }
  };

  const enqueue = (operation: () => Promise<void>) => {
    const next = transition.catch(() => {}).then(operation);
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
```

- [ ] **Step 6: Add the WXT background entrypoint and manifest action**

Create `entrypoints/background.ts`:

```ts
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
    const contain = (operation: Promise<void>) => { void operation.catch(() => {}); };

    contain(controller.sync());
    browser.action.onClicked.addListener(() => contain(controller.toggle()));
    browser.storage.onChanged.addListener((changes, areaName) => {
      const enabled = enabledFromStorageChange(changes, areaName);
      if (enabled !== undefined) contain(controller.sync());
    });
  },
});
```

Import `ACTIVE_ICON_PATHS` in `wxt.config.ts` and extend the manifest:

```ts
manifest: {
  action: { default_icon: ACTIVE_ICON_PATHS },
  description: 'Adds compact comment, review-thread, diff, and AI-agent summaries to GitHub pull request lists.',
  name: 'GitHub PR Overview',
  permissions: ['storage'],
},
```

- [ ] **Step 7: Tighten the manifest and bundle verifiers**

In `scripts/verify-manifest.mjs`:

- Add only `action`, `background`, and `permissions` to `ALLOWED_FIELDS`.
- Add `const ACTION_FIELDS = new Set(['default_icon']);`.
- Insert this exact validation after the existing manifest icon validation:

```js
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
```

In `scripts/verify-bundle.mjs`:

- Add the exact background and disabled-icon paths from Step 2 to
  `ALLOWED_FILES`.
- Add `icon/disabled` to `ALLOWED_DIRECTORIES`.
- Change directory traversal from a top-level-only check to an exact
  relative-path check:

```js
} else if (metadata.isDirectory()) {
  if (ALLOWED_DIRECTORIES.has(path)) {
    await scanDirectory(filePath, path);
  } else {
    errors.push(`Unexpected bundle directory: ${path}`);
  }
}
```

Keep the existing 250,000-byte content-script and 270,000-byte total-package
limits unchanged.

- [ ] **Step 8: Run focused tests, build, and verify the generated package**

Run:

```bash
npx vitest run lib/extension-toggle.test.ts lib/toolbar-toggle.test.ts test/background-entrypoint.integration.test.ts scripts/verify-manifest.test.mjs scripts/verify-bundle.test.mjs
npm run compile
npm run build
npm run verify:manifest
npm run verify:bundle
```

Expected: all commands PASS. Inspect `output/chrome-mv3/manifest.json` and
confirm it has one action, one module service worker, `permissions:
["storage"]`, the unchanged single content script, and no host permissions.

- [ ] **Step 9: Commit the complete toolbar infrastructure**

```bash
git add assets/icon-disabled.svg public/icon/disabled lib/toolbar-toggle.ts lib/toolbar-toggle.test.ts entrypoints/background.ts test/background-entrypoint.integration.test.ts wxt.config.ts scripts/verify-manifest.mjs scripts/verify-manifest.test.mjs scripts/verify-bundle.mjs scripts/verify-bundle.test.mjs
git commit -m "feat: add extension toolbar action"
```

---

### Task 3: Make the content runtime reversibly activatable

**Files:**
- Modify: `lib/content-runtime.ts`
- Modify: `lib/content-runtime.test.ts`

**Interfaces:**
- Consumes: the existing `createPageReconciler(options)` factory.
- Changes: `ContentRuntimeOptions` gains `initiallyEnabled?: boolean`, defaulting to `true`.
- Produces: `ContentRuntimeController` with `setEnabled(enabled: boolean): void`.
- Preserves: one WXT location-change listener and one invalidation listener per content-script lifetime.

- [ ] **Step 1: Extend the runtime test harness**

Change the helper in `lib/content-runtime.test.ts` to accept an initial state and
retain the returned controller:

```ts
function startRuntime(initiallyEnabled = true) {
  const listeners = new Map<string, EventListener>();
  const frames: FrameRequestCallback[] = [];
  let invalidate!: () => void;
  const signals: AbortSignal[] = [];
  const removes: ReturnType<typeof vi.fn>[] = [];
  const client = {
    loadPullRequest: vi.fn(
      (_identity, signal?: AbortSignal): Promise<PullRequestRemoteSummary> => {
        if (signal) signals.push(signal);
        return new Promise(() => {});
      },
    ),
  };
  const mount = vi.fn(() => {
    const remove = vi.fn();
    removes.push(remove);
    return { isConnected: () => true, remove, update: vi.fn() };
  });
  const controller = startContentRuntime({
    ctx: {
      addEventListener(_target, type, listener) {
        listeners.set(type, listener as EventListener);
      },
      onInvalidated(listener) {
        invalidate = listener;
        return () => {};
      },
      requestAnimationFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
    },
    client,
    document,
    initiallyEnabled,
    uiFactory: { mount },
  });
  return {
    client,
    controller,
    frames,
    invalidate,
    listeners,
    mount,
    removes,
    signals,
  };
}
```

- [ ] **Step 2: Write failing activation lifecycle tests**

Add:

```ts
it('starts dormant and activates without a reload', async () => {
  setupPage();
  const runtime = startRuntime(false);

  expect(runtime.mount).not.toHaveBeenCalled();
  expect(runtime.client.loadPullRequest).not.toHaveBeenCalled();

  runtime.controller.setEnabled(true);
  await Promise.resolve();

  expect(runtime.mount).toHaveBeenCalledTimes(1);
  expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(1);
});

it('disables immediately and creates one fresh reconciler when re-enabled', async () => {
  setupPage();
  const runtime = startRuntime();
  await Promise.resolve();

  runtime.controller.setEnabled(false);

  expect(runtime.signals[0]!.aborted).toBe(true);
  expect(runtime.removes[0]).toHaveBeenCalledTimes(1);

  runtime.controller.setEnabled(false);
  runtime.controller.setEnabled(true);
  runtime.controller.setEnabled(true);
  await Promise.resolve();

  expect(runtime.mount).toHaveBeenCalledTimes(2);
  expect(runtime.client.loadPullRequest).toHaveBeenCalledTimes(2);
});

it('ignores navigation while disabled and enables against the current route', async () => {
  setupPage();
  const runtime = startRuntime(false);

  runtime.listeners.get('wxt:locationchange')!(
    locationChange('/octo/demo/pulls?q=reviewed'),
  );
  window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
  expect(runtime.frames).toHaveLength(0);
  expect(runtime.mount).not.toHaveBeenCalled();

  runtime.controller.setEnabled(true);
  await Promise.resolve();
  expect(runtime.mount).toHaveBeenCalledTimes(1);
});

it('makes activation and queued frames inert after invalidation', async () => {
  setupPage();
  const runtime = startRuntime();
  runtime.listeners.get('wxt:locationchange')!(
    locationChange('/octo/demo/pulls?q=reviewed'),
  );

  runtime.invalidate();
  runtime.controller.setEnabled(true);
  window.history.replaceState({}, '', '/octo/demo/pulls?q=reviewed');
  runtime.frames.shift()!(0);

  expect(runtime.mount).toHaveBeenCalledTimes(1);
  expect(runtime.removes[0]).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run the runtime tests and verify they fail**

Run:

```bash
npx vitest run lib/content-runtime.test.ts
```

Expected: FAIL because `initiallyEnabled` and `setEnabled` do not exist.

- [ ] **Step 4: Implement the reversible activation boundary**

In `lib/content-runtime.ts`, add:

```ts
export interface ContentRuntimeController {
  setEnabled(enabled: boolean): void;
}

export interface ContentRuntimeOptions {
  ctx: ContentScriptLifecycle;
  client: PullRequestClient;
  document?: Document;
  initiallyEnabled?: boolean;
  IntersectionObserver?: ObserverConstructor;
  uiFactory: CardUiFactory;
}
```

Refactor `startContentRuntime` so it owns an optional reconciler:

```ts
export function startContentRuntime(
  options: ContentRuntimeOptions,
): ContentRuntimeController {
  const document = options.document ?? globalThis.document;
  let reconciler: ReturnType<typeof createPageReconciler> | undefined;
  let invalidated = false;

  const setEnabled = (enabled: boolean) => {
    if (invalidated) return;
    if (!enabled) {
      reconciler?.cleanup();
      reconciler = undefined;
      return;
    }
    if (reconciler) return;
    reconciler = createPageReconciler({
      document,
      client: options.client,
      IntersectionObserver: options.IntersectionObserver ??
        globalThis.IntersectionObserver as ObserverConstructor | undefined,
      uiFactory: options.uiFactory,
    });
    reconciler.reconcile();
  };

  setEnabled(options.initiallyEnabled ?? true);
```

Keep the existing coalesced navigation algorithm, but replace its direct
reconciler access with:

```ts
if (!invalidated && expected && document.location.href === expected.href) {
  reconciler?.reconcile();
}
```

Register the location listener once, but do not schedule navigation work while
disabled:

```ts
options.ctx.addEventListener(window, 'wxt:locationchange', (event) => {
  if (reconciler) scheduleCommittedReconcile(event.newUrl);
});
```

Replace invalidation cleanup with:

```ts
options.ctx.onInvalidated(() => {
  invalidated = true;
  reconciler?.cleanup();
  reconciler = undefined;
});

return { setEnabled };
```

- [ ] **Step 5: Run runtime and reconciler regression tests**

Run:

```bash
npx vitest run lib/content-runtime.test.ts lib/pr-reconciler.test.ts
npm run compile
```

Expected: all commands PASS, including the pre-existing teardown and navigation
coverage.

- [ ] **Step 6: Commit the reversible runtime**

```bash
git add lib/content-runtime.ts lib/content-runtime.test.ts
git commit -m "feat: make content runtime toggleable"
```

---

### Task 4: Wire stored state into the content entrypoint

**Files:**
- Modify: `entrypoints/content.tsx`
- Modify: `test/content-entrypoint.integration.test.tsx`

**Interfaces:**
- Consumes: `readEnabled(browser.storage.local)` and `enabledFromStorageChange(...)` from Task 1.
- Consumes: `startContentRuntime(...): ContentRuntimeController` from Task 3.
- Produces: one `browser.storage.onChanged` listener per content-script lifetime.
- Produces: listener removal through WXT invalidation.
- Preserves: the existing React shadow-root UI factory and exact GitHub match.

- [ ] **Step 1: Add a controllable storage mock to the real-entrypoint integration test**

In `test/content-entrypoint.integration.test.tsx`, add:

```ts
let storedEnabled: unknown = true;
const storageListeners = new Set<
  (changes: Record<string, { newValue?: unknown }>, areaName: string) => void
>();
const browserMock = {
  storage: {
    local: {
      get: vi.fn(async () => ({ enabled: storedEnabled })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        storedEnabled = items.enabled;
      }),
    },
    onChanged: {
      addListener: vi.fn((listener) => storageListeners.add(listener)),
      removeListener: vi.fn((listener) => storageListeners.delete(listener)),
    },
  },
};
vi.stubGlobal('browser', browserMock);
```

Reset `storedEnabled`, `storageListeners`, and the browser stubs in
`afterEach`.

- [ ] **Step 2: Write failing disabled-start and immediate-toggle integration tests**

Add a test that sets `storedEnabled = false` before importing the entrypoint,
runs `definition.main(context)`, and asserts no host and no GitHub fetch:

```ts
it('starts dormant when the stored preference is disabled', async () => {
  currentPullRequestRow();
  storedEnabled = false;
  const context = createFakeContext();
  vi.stubGlobal('browser', browserMock);
  vi.stubGlobal('defineContentScript', (value: typeof definition) => {
    definition = value;
    return value;
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await import('../entrypoints/content');

  await definition.main(context.value);

  expect(document.querySelector('github-pr-overview')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
});
```

Extract the existing listener, frame, and invalidation setup into
`createFakeContext()`:

```ts
function createFakeContext() {
  const frames: FrameRequestCallback[] = [];
  const invalidations: Array<() => void> = [];
  const listeners = new Map<string, EventListener>();
  const value: FakeContext = {
    addEventListener(_target, type, listener) {
      listeners.set(type, listener);
    },
    onInvalidated(listener) {
      invalidations.push(listener);
      return () => {};
    },
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
  };
  return { frames, invalidations, listeners, value };
}
```

Add a second test that starts enabled, waits for the real card, then emits:

```ts
for (const listener of storageListeners) {
  listener({ enabled: { oldValue: true, newValue: false } }, 'local');
}

await waitFor(() => {
  expect(document.querySelector('github-pr-overview')).toBeNull();
});

for (const listener of storageListeners) {
  listener({ enabled: { oldValue: false, newValue: true } }, 'local');
}

await waitFor(() => {
  expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
});
```

Before emitting the events, retain `const href = window.location.href`; after
re-enabling assert `expect(window.location.href).toBe(href)`. Spy on the
fixture-backed fetcher's `AbortSignal` arguments and assert the first cycle's
signals are aborted after disabling.

Finally invoke the captured WXT invalidation callback and assert:

```ts
expect(browserMock.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
expect(storageListeners).toHaveLength(0);
```

Add a read-failure assertion to the enabled-start test:

```ts
browserMock.storage.local.get.mockRejectedValueOnce(new Error('storage read'));
await definition.main(context.value);
await waitFor(() => {
  expect(document.querySelectorAll('github-pr-overview')).toHaveLength(1);
});
```

Add a race test using a deferred first `get`: start `definition.main`, emit
`newValue: false` after `addListener` is observed but before resolving `get`
with `{ enabled: true }`, then await `main` and assert no overview host was
mounted. This locks the latest observed event above the stale read result:

```ts
let resolveRead!: (value: Record<string, unknown>) => void;
browserMock.storage.local.get.mockReturnValueOnce(
  new Promise((resolve) => { resolveRead = resolve; }),
);
const main = definition.main(context.value);
await vi.waitFor(() => {
  expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
});
for (const listener of storageListeners) {
  listener({ enabled: { newValue: false } }, 'local');
}
resolveRead({ enabled: true });
await main;
expect(document.querySelector('github-pr-overview')).toBeNull();
```

- [ ] **Step 3: Run the entrypoint integration test and verify it fails**

Run:

```bash
npx vitest run test/content-entrypoint.integration.test.tsx
```

Expected: FAIL because the content entrypoint does not read or observe storage.

- [ ] **Step 4: Read state before mounting and observe later changes**

In `entrypoints/content.tsx`, import:

```ts
import {
  enabledFromStorageChange,
  readEnabled,
} from '../lib/extension-toggle';
```

At the start of `main`, register the listener before the asynchronous read so a
toolbar click cannot be lost during content startup:

```ts
let runtime: ReturnType<typeof startContentRuntime> | undefined;
let latestObservedEnabled: boolean | undefined;
const onStorageChanged = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => {
  const enabled = enabledFromStorageChange(changes, areaName);
  if (enabled === undefined) return;
  latestObservedEnabled = enabled;
  runtime?.setEnabled(enabled);
};
browser.storage.onChanged.addListener(onStorageChanged);

let initiallyEnabled = true;
try {
  initiallyEnabled = await readEnabled(browser.storage.local);
} catch {
  initiallyEnabled = true;
}
```

Replace the existing unretained `startContentRuntime` call with:

```ts
runtime = startContentRuntime({
  ctx,
  client,
  initiallyEnabled: latestObservedEnabled ?? initiallyEnabled,
  uiFactory: {
    async mount(anchor, props) {
      const ui = await createShadowRootUi<Root>(ctx, {
        anchor,
        append: 'after',
        css: CARD_STYLES,
        isolateEvents: ['keydown', 'keyup'],
        name: 'github-pr-overview',
        onMount(container) {
          const root = createRoot(container);
          root.render(<PullRequestCard {...props} />);
          return root;
        },
        onRemove(root) { root?.unmount(); },
        position: 'inline',
      });
      ui.mount();
      return {
        isConnected() {
          return ui.shadowHost.isConnected &&
            ui.shadowHost.closest('[id^="issue_"].js-issue-row') ===
              anchor.closest('[id^="issue_"].js-issue-row');
        },
        remove() { ui.remove(); },
        update(next) {
          ui.mounted?.render(<PullRequestCard {...next} />);
        },
      };
    },
  },
});

ctx.onInvalidated(() => {
  browser.storage.onChanged.removeListener(onStorageChanged);
});
```

Keep all browser API access inside `main`.

- [ ] **Step 5: Run focused and full unit verification**

Run:

```bash
npx vitest run lib/extension-toggle.test.ts lib/content-runtime.test.ts test/content-entrypoint.integration.test.tsx
npm run test:coverage
npm run compile
```

Expected: all commands PASS and coverage remains above the configured branch,
function, line, and statement thresholds.

- [ ] **Step 6: Commit content-state integration**

```bash
git add entrypoints/content.tsx test/content-entrypoint.integration.test.tsx
git commit -m "feat: apply toggle state to GitHub tabs"
```

---

### Task 5: Prove multi-tab behavior and document the control

**Files:**
- Modify: `test/e2e/extension-fixture.ts`
- Modify: `test/e2e/extension.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `ExtensionHarness.setEnabled(enabled: boolean): Promise<void>`.
- Produces: `ExtensionHarness.openPage(): Promise<Page>`.
- Consumes: the background service worker and stored `enabled` preference from Tasks 1–4.
- Preserves: context-wide GitHub route interception and diagnostics for every test page.

- [ ] **Step 1: Extend the Playwright harness around the real service worker**

Add to `ExtensionHarness`:

```ts
openPage(): Promise<Page>;
setEnabled(enabled: boolean): Promise<void>;
```

Extract the existing page diagnostics and init script into:

```ts
async function configurePage(page: Page): Promise<Page> {
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
    noteActivity();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push(
        messageForConsole(message.type(), message.text()),
      );
      noteActivity();
    }
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`.trim(),
    );
    noteActivity();
  });
  await page.addInitScript(() => {
    const removeUnservedFixtureRows = () =>
      document.querySelector('#issue_43')?.remove();
    new MutationObserver(removeUnservedFixtureRows)
      .observe(document, { childList: true, subtree: true });
    removeUnservedFixtureRows();
  });
  return page;
}
```

Create the primary page through `configurePage`. Implement `openPage` with
`configurePage(await context.newPage())`.

Capture the WXT worker after context launch:

```ts
const worker = context.serviceWorkers()[0] ??
  await context.waitForEvent('serviceworker');
```

Implement:

```ts
async setEnabled(enabled) {
  await worker.evaluate(async (value) => {
    await chrome.storage.local.set({ enabled: value });
  }, enabled);
},
```

- [ ] **Step 2: Write the failing multi-tab browser test**

Add to `test/e2e/extension.spec.ts`:

```ts
test('toggles every open PR-list tab immediately without reload', async ({ extension }) => {
  const secondPage = await extension.openPage();
  await Promise.all([
    extension.page.goto(extension.urls.prList),
    secondPage.goto(extension.urls.prList),
  ]);

  const firstHost = extension.page.locator('#issue_42 github-pr-overview');
  const secondHost = secondPage.locator('#issue_42 github-pr-overview');
  await expect(firstHost).toHaveCount(1);
  await expect(secondHost).toHaveCount(1);

  await extension.setEnabled(false);
  await expect(firstHost).toHaveCount(0);
  await expect(secondHost).toHaveCount(0);
  await expect(extension.page.locator('#issue_42 a[aria-label="2 comments"]')).toBeVisible();
  await expect(secondPage.locator('#issue_42 a[aria-label="2 comments"]')).toBeVisible();

  await extension.setEnabled(true);
  await expect(firstHost).toHaveCount(1);
  await expect(secondHost).toHaveCount(1);

  await secondPage.close();
  await extension.expectNoFailures();
});

test('does not flash overview UI when stored state is disabled before navigation', async ({ extension }) => {
  await extension.setEnabled(false);
  await extension.page.goto(extension.urls.prList);

  await expect(extension.page.locator('github-pr-overview')).toHaveCount(0);
  await expect(extension.page.locator('#issue_42 a[aria-label="2 comments"]')).toBeVisible();
  await extension.expectNoFailures();
});
```

- [ ] **Step 3: Run the browser tests and verify the new cases fail**

Run:

```bash
npm run build
npx playwright test test/e2e/extension.spec.ts
```

Expected before the fixture and content wiring are complete: the new cases FAIL
because no harness storage control or immediate content reaction exists. After
Steps 1–2 and Tasks 1–4 are complete: all cases PASS.

- [ ] **Step 4: Update README behavior, privacy, development, and release checks**

Update `README.md` to state:

```md
## Toolbar control

Click the GitHub PR Overview toolbar icon to disable or enable the extension
globally. The full-color icon means enabled; the dimmed grayscale icon means
disabled. Changes apply immediately to every open GitHub pull-request list, and
the choice persists across browser restarts and extension updates.
```

Replace the claims that the extension stores no preferences and declares no
permissions with:

```md
- stores one local `enabled` boolean and no GitHub data; and
- declares only the `storage` permission, used for that preference.
```

Update the manifest-verifier description to say it permits exactly one
path-scoped GitHub content script, one popup-free action, one module service
worker, and the `storage` permission while rejecting host permissions and
web-accessible resources.

Add these manual Chrome Stable checks:

```md
- A pinned toolbar click disables and re-enables the extension without opening a popup.
- All open matching GitHub tabs update immediately without reload.
- Disabled state uses the dimmed grayscale icon; enabled state uses the full-color icon.
- The tooltip offers the inverse action in each state.
- The choice survives a browser restart and extension update.
```

- [ ] **Step 5: Run the complete verification gate**

Run:

```bash
npm run verify
```

Expected: coverage, compile, Chrome build, manifest verification, bundle
verification, and all Playwright tests PASS with no unexpected network,
request, page, or console failures.

Run:

```bash
git status --short
```

Expected: only the intended README and E2E files are modified; the existing
untracked `.superpowers/` visual-companion directory remains unstaged.

- [ ] **Step 6: Perform the manual toolbar acceptance check**

Load `output/chrome-mv3` in Chrome Stable, pin GitHub PR Overview, and verify:

1. Initial state is enabled, full color, with title
   `Disable GitHub PR Overview`.
2. One click changes every open matching GitHub tab immediately, removes its
   overview cards, leaves GitHub's native UI usable, dims and grays the icon,
   and changes the title to `Enable GitHub PR Overview`.
3. A second click restores every overview card without a reload and restores
   the full-color icon and enabled title.
4. Disabled state survives a browser restart and an unpacked-extension reload.
5. No request leaves `github.com`, and page, content-script, and service-worker
   consoles contain no errors.

- [ ] **Step 7: Commit browser proof and documentation**

```bash
git add test/e2e/extension-fixture.ts test/e2e/extension.spec.ts README.md
git commit -m "test: verify persistent toolbar toggle"
```

---

### Task 6: Final review and branch handoff

**Files:**
- Review only: all files changed by Tasks 1–5.

**Interfaces:**
- Consumes: the complete toolbar-toggle implementation and all verification output.
- Produces: a review-ready branch with no uncommitted feature changes.

- [ ] **Step 1: Run the repository-wide React review**

Run:

```bash
npx react-doctor@latest .
```

Expected: no new React correctness, performance, or architecture findings in
the modified content entrypoint or its tests.

- [ ] **Step 2: Re-run the release gate from a clean generated output**

Run:

```bash
npm run verify
```

Expected: PASS for coverage, TypeScript, build, strict manifest, strict bundle,
and Playwright.

- [ ] **Step 3: Inspect the final diff and commit graph**

Run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors, no uncommitted feature files, and one focused
commit for each task. The untracked `.superpowers/` directory may remain and
must not be staged.

- [ ] **Step 4: Request code review**

Use the `requesting-code-review` skill to review the implementation against
`docs/superpowers/specs/2026-07-31-extension-toolbar-toggle-design.md` and this
plan. Address all correctness findings, then rerun the focused test for each
changed area and `npm run verify`.

- [ ] **Step 5: Finish the development branch**

Use the `finishing-a-development-branch` skill to choose merge, push, or local
handoff only after all verification and review findings are complete.
