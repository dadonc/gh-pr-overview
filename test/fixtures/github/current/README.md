# Current GitHub fixture set

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
