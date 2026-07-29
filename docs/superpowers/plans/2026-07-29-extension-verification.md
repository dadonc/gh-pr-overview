# Extension Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict package verification, current-fixture provenance, entrypoint integration coverage, credential-free real-Chromium extension smokes, and a documented signed-in release check.

**Architecture:** Vitest remains the fast exhaustive layer, with one entrypoint integration test at the WXT boundary. Playwright loads the built unpacked extension into temporary Chromium and intercepts every GitHub request with committed fixtures; strict manifest and bundle verifiers gate the package itself.

**Tech Stack:** Node.js 24, npm, Vitest 4 with V8 coverage, WXT 0.20, React 19, Playwright Test with Chromium, Chrome Manifest V3.

## Global Constraints

- This plan starts after both schema/client and row lifecycle/UI plans are green.
- Automated browser tests use no GitHub credentials, persistent profile, live GitHub response, HAR, trace, screenshot, or private repository data.
- Abort every unmatched browser network request.
- Keep the exact current manifest purpose: one isolated top-frame content script and no permission/background/web-accessible-resource fields.
- Keep content script at or below 250,000 bytes and total unpacked output at or below 270,000 bytes.
- Coverage thresholds are 90% statements, lines, and functions and 85% branches for production modules unless one environment-generated branch is documented and reviewed.
- `npm audit` remains outside the offline verification script because it needs network authorization.
- Write verifier/integration/E2E tests before their corresponding implementation.

---

### Task 1: Record current fixture provenance and expected evidence

**Files:**
- Create: `test/fixtures/github/current/README.md`
- Modify: `test/fixtures/github/current/pr-list.html`
- Modify: `test/fixtures/github/current/conversation.html`
- Modify: `test/fixtures/github/current/files.html`
- Modify: `test/fixtures/github/current/files-no-aggregate.html`
- Modify: `test/fixtures/github/current/timeline-fragment.html`
- Modify: `test/fixtures/github/current/automated-comment.html`
- Test: `lib/github-dom.test.ts`
- Test: `lib/github-client.test.ts`

**Interfaces:**
- Consumes: fixtures created by the two preceding plans.
- Produces: one documented expected summary shared by unit, integration, and Chromium tests.

- [ ] **Step 1: Write fixture provenance**

Document:

```markdown
# Current GitHub fixture set

- Capture date: 2026-07-29
- Public structural references:
  - `https://github.com/microsoft/vscode/pulls`
  - `https://github.com/microsoft/vscode/pull/328058`
  - `https://github.com/microsoft/vscode/pull/328058/files`
- Sanitization: repository, users, cursor values, content, IDs, and file names
  are replaced; selector-bearing wrappers, endpoint shapes, state attributes,
  Unicode minus signs, and embedded JSON property paths are preserved.
- Tests never refresh these files from the network.

Expected PR 42 summary:
- 2 native comments
- 1 review thread: 0 unresolved, 1 resolved/outdated
- 18 changed files, 524 additions, 353 deletions
- Copilot requested and responded at least once
- Agent evidence is partial because a deferred body remains unloaded
```

- [ ] **Step 2: Add one cross-fixture client assertion**

In `github-client.test.ts`, load the full fixture set through a fake fetcher and
assert the expected summary fields and exact request URLs. This test must use
the same files later served by Playwright.

- [ ] **Step 3: Run parser/client tests**

```bash
npm test -- lib/github-dom.test.ts lib/github-client.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit fixture provenance**

```bash
git add test/fixtures/github/current lib/github-dom.test.ts lib/github-client.test.ts
git commit -m "test: document current GitHub fixtures"
```

### Task 2: Enforce exact manifest and bundle contents

