function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** GitHub's merge_box page data lists filenames in its merge-conflict condition. */
export function extractMergeConflictCount(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value.pullRequest) && ['CLOSED', 'MERGED'].includes(String(value.pullRequest.state))) return 0;
  if (!isObject(value.mergeRequirements) || !Array.isArray(value.mergeRequirements.conditions)) return undefined;
  const condition = value.mergeRequirements.conditions.find(candidate =>
    isObject(candidate) && candidate.type === 'PULL_REQUEST_MERGE_CONFLICT_STATE',
  );
  if (!isObject(condition)) return undefined;
  if (condition.result === 'PASSED') return 0;
  if (condition.result !== 'FAILED' || !Array.isArray(condition.conflicts)) return undefined;
  if (!condition.conflicts.every(file => typeof file === 'string' && file.trim().length > 0)) return undefined;
  return new Set(condition.conflicts).size;
}

export function hasMergeBox(document: Document): boolean {
  return Boolean(document.querySelector(
    'react-app[app-name="pull-requests"], react-partial[partial-name="pull-requests-mergebox"], [data-testid="mergebox-partial"]',
  ));
}
