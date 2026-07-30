# Output Directory Design

## Goal

Use `output` as WXT's build-output base directory. Production Chrome builds
must be generated at `output/chrome-mv3` instead of
`.output/chrome-mv3`.

## Implementation

- Set WXT's `outDir` configuration to `output`.
- Ignore the generated `output` directory instead of `.output`.
- Change the manifest and bundle verifier defaults to
  `output/chrome-mv3`.
- Change the end-to-end extension loader to load
  `output/chrome-mv3`.
- Update active tests and README instructions to use the new path.
- Leave historical implementation plans and bundled skill references
  unchanged because they document earlier workflows or external defaults.

The build will write directly to WXT's selected output directory. It will not
build under `.output` and copy artifacts afterward, and it will not introduce
an environment-variable override.

## Verification

- Update verifier tests before production defaults so the path change is
  exercised through behavior.
- Run the focused verifier tests.
- Run TypeScript compilation and a production build.
- Confirm the built manifest and content script exist under
  `output/chrome-mv3`.
- Run the complete `npm run verify` gate, including the unpacked-extension
  Chromium tests.

## Safety

`output` is a generated directory and will be ignored by Git. Existing source,
permissions, manifest structure, extension behavior, and release contents do
not change.
