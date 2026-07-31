# GitHub PR Overview

GitHub PR Overview is a read-only Chrome extension that adds a compact review
summary to repository pull-request lists while preserving GitHub's native
right-side comment counter. It runs on URLs matching
`https://github.com/*/*/pulls*`.

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
- stores no user data or preferences; and
- declares no `permissions` or `host_permissions` entries; its only site access
  is the path-scoped GitHub content script listed above.

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
- Deferred threads show exact thread totals and honest agent lower bounds.
- Scrolling starts eligible pending rows from the top of the list.
- A completed diff section appears while review-thread and agent sections are still loading.
- Filtering, Turbo navigation, dynamic rows, and route exit work.
- Native counters remain untouched through Turbo navigation, route exit, and extension disable.
- No request leaves `github.com`.
- Page and extension consoles contain no CSP/runtime errors.
- Narrow viewport, keyboard focus, dark mode, and reduced motion remain usable.
- Profiles, cookies, private HTML, HAR, trace, and screenshots are never committed.

## Develop and test

Requirements: a current Node.js release and npm.

```sh
npm ci
npm test
npm run compile
npm run build
npm run verify:manifest
```

`npm run build` creates the unpacked Chrome Manifest V3 extension in
`output/chrome-mv3`. The manifest verifier checks that the build contains only
the path-scoped GitHub content script and does not add a background worker,
toolbar action, extension permissions, host permissions, or web-accessible
resources.

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
