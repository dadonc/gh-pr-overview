# GitHub Timeline Fragment Request Compatibility

## Problem

The extension follows progressive timeline URLs exposed by GitHub pull-request
conversation pages so it can count review threads and AI-agent activity beyond
the initially rendered timeline. GitHub now returns `404 Not Found` when its
internal `timeline_focused_item` endpoint is fetched without the request
metadata used by GitHub's own fragment loader. The extension consequently
reports lower-bound data with a tooltip such as:

> A timeline fragment could not be loaded: GitHub request failed (404).

Current GitHub pages may also include a nonempty `before_cursor` alongside
`after_cursor` and `id`. The extension currently rejects that URL shape before
fetching it.

## Goals

- Fetch validated timeline fragments using GitHub's current request contract.
- Support focused fragment URLs with an optional nonempty `before_cursor`.
- Keep timeline requests constrained to the current pull request's trusted
  GitHub repository endpoint.
- Preserve accumulated data as a lower-bound partial result when a fragment
  genuinely remains unavailable.
- Do not change full conversation-page or files-page request behavior.

## Request Metadata

After the conversation document is loaded, the client reads these values from
its `<head>`:

- `meta[name="fetch-nonce"]` supplies `X-Fetch-Nonce`.
- `meta[name="release"]` supplies `X-GitHub-Client-Version`.

Every timeline-fragment request sends `X-Requested-With: XMLHttpRequest`.
The nonce and client-version headers are added when their corresponding meta
values are present and nonempty. These headers are used only for URLs that have
already passed the existing fragment URL validation.

Missing metadata does not turn the conversation page into an error. The client
still attempts the fragment request with the headers it can construct; any
resulting failure follows the existing partial-data path.

## URL Validation

Legacy `/{owner}/{repository}/pull/{number}/timeline` URLs retain their current
validation rules.

Focused `/{owner}/{repository}/timeline_focused_item` URLs require exactly one
nonempty `after_cursor` and exactly one valid pull-request node `id`. They may
also contain exactly one nonempty `before_cursor`. No other query keys,
credentials, ports, fragments, origins, repositories, or path variants are
accepted.

The focused pull-request node ID remains pinned across all fragments in a load,
so a later fragment cannot switch the request to another pull request.

## Data Flow and Error Handling

1. Fetch and parse the canonical conversation and files pages as today.
2. Derive fragment request headers from the parsed conversation document.
3. Extract and validate progressive timeline URLs.
4. Fetch validated fragments with the derived headers, retaining the existing
   concurrency cap, deduplication, cycle handling, and fragment limit.
5. Merge successful fragment documents into the timeline aggregation.
6. If a fragment fails or is structurally invalid, keep all accumulated counts
   and mark timeline-derived sections partial with the existing reason text.

The request failure remains retryable and therefore is not cached. Structural
partials keep their current cache behavior.

## Testing

Unit tests will verify that:

- focused timeline fragment requests receive all three GitHub headers when the
  conversation page exposes nonce and release metadata;
- missing optional metadata is omitted without breaking the load;
- a focused URL with one nonempty `before_cursor` is accepted and fetched;
- duplicate, empty, or otherwise unexpected cursor parameters remain rejected;
- full conversation and files requests do not receive fragment-only headers;
- a failed fragment still returns accumulated lower-bound data as partial and
  remains uncached.

Existing integration, compile, build, manifest, bundle, and end-to-end checks
will remain unchanged and will be run after implementation.

## Out of Scope

- Replacing HTML parsing with GitHub's authenticated GraphQL API.
- Triggering or manipulating GitHub's native “Load more” UI.
- Changing the overview's partial-state wording or presentation.
- Adding broader fallback counts from unrelated GitHub surfaces.
