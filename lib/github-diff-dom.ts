import type { DiffSummary } from './domain';

export interface DiffExtraction {
  completeness: { isComplete: boolean; reasons: readonly string[] };
  data: DiffSummary;
}

function parseUnsignedMetric(value: string | null | undefined): number | undefined {
  const normalized = value?.trim().replaceAll(',', '');
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseSignedDisplayMetric(
  value: string | null | undefined,
  sign: '+' | '-',
): number | undefined {
  const normalized = value?.trim().replaceAll(',', '').replace('−', '-');
  const pattern = sign === '+' ? /^\+(\d+)$/ : /^-(\d+)$/;
  const digits = normalized?.match(pattern)?.[1];
  return parseUnsignedMetric(digits);
}

function parseMetric(text: string, label: string): number | undefined {
  const match = text.match(new RegExp(`([\\d,]+)\\s+${label}`, 'i'));
  return match ? Number(match[1]!.replaceAll(',', '')) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseEmbeddedMetric(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return typeof value === 'string' ? parseUnsignedMetric(value) : undefined;
}

function extractChangesAppSummary(document: Document): DiffExtraction | undefined {
  const scripts = document.querySelectorAll(
    'react-app:is([app-name="pull-requests"], [app-name="repo"]) '
    + 'script[type="application/json"][data-target="react-app.embeddedData"]',
  );

  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue;
    }

    if (!isObject(parsed) || !isObject(parsed.payload)) continue;
    const route = parsed.payload.pullRequestsChangesRoute;
    if (!isObject(route) || !Array.isArray(route.diffSummaries)) continue;
    if (route.diffSummaries.length === 0) continue;

    let additions = 0;
    let deletions = 0;
    let isValid = true;

    for (const summary of route.diffSummaries) {
      if (!isObject(summary) || typeof summary.changeType !== 'string') {
        isValid = false;
        break;
      }

      const linesAdded = parseEmbeddedMetric(summary.linesAdded);
      const linesDeleted = parseEmbeddedMetric(summary.linesDeleted);
      const linesChanged = parseEmbeddedMetric(summary.linesChanged);
      if (
        linesAdded === undefined
        || linesDeleted === undefined
        || (
          linesChanged !== undefined
          && linesChanged !== linesAdded + linesDeleted
        )
        || !Number.isSafeInteger(additions + linesAdded)
        || !Number.isSafeInteger(deletions + linesDeleted)
      ) {
        isValid = false;
        break;
      }

      additions += linesAdded;
      deletions += linesDeleted;
    }

    if (!isValid) continue;

    const filesChanged = route.diffSummaries.length;
    const filesLimit = isObject(route.pageLimits)
      ? parseEmbeddedMetric(route.pageLimits.filesLimit)
      : undefined;
    const reachedFilesLimit = filesLimit !== undefined && filesChanged >= filesLimit;

    return {
      completeness: reachedFilesLimit
        ? {
            isComplete: false,
            reasons: ['GitHub limited the new files-changed summary.'],
          }
        : { isComplete: true, reasons: [] },
      data: { additions, deletions, filesChanged },
    };
  }

  return undefined;
}

export function extractDiffSummary(document: Document): DiffExtraction {
  const filesCounter = document.querySelector<HTMLElement>('#files_tab_counter');
  const diffstat = document.querySelector<HTMLElement>('#diffstat');
  const current = {
    filesChanged: parseUnsignedMetric(
      filesCounter?.getAttribute('title') ?? filesCounter?.textContent,
    ),
    additions: parseSignedDisplayMetric(
      diffstat?.querySelector<HTMLElement>('.color-fg-success')?.textContent,
      '+',
    ),
    deletions: parseSignedDisplayMetric(
      diffstat?.querySelector<HTMLElement>('.color-fg-danger')?.textContent,
      '-',
    ),
  };

  if (
    current.filesChanged !== undefined
    && current.additions !== undefined
    && current.deletions !== undefined
  ) {
    return {
      completeness: { isComplete: true, reasons: [] },
      data: {
        additions: current.additions,
        deletions: current.deletions,
        filesChanged: current.filesChanged,
      },
    };
  }

  const changesAppSummary = extractChangesAppSummary(document);
  if (changesAppSummary) return changesAppSummary;

  for (const region of document.querySelectorAll<HTMLElement>(
    '.diffstat, [data-diffstat], [data-testid="diffstat"]',
  )) {
    const semanticText = [
      region,
      ...region.querySelectorAll<HTMLElement>('[aria-label], [title]'),
    ]
      .map(
        (element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`,
      )
      .join(' ');
    const filesChanged = parseMetric(semanticText, 'files? changed');
    const additions = parseMetric(semanticText, 'additions?');
    const deletions = parseMetric(semanticText, 'deletions?');

    if (
      filesChanged !== undefined
      && additions !== undefined
      && deletions !== undefined
    ) {
      return {
        completeness: { isComplete: true, reasons: [] },
        data: { additions, deletions, filesChanged },
      };
    }
  }

  const files = new Set<string>();
  for (const [index, file] of [
    ...document.querySelectorAll<HTMLElement>('.file.js-file, .js-file'),
  ].entries()) {
    files.add(
      file.querySelector('a[title]')?.getAttribute('title')
      ?? `rendered-file-${index}`,
    );
  }

  const countLines = (selector: string) => {
    const lines = new Set<string>();
    for (const [index, line] of [
      ...document.querySelectorAll<HTMLElement>(selector),
    ].entries()) {
      const file = line
        .closest('.file.js-file, .js-file')
        ?.querySelector('a[title]')
        ?.getAttribute('title') ?? 'unknown-file';
      lines.add(`${file}:${line.getAttribute('data-line-number') ?? index}`);
    }
    return lines.size;
  };

  const partial = Boolean(document.querySelector(`
    [data-file-type="collapsed"],
    [data-file-type="suppressed"],
    [data-file-type="truncated"],
    .js-diff-load,
    .js-diff-load-container,
    include-fragment[data-fragment-url],
    include-fragment.diff-progressive-loader[src],
    include-fragment.js-diff-progressive-loader[src],
    include-fragment[data-targets~="diff-file-filter.progressiveLoaders"][src],
    [data-diff-truncated]
  `));
  const additions = countLines('.blob-code-addition');
  const deletions = countLines('.blob-code-deletion');
  const hasRenderedEvidence = files.size > 0 || additions > 0 || deletions > 0;

  return {
    completeness: partial
      ? {
          isComplete: false,
          reasons: ['One or more diff files are collapsed, truncated, or not loaded.'],
        }
      : hasRenderedEvidence
        ? { isComplete: true, reasons: [] }
        : {
            isComplete: false,
            reasons: ['GitHub did not expose recognizable diff evidence.'],
          },
    data: { additions, deletions, filesChanged: files.size },
  };
}