**Files:**
- Modify: `scripts/verify-manifest.mjs`
- Modify: `scripts/verify-manifest.test.mjs`
- Create: `scripts/verify-bundle.mjs`
- Create: `scripts/verify-bundle.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Preserves: `validateManifest(manifest): string[]`.
- Produces: `validateBundle({ files, contentScript, sizes }): string[]` or an equivalent pure exported validator.
- Produces scripts: `verify:bundle` and later `verify`.

- [ ] **Step 1: Add failing nested-manifest tests**

Table-drive these extra fields:

```js
[
  'css',
  'exclude_matches',
  'include_globs',
  'exclude_globs',
  'match_about_blank',
  'match_origin_as_fallback',
  'unexpected',
]
```

For each, expect:

```text
Unexpected content_scripts[0] field: FIELD
```

Add missing-required-field tests and reject `null`, arrays, strings, and class
instances as the sole content-script entry.

- [ ] **Step 2: Run manifest tests and verify failure**

```bash
npm test -- scripts/verify-manifest.test.mjs
```

Expected: FAIL because nested keys are not allowlisted.

- [ ] **Step 3: Implement exact nested key validation**

Add:

```js
const CONTENT_SCRIPT_FIELDS = new Set([
  'all_frames',
  'js',
  'matches',
  'run_at',
  'world',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
```

Validate the sole entry is plain, reject every extra key with the indexed path,
and report a missing key as:

```text
Missing content_scripts[0] field: FIELD
```

Continue the existing exact value checks.

- [ ] **Step 4: Add failing bundle-verifier tests**

Define the exact allowed files:

```js
[
  'content-scripts/content.js',
  'icon/128.png',
  'icon/16.png',
  'icon/32.png',
  'icon/48.png',
  'icon/96.png',
  'manifest.json',
]
```

Test extra/missing files, a content script over 250,000 bytes, total size over
270,000 bytes, and source containing `content-scripts/content.css`.

- [ ] **Step 5: Implement and wire the bundle verifier**

Create a pure validator plus CLI entrypoint. The CLI recursively reads
`.output/chrome-mv3`, normalizes relative paths with `/`, reads the content
script, sums byte sizes, and prints:

```text
Verified Chrome bundle: .output/chrome-mv3
```

when no errors exist. Add:

```json
"verify:bundle": "node scripts/verify-bundle.mjs"
```

- [ ] **Step 6: Run verifier tests and a real build**

```bash
npm test -- scripts/verify-manifest.test.mjs scripts/verify-bundle.test.mjs
npm run build
npm run verify:manifest
npm run verify:bundle
```

Expected: PASS; no CSS reference and both budgets remain within limits.

- [ ] **Step 7: Commit package verification**

```bash
git add scripts/verify-manifest.mjs scripts/verify-manifest.test.mjs scripts/verify-bundle.mjs scripts/verify-bundle.test.mjs package.json
git commit -m "test: verify exact extension package"
```

### Task 3: Add coverage and real entrypoint integration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Create: `test/content-entrypoint.integration.test.tsx`

**Interfaces:**
- Adds dev dependencies: `@vitest/coverage-v8` matching Vitest 4 and `@playwright/test`.
- Removes direct dev dependency: `web-ext`.
- Adds script: `test:coverage`.
- Tests: actual entrypoint definition, real runtime/client/reconciler/React, mocked WXT shadow host and fixture fetch.

- [ ] **Step 1: Update test dependencies**

Run the package-manager operation that removes direct `web-ext` and adds:

```text
@playwright/test
@vitest/coverage-v8
```

Do not hand-edit resolved integrity entries. Verify:

```bash
npm ls --depth=0
```

Expected: a valid tree with Playwright and coverage present and no direct
`web-ext`.

- [ ] **Step 2: Add coverage configuration and script**

Configure Vitest to exclude `test/e2e/**` from jsdom test discovery and add:

```ts
coverage: {
  provider: 'v8',
  include: [
    'entrypoints/**/*.{ts,tsx}',
    'lib/**/*.{ts,tsx}',
    'scripts/**/*.mjs',
  ],
  thresholds: {
    branches: 85,
    functions: 90,
    lines: 90,
    statements: 90,
  },
},
```

Add:

```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 3: Write the failing entrypoint integration test**

Before dynamically importing `entrypoints/content.tsx`, stub:

```ts
let definition: {
  matches: string[];
  main(ctx: FakeContext): Promise<void>;
};

vi.stubGlobal('defineContentScript', (value: typeof definition) => {
  definition = value;
  return value;
});
```

Mock `createShadowRootUi` with a fake that:

