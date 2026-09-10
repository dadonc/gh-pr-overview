# GitHub PR Overview

GitHub PR Overview is a read-only Chrome extension that adds a compact review
summary to repository pull-request lists while preserving GitHub's native
right-side comment counter. It shows summaries on repository `/owner/repo/pulls`
pages, including when reached through GitHub's navigation without a full reload.
Both the classic and redesigned GitHub PR lists are supported.

## Toolbar control

Click the GitHub PR Overview toolbar icon to disable or enable the extension
globally. The full-color icon means enabled; the dimmed grayscale icon means
disabled. Changes apply immediately to every open GitHub pull-request list, and
the choice persists across browser restarts and extension updates.

## What it shows

- GitHub's untouched native total-comment counter in its original position.
- Active unresolved review threads as `X unresolved`. The extension still
  computes the complete thread totals and resolved-or-outdated breakdown
  internally.
- Deletions, additions, and files changed as `−X/+X X files`.
- Participation from an explicit allowlist of AI coding and review agents as
  `Name responseCount`, including a zero count when an agent was requested but
  has not responded.
- A subtle marker for pull requests authored by the signed-in viewer.

Incomplete thread and agent counts use `≥`, for example `≥0 unresolved` or
`Codex ≥1`, so missing conversation data is visible without hovering. Partial
diff counts retain their `+` suffix. Hovering explains what GitHub omitted.

Visible rows are checked every minute and when the tab regains focus or becomes
visible. Summaries older than 60 seconds refresh; a native comment-count change
also requests fresh data. Existing counts stay visible while refreshing, and
offscreen rows wait until they are near the viewport. A **Retry** button appears
when a request fails, including a failed timeline fragment, and bypasses the
cache. It is disabled while loading. Hidden or omitted data in successful
responses keeps its incomplete-count label without a Retry button.

Each request has a 15-second deadline covering both response headers and body
download. A timeout displays a recoverable error and releases its request slot
so subsequent rows can load. Disabling the extension or leaving the list
cancels work and removes refresh timers and listeners.

The extension overview stays on one line, with its metrics separated by `·`.
When the available row is narrower than the summary, the card scrolls
horizontally inside the pull-request row.

Eligible pull-request rows start loading from the top of the list. Each row
shows its independently complete diff data as soon as it is ready, while its
review-thread and agent data continues loading.

Total comments and review threads are independent metrics. Issue comments,
review summaries, and other non-resolvable discussion remain represented by
GitHub's native total comment count, but are not counted as review threads.

## Privacy and permissions

The extension:

- only reads GitHub pages that the current signed-in user can already access;
- makes authenticated, same-origin `GET` requests to GitHub conversation,
  timeline-fragment, and files pages;
- never posts, edits, resolves, or deletes GitHub data;
- never sends repository, pull-request, comment, or account data to an external
  service;
- keeps its 60-second summary cache in memory only;
- stores one local `enabled` boolean and no GitHub data; and
- declares only the `storage` permission, used for that preference. Its only
  site access is `https://github.com/*`, allowing the route watcher to activate
  after navigation from another GitHub page. Outside repository PR lists it
  does not mount cards, observe page mutations, or fetch PR data. It declares
  no `host_permissions`.

The content script parses fetched documents with `DOMParser`. Fetched HTML is
never inserted into the page or executed.

## Release verification

Run the consolidated automated gate before packaging a release:

```sh
npm run verify
```

### Manual signed-in Chrome Stable checklist (not automated)

Use a disposable GitHub account and a disposable repository for these checks.
Automated fixtures cannot prove them:

- Public and private PR lists render.
- Exact and progressive diff totals are correct.
- Deferred thread bodies show honest agent lower bounds; hidden review
  conversations make both thread and agent totals explicit lower bounds.
- Scrolling starts eligible pending rows from the top of the list.
- A completed diff section appears while review-thread and agent sections are still loading.
- Filtering, Turbo navigation, dynamic rows, and route exit work.
- Entering a PR list from a repository or conversation page activates without reload.
- Stale rows refresh on focus, native count changes revalidate, and Retry recovers failures.
- Slow requests time out without preventing later rows from loading.
- Native counters remain untouched through Turbo navigation, route exit, and extension disable.
- A pinned toolbar click disables and re-enables the extension without opening a popup.
- All open matching GitHub tabs update immediately without reload.
- Disabled state uses the dimmed grayscale icon; enabled state uses the full-color icon.
- The tooltip offers the inverse action in each state.
- The choice survives a browser restart and extension update.
- No request leaves `github.com`.
- Page and extension consoles contain no CSP/runtime errors.
- Narrow viewport, keyboard focus, dark mode, and reduced motion remain usable.
- Profiles, cookies, private HTML, HAR, trace, and screenshots are never committed.

## Develop and test

Requirements: Node.js 22.12+ within the 22.x line, or Node.js 24+, and npm.
Verification uses Node.js 24.15.0.

```sh
npm ci
npm test
npm run compile
npm run build
npm run verify:manifest
```

`npm run build` creates the unpacked Chrome Manifest V3 extension in
`output/chrome-mv3`. The manifest verifier checks that the build contains only
exactly one GitHub-only content script, one popup-free action, one module
service worker, and the `storage` permission while rejecting host permissions
and web-accessible resources.

For local development, run `npm run dev` and use WXT's generated development
output.

## Load the unpacked extension

1. Run `npm ci`, then `npm run build`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's `output/chrome-mv3` directory.
6. Open a repository pull-request list while signed in to GitHub.

After rebuilding, use the extension's reload button on `chrome://extensions`
and refresh the GitHub tab.

### `— files` or `Failed to fetch`

GitHub may redirect a pull request's legacy `/files` URL to its newer
same-pull-request `/changes` URL. The extension follows and validates that
redirect and reads the exact per-file summaries exposed by the new page. If the
files segment still remains `— files` and its tooltip reports `Failed to fetch`,
test the extension in a clean Chrome profile. Another extension, privacy filter,
or managed profile policy may be blocking the request. Allow GitHub pull-request
files-page requests in the blocker or policy, then reload both the unpacked
extension and the GitHub tab.

This project is source-controlled for local testing and review. It has not been
published to the Chrome Web Store.
