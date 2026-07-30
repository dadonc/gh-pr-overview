import type { DiffSummary } from './domain';

export interface DiffExtraction {
  completeness: { isComplete: boolean; reasons: readonly string[] };
  data: DiffSummary;
}
function parseMetric(text: string, label: string): number | undefined { const match = text.match(new RegExp(`([\\d,]+)\\s+${label}`, 'i')); return match ? Number(match[1]!.replaceAll(',', '')) : undefined; }
export function extractDiffSummary(document: Document): DiffExtraction {
  for (const region of document.querySelectorAll<HTMLElement>('.diffstat, [data-diffstat], [data-testid="diffstat"]')) {
    const semanticText = [region, ...region.querySelectorAll<HTMLElement>('[aria-label], [title]')].map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`).join(' ');
    const filesChanged = parseMetric(semanticText, 'files? changed'); const additions = parseMetric(semanticText, 'additions?'); const deletions = parseMetric(semanticText, 'deletions?');
    if (filesChanged !== undefined && additions !== undefined && deletions !== undefined) return { completeness: { isComplete: true, reasons: [] }, data: { additions, deletions, filesChanged } };
  }
  const files = new Set<string>(); for (const [index, file] of [...document.querySelectorAll<HTMLElement>('.file.js-file, .js-file')].entries()) files.add(file.querySelector('a[title]')?.getAttribute('title') ?? `rendered-file-${index}`);
  const countLines = (selector: string) => { const lines = new Set<string>(); for (const [index, line] of [...document.querySelectorAll<HTMLElement>(selector)].entries()) { const file = line.closest('.file.js-file, .js-file')?.querySelector('a[title]')?.getAttribute('title') ?? 'unknown-file'; lines.add(`${file}:${line.getAttribute('data-line-number') ?? index}`); } return lines.size; };
  const partial = Boolean(document.querySelector('[data-file-type="collapsed"], [data-file-type="suppressed"], [data-file-type="truncated"], .js-diff-load, .js-diff-load-container, include-fragment[data-fragment-url], [data-diff-truncated]'));
  const hasRenderedEvidence = files.size > 0 || countLines('.blob-code-addition') > 0 || countLines('.blob-code-deletion') > 0;
  return { completeness: partial ? { isComplete: false, reasons: ['One or more diff files are collapsed, truncated, or not loaded.'] } : hasRenderedEvidence ? { isComplete: true, reasons: [] } : { isComplete: false, reasons: ['GitHub did not expose recognizable diff evidence.'] }, data: { additions: countLines('.blob-code-addition'), deletions: countLines('.blob-code-deletion'), filesChanged: files.size } };
}