- Inserts a `github-pr-overview` host after the supplied marker.
- Attaches an open shadow root.
- Appends one container.
- Calls the real `onMount(container)` and stores its returned React root.
- Implements `mount`, `remove`, and `mounted`.

Stub `fetch` by exact URL to return the current conversation, files, and
focused-fragment fixtures with `content-type: text/html`.

Assert:

```ts
expect(definition.matches).toEqual(['https://github.com/*/*/pulls*']);
expect(document.querySelector('github-pr-overview')).toBeTruthy();
expect(
  document.querySelector('github-pr-overview')!.shadowRoot,
).toHaveTextContent('18 files');
expect(
  document.querySelector('github-pr-overview')!.shadowRoot,
).toHaveTextContent('Copilot Responded');
```

Call the captured invalidation callback and assert the host is removed and the
native counter restored.

- [ ] **Step 4: Run the integration test and verify initial failure**

```bash
npm test -- test/content-entrypoint.integration.test.tsx
```

Expected: FAIL until WXT imports and host lifecycle are mocked correctly; it
must not be made green by replacing the real client/runtime/reconciler.

- [ ] **Step 5: Complete only the boundary mocks needed for the real entrypoint**

Keep application modules unmocked. Use the current fixtures and a deterministic
fake lifecycle containing `requestAnimationFrame`. Wait for React/client
updates with Testing Library's `waitFor`.

- [ ] **Step 6: Run integration, full unit, coverage, and compile checks**

```bash
npm test -- test/content-entrypoint.integration.test.tsx
npm test
npm run test:coverage
npm run compile
```

Expected: PASS and all configured thresholds met. If one threshold misses,
add behavior-focused tests for the reported production branch; do not lower the
threshold without documenting and reviewing the exact untestable generated
branch.

- [ ] **Step 7: Commit integration and coverage**

```bash
git add package.json package-lock.json vitest.config.ts test/content-entrypoint.integration.test.tsx
git commit -m "test: cover the real content entrypoint"
```

### Task 4: Add credential-free Chromium extension smoke tests

**Files:**
- Create: `playwright.config.ts`
- Create: `test/e2e/extension-fixture.ts`
- Create: `test/e2e/extension.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Adds script: `test:e2e`.
- Consumes: `.output/chrome-mv3` and all current fixtures.
- Produces: a temporary persistent Chromium context with the unpacked extension loaded.

- [ ] **Step 1: Configure Playwright for serial extension tests**

Use:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  testDir: 'test/e2e',
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  workers: 1,
});
```

- [ ] **Step 2: Build an extension-context fixture**

Launch:

```ts
const extensionPath = path.resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  bypassCSP: false,
});
```

Register `context.route('https://github.com/**', handler)` before creating the
page. Fulfill only these exact targets:

```text
https://github.com/octo/demo/pulls
https://github.com/octo/demo/pull/42
https://github.com/octo/demo/pull/42/files
https://github.com/octo/demo/timeline_focused_item?after_cursor=Cursor%2BOne&id=PR_current42
```

Serve the PR list with:

```text
Content-Security-Policy: default-src 'none'; style-src 'none'; img-src 'none'
Content-Type: text/html; charset=utf-8
```

Abort and record every unmatched request. Collect `pageerror`, console error,
request-failed, and unexpected-request messages. Close the context in fixture
teardown so the temporary profile is discarded.

- [ ] **Step 3: Write the boot/render/security smoke**

Navigate to the fixture PR list and assert one host per row, an open shadow root,
the expected summary, and the native counter hidden only after rendering.

Add hostile page CSS:

```html
<style>
  a { color: rgb(255, 0, 0) !important; font-size: 40px !important; }
</style>
```

Assert a shadow `.metric` does not inherit the 40 px size and that
`CARD_STYLES` exists in the shadow root. Assert no collected errors or
unexpected requests.

- [ ] **Step 4: Write the lifecycle smoke**

Through `page.evaluate`:

1. Insert another current-format row and verify a second card mounts.
2. Remove it and verify its card disappears.
3. Call `history.pushState({}, '', '/octo/demo/issues')`.
4. Verify the original card is removed and native counter restored.
5. Return to `/octo/demo/pulls`, replace the list body with the fixture row,
   and verify a fresh correct card appears without stale values.

