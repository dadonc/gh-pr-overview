# Current GitHub fixture set

## Repo app changes wrapper (2026-09-14)

`changes-repo.html` retains the diff summary structure captured from the
signed-in files-changed page (redirected to `/changes`). GitHub now wraps the
same `payload.pullRequestsChangesRoute` in `react-app[app-name="repo"]`.
Only numeric diff metrics, change types, and file-limit fields are retained;
repository, user, file content, paths, and session data are omitted.
Expected totals: 1,301 additions, 674 deletions, 12 files. The older
`changes.html` fixture covers the `pull-requests` app wrapper.

## Original fixture set

- Capture date: 2026-07-29
- Public structural references:
  - `https://github.com/microsoft/vscode/pulls`
  - `https://github.com/microsoft/vscode/pull/328058`
  - `https://github.com/microsoft/vscode/pull/328058/files`
- Sanitization: repository, users, cursor values, content, IDs, and file names
  are replaced; selector-bearing wrappers, endpoint shapes, state attributes,
  Unicode minus signs, and embedded JSON property paths are preserved.
- Retained typed numeric IDs use the synthetic PR-42 series `420000001` through
  `420000003` and preserve only the shapes each parser validates.
- Tests never refresh these files from the network.

Expected PR 42 summary:

- 2 native comments
- 1 review thread: 0 unresolved, 1 resolved/outdated
- 18 changed files, 524 additions, 353 deletions
- Copilot requested and responded at least once
- Agent evidence is partial because a deferred body remains unloaded

## React PR list (2026-09-10)

`pr-list-react.html` is a minimal sanitized reconstruction of the signed-in
React ListView inspected on 2026-09-10. It preserves the observed list marker,
title and author test IDs, description nesting, and non-link Octicon comment
counter. Repository, author, title, IDs, timestamps, and CSS-module suffixes are
synthetic. The expected native count is 12; PR 42 uses the existing remote
summary fixtures. The legacy `pr-list.html` remains covered because public and
signed-out GitHub pages still serve that layout.

## Timeline pagination correction (2026-09-10)

The earlier fixture incorrectly treated `data-timeline-item-src` as pagination.
GitHub's frontend uses that helper only for a specific comment anchor. The
conversation fixture now includes both that ignored helper and a GET pagination
form with the observed `/pull/{number}/timeline_more_items` action. The standalone
`timeline-pagination.html` reproduces the form with both cursors. This contract
was verified against public `microsoft/TypeScript` PRs 40336 and 54505; requests
with `Accept: text/html` return HTML and subsequent pagination forms.
