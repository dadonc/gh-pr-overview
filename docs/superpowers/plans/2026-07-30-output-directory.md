# Output Directory Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WXT generate the unpacked Chrome extension under `output/chrome-mv3` and update every active repository consumer to use that path.

**Architecture:** Configure WXT's existing `outDir` option once at the build boundary, then keep verifier defaults, the Playwright extension loader, ignore rules, and user documentation aligned with the resulting `output/chrome-mv3` directory. Focused tests invoke each verifier CLI without a path from an empty temporary directory, locking the observable default-path behavior without depending on a pre-existing build.

**Tech Stack:** TypeScript, WXT 0.20, Node.js ESM verification scripts, Vitest, Playwright, Chromium.

## Global Constraints

- The WXT build-output base directory is exactly `output`.
- The unpacked Chrome MV3 extension path is exactly `output/chrome-mv3`.
- Do not introduce a copy step or an environment-variable override.
- Leave historical implementation plans and bundled skill references unchanged.
- Treat `output` as generated content and keep it ignored by Git.
- Do not change extension behavior, permissions, manifest structure, or release contents.

---

### Task 1: Migrate the active build-output contract

**Files:**
- Create: `docs/superpowers/plans/2026-07-30-output-directory.md`
- Modify: `wxt.config.ts`
- Modify: `.gitignore`
- Modify: `scripts/verify-bundle.mjs`
- Modify: `scripts/verify-bundle.test.mjs`
- Modify: `scripts/verify-manifest.mjs`
- Modify: `scripts/verify-manifest.test.mjs`
- Modify: `test/e2e/extension-fixture.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `verifyBundle(bundlePath = 'output/chrome-mv3'): Promise<void>`.
- Produces: `verifyManifest(manifestPath = 'output/chrome-mv3/manifest.json'): Promise<void>`.
- Produces: WXT production artifacts rooted at `output/chrome-mv3`.
- Consumes: WXT's existing `UserConfig.outDir?: string` option.

- [x] **Step 1: Write failing tests for the verifier default paths**

Add `resolve` to the `node:path` import in both verifier test files:

```js
import { dirname, join, resolve } from 'node:path';
```

```js
import { join, resolve } from 'node:path';
```

Add this test inside the existing bundle-verifier `describe` block:

```js
it('uses the generated WXT Chrome directory by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-bundle-default-'));
  temporaryBundles.push(directory);

  const result = spawnSync(process.execPath, [resolve('scripts/verify-bundle.mjs')], {
    cwd: directory,
    encoding: 'utf8',
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Failed to verify Chrome bundle at output/chrome-mv3:');
});
```

Add `spawnSync` to the manifest test's imports and add this test inside its
existing `describe` block:

```js
import { spawnSync } from 'node:child_process';
```

```js
it('uses the generated WXT Chrome manifest by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-manifest-default-'));
  temporaryDirectories.push(directory);

  const result = spawnSync(process.execPath, [resolve('scripts/verify-manifest.mjs')], {
    cwd: directory,
    encoding: 'utf8',
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('output/chrome-mv3/manifest.json');
});
```

Change the explicit missing-bundle fixture and its assertions in
`scripts/verify-bundle.test.mjs` from `.output/missing-bundle` to
`output/missing-bundle`.

- [x] **Step 2: Run the focused tests and confirm the new contract fails**

Run:

```bash
npx vitest run scripts/verify-bundle.test.mjs scripts/verify-manifest.test.mjs
```

Expected: both new tests FAIL because the verifier error output still names
`.output/chrome-mv3` and `.output/chrome-mv3/manifest.json`.

- [x] **Step 3: Configure WXT and update the verifier defaults**

Add the output base to `wxt.config.ts`:

```ts
export default defineConfig({
  manifest: {
    description: 'Adds compact comment, review-thread, diff, and AI-agent summaries to GitHub pull request lists.',
    name: 'GitHub PR Overview',
  },
  modules: ['@wxt-dev/module-react'],
  outDir: 'output',
});
```

In `scripts/verify-bundle.mjs`, replace the function declaration and CLI
call with:

```js
export async function verifyBundle(bundlePath = 'output/chrome-mv3') {
```

```js
async function main() {
  await verifyBundle(process.argv[2] ?? 'output/chrome-mv3');
}
```

In `scripts/verify-manifest.mjs`, replace the function declaration and CLI
call with:

```js
export async function verifyManifest(manifestPath = 'output/chrome-mv3/manifest.json') {
```

```js
async function main() {
  await verifyManifest(process.argv[2] ?? 'output/chrome-mv3/manifest.json');
}
```

Replace `.output` with `output` in `.gitignore`.

- [x] **Step 4: Update the active extension consumer and documentation**

In `test/e2e/extension-fixture.ts`, load the extension from:

```ts
const extensionPath = path.resolve('output/chrome-mv3');
```

In `README.md`, change both active unpacked-extension path references so
the build description says:

```markdown
`npm run build` creates the unpacked Chrome Manifest V3 extension in
`output/chrome-mv3`.
```

and the Chrome loading instruction says:

```markdown
5. Choose this repository's `output/chrome-mv3` directory.
```

Do not edit path references under `docs/superpowers/` other than this plan,
or references under `.agents/skills/`.

- [x] **Step 5: Run the focused verifier tests**

Run:

```bash
npx vitest run scripts/verify-bundle.test.mjs scripts/verify-manifest.test.mjs
```

Expected: PASS for both test files, including the exact default-path
assertions.

- [x] **Step 6: Compile and build into the new directory**

Run:

```bash
npm run compile
npm run build
```

Expected: both commands exit 0, and WXT reports a Chrome MV3 build rooted
under `output/chrome-mv3`.

Confirm the required artifacts:

```bash
test -f output/chrome-mv3/manifest.json
test -f output/chrome-mv3/content-scripts/content.js
git check-ignore output/chrome-mv3/manifest.json
```

Expected: all three commands exit 0.

- [x] **Step 7: Run React diagnostics and the complete verification gate**

Run:

```bash
npx -y react-doctor@latest . --verbose --diff
npm run verify
```

Expected: React Doctor reports no new issues; Vitest coverage, TypeScript
compilation, WXT build, manifest verification, bundle verification, and
Playwright Chromium tests all pass. Verifier output names
`output/chrome-mv3` and `output/chrome-mv3/manifest.json`.

- [x] **Step 8: Check scope and commit the migration**

Run:

```bash
git diff --check
git status --short
git diff -- .gitignore README.md wxt.config.ts scripts/verify-bundle.mjs scripts/verify-bundle.test.mjs scripts/verify-manifest.mjs scripts/verify-manifest.test.mjs test/e2e/extension-fixture.ts
```

Expected: only the planned source and documentation changes are present;
the generated `output/` tree is ignored and absent from `git status`.

Commit:

```bash
git add .gitignore README.md wxt.config.ts scripts/verify-bundle.mjs scripts/verify-bundle.test.mjs scripts/verify-manifest.mjs scripts/verify-manifest.test.mjs test/e2e/extension-fixture.ts docs/superpowers/plans/2026-07-30-output-directory.md
git commit -m "build: move extension output directory"
```
