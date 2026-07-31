# Native Comment Counter Design

## Goal

Restore GitHub's original pull-request comment counter on the right side of
each pull-request list row and remove the duplicate comment total from the
extension's overview banner.

GitHub remains the sole owner of comment-count presentation. When GitHub omits
the native counter for a pull request with zero comments, the extension must
not synthesize a zero counter.

## User Interface

The overview banner starts with the unresolved review-thread metric, followed
by diff and file totals, then AI-agent participation. It has no leading
separator and does not render loading, partial, ready, or error states for
total comments.

The native GitHub counter keeps its original position, styling, link,
accessibility attributes, and live page behavior. The extension neither hides
nor otherwise mutates it while mounting, refreshing, navigating, or tearing
down a banner.

## Architecture

- Keep native comment-counter extraction in the GitHub DOM adapter because it
  is part of understanding the live row and its mutations.
- Remove `totalComments` from `PullRequestSummary`; that type describes the
  extension-owned banner rather than GitHub-owned row UI.
- Remove the banner's total-comment component and exclude comment state from
  loading and accessibility announcements.
- Remove reconciler state and lifecycle operations that snapshot, hide,
  replace, or restore native counter attributes.
- Continue observing GitHub row mutations so native counter and row changes do
  not interfere with extension reconciliation. The native node itself remains
  under GitHub's control.
- Keep the conversation destination used by the unresolved-thread metric
  independent of the native comment counter's destination.

No synthetic right-side counter is created for zero-comment rows or malformed
native counter markup.

## Failure and Navigation Behavior

Failures loading remote review, diff, or agent data affect only the banner
metrics that depend on those requests. They do not hide, replace, or annotate
GitHub's native comment counter.

Turbo navigation, `pushState` route changes, dynamic row insertion, counter
replacement, and cleanup may add, update, or remove the extension banner, but
must leave the current native counter untouched.

## Testing

Tests will be updated test-first to verify:

- the banner starts with unresolved review threads and has no comment metric or
  leading separator;
- ready, loading, partial, and error banner states never render comment text;
- an existing native counter remains visible and keeps its original attributes
  when the banner mounts;
- live native counter text and attribute changes remain visible without
  remounting or corrupting the banner;
- zero-comment rows retain GitHub's default absence of a counter;
- dynamic rows and route transitions preserve native UI while managing banner
  lifecycle correctly; and
- the complete unit, integration, build, manifest, bundle, and end-to-end
  verification gate passes.

## Documentation

Update the README and extension description so they say the extension adds
review-thread, diff, and AI-agent summaries alongside GitHub's native comment
counter instead of replacing that counter or including total comments in the
banner.
