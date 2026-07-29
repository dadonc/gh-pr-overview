# GitHub PR Overview

GitHub PR Overview is a read-only Chrome extension that replaces the standalone
comment counter on repository pull-request lists with a compact review summary.
It runs on URLs matching `https://github.com/*/*/pulls*`.

## What it shows

- GitHub's native total comment count, unchanged, as the primary metric.
- Unique review-thread totals split into active unresolved and
  resolved-or-outdated conversations.
- Files changed, additions, and deletions.
- Participation from an explicit allowlist of AI coding and review agents,
  including whether each agent was requested or responded and its response
  count.
- A subtle marker for pull requests authored by the signed-in viewer.

Total comments and review threads are independent metrics. Issue comments,
review summaries, and other non-resolvable discussion still remain represented
by GitHub's total comment count, but are not counted as review threads.

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
`.output/chrome-mv3`. The manifest verifier checks that the build contains only
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
5. Choose this repository's `.output/chrome-mv3` directory.
6. Open a repository pull-request list while signed in to GitHub.

After rebuilding, use the extension's reload button on `chrome://extensions`
and refresh the GitHub tab.

This project is source-controlled for local testing and review. It has not been
published to the Chrome Web Store.