Assert no duplicate hosts and no collected errors.

- [ ] **Step 5: Add scripts and verify the browser binary**

Add:

```json
"test:e2e": "playwright test"
```

Run:

```bash
npm run build
npx playwright install --list
npm run test:e2e
```

Expected: both Chromium tests pass. If the matching Chromium is absent, install
only Chromium with the explicit approved package command; do not fall back to a
signed-in Chrome profile.

- [ ] **Step 6: Commit Chromium smoke coverage**

```bash
git add playwright.config.ts test/e2e/extension-fixture.ts test/e2e/extension.spec.ts package.json
git commit -m "test: smoke test the unpacked extension"
```

### Task 5: Add the consolidated verification command and release checklist

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Adds script: `verify`.
- Documents: signed-in Chrome Stable checks that automated fixtures cannot prove.

- [ ] **Step 1: Add the local verification pipeline**

Add:

```json
"verify": "npm run test:coverage && npm run compile && npm run build && npm run verify:manifest && npm run verify:bundle && npm run test:e2e"
```

- [ ] **Step 2: Add the manual release checklist**

Document a disposable-account/repository check containing these exact items:

- Public and private PR lists render.
- Exact and progressive diff totals are correct.
- Deferred threads show exact thread totals and honest agent lower bounds.
- Filtering, scrolling, Turbo navigation, dynamic rows, and route exit work.
- Native counters restore after route exit and extension disable.
- No request leaves `github.com`.
- Page and extension consoles contain no CSP/runtime errors.
- Narrow viewport, keyboard focus, dark mode, and reduced motion remain usable.
- Profiles, cookies, private HTML, HAR, trace, and screenshots are never committed.

- [ ] **Step 3: Run the complete automated gate**

```bash
npm run verify
```

Expected: exit 0 with unit/integration coverage, compile, build, exact manifest,
exact bundle, and two Chromium smokes passing.

- [ ] **Step 4: Build and validate the release archive**

```bash
npm run zip
unzip -t .output/github-pr-overview-0.1.0-chrome.zip
```

Expected: archive creation succeeds and `unzip -t` reports no errors.

- [ ] **Step 5: Attempt the authorized dependency audit**

```bash
npm audit --audit-level=high
```

Expected: no high/critical advisory. If network access is unavailable or not
authorized, record the audit as inconclusive with its exact failure; an offline
zero-advisory result is not sufficient evidence.

- [ ] **Step 6: Commit scripts and release documentation**

```bash
git add package.json README.md
git commit -m "docs: add extension release verification"
```

### Task 6: Final verification and review

**Files:**
- Review: all files changed by all three plans.

**Interfaces:**
- Produces: a release-candidate branch with evidence for every automated claim and one explicit manual signed-in check remaining.

- [ ] **Step 1: Run React Doctor after all React changes**

```bash
npx react-doctor@latest .
```

Expected: no actionable finding.

- [ ] **Step 2: Run the complete gate from a clean dependency tree**

```bash
npm ci
npm run verify
npm run zip
unzip -t .output/github-pr-overview-0.1.0-chrome.zip
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect package and repository state**

```bash
git diff --check
git status --short
find .output/chrome-mv3 -type f -maxdepth 4 -print | sort
```

Expected: no whitespace errors, no unintended source changes, and only the
seven allowlisted unpacked files.

- [ ] **Step 4: Use verification-before-completion**

Apply the `verification-before-completion` skill. Record the exact final counts
for unit/integration tests, coverage, bundle bytes, E2E tests, and ZIP
validation. Do not claim the signed-in manual checklist was executed unless it
actually was.

- [ ] **Step 5: Request a final code review**

Use the `requesting-code-review` skill against the entire implementation range.
Resolve every correctness, security, lifecycle, and test-harness finding.

- [ ] **Step 6: Re-run affected gates after review fixes**

```bash
npm run verify
npm run zip
unzip -t .output/github-pr-overview-0.1.0-chrome.zip
git status --short
```

Expected: all commands exit 0 and the working tree is clean.
