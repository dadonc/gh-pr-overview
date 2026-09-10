import { Fragment, useId, type ReactNode } from 'react';
import type { AgentParticipation, PullRequestSummary, SectionState } from './domain';
import { AI_AGENT_REGISTRY } from './domain';

export const CARD_STYLES = `
:host { display: block !important; min-width: 0 !important; max-width: 100% !important; margin-top: 4px !important; }
.pr-overview-card { position: relative; box-sizing: border-box; width: fit-content; min-width: 0; max-width: 100%; margin-inline-start: 0; margin-inline-end: auto; color: var(--fgColor-default, #1f2328); font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: 400; display: flex; flex-flow: row nowrap; gap: 0; align-items: baseline; overflow-x: auto; overflow-y: hidden; white-space: nowrap; border: 1px solid var(--borderColor-muted, #d0d7de); border-radius: 6px; background: var(--bgColor-default, #fff); padding: 4px 6px; }
.pr-overview-card.authored { border-left: 3px solid var(--fgColor-accent, #0969da); }
.metric, .agent, .separator { flex: 0 0 auto; font-weight: 400; }
.metric { color: var(--fgColor-muted, #59636e); text-decoration: none; }
.metric:hover { color: var(--fgColor-accent, #0969da); text-decoration: underline; }
.metric:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 2px; border-radius: 2px; }
.unresolved { font-weight: 600; }
.deletions { color: var(--fgColor-danger, var(--color-danger-fg, #d1242f)); }
.additions { color: var(--fgColor-success, var(--color-success-fg, #1a7f37)); }
.agent { color: var(--fgColor-default, #1f2328); }
.retry { flex: 0 0 auto; border: 0; padding: 0; color: var(--fgColor-accent, #0969da); background: transparent; font: inherit; cursor: pointer; }
.retry:hover { text-decoration: underline; }
.retry:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 2px; border-radius: 2px; }
.retry:disabled { color: var(--fgColor-muted, #59636e); cursor: default; text-decoration: none; }
.separator { color: var(--fgColor-muted, #59636e); margin-inline: 5px; user-select: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (prefers-color-scheme: dark) { .pr-overview-card { color: var(--fgColor-default, #f0f6fc); background: var(--bgColor-default, #0d1117); border-color: var(--borderColor-muted, #30363d); } .deletions { color: var(--fgColor-danger, var(--color-danger-fg, #f85149)); } .additions { color: var(--fgColor-success, var(--color-success-fg, #3fb950)); } .agent { color: var(--fgColor-default, #f0f6fc); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

export interface PullRequestCardProps {
  conversationHref: string;
  filesHref: string;
  onRetry?: () => void;
  refreshing?: boolean;
  summary: PullRequestSummary;
}

function sectionTitle<T>(section: SectionState<T>): string | undefined {
  return section.status === 'error' ? section.message : section.status === 'partial' ? section.reason : undefined;
}

function agentLabel(agent: AgentParticipation): string {
  const name = AI_AGENT_REGISTRY.find((candidate) => candidate.id === agent.agentId)?.label ?? agent.agentId;
  return `${name} ${agent.responseCount}`;
}

function agentTitle(agent: AgentParticipation): string {
  if (agent.requestSources.length === 0) return `Responded ${agent.responseCount} ${agent.responseCount === 1 ? 'time' : 'times'}.`;
  const sources = agent.requestSources.map((source) => source === 'eyes-reaction'
    ? '👀 reaction'
    : source === 'started-reviewing' ? 'started reviewing' : 'a formal review request');
  const provenance = sources.length === 1 ? sources[0]! : `${sources.slice(0, -1).join(', ')}, and ${sources.at(-1)}`;
  if (agent.state === 'requested' && agent.requestSources.length === 1 && agent.requestSources[0] === 'eyes-reaction') return 'Requested — detected from 👀 reaction.';
  return agent.state === 'responded' ? `Responded after ${provenance}.` : `Requested — detected from ${provenance}.`;
}

function Description({ children, id }: { children: ReactNode; id: string }) {
  return <span className="sr-only" id={id}>{children}</span>;
}

function Separator() {
  return <span className="separator" aria-hidden="true">·</span>;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ReviewThreads({ href, section }: { href: string; section: PullRequestSummary['reviewThreads'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric" aria-label="Loading unresolved review threads">Loading unresolved…</span>;
  if (section.status === 'error') return <><span className="metric" title={section.message} aria-describedby={descriptionId}>— unresolved</span><Description id={descriptionId}>{section.message}</Description></>;
  const accessibleLabel = `${section.status === 'partial' ? 'At least ' : ''}${countLabel(section.data.unresolved, 'unresolved review thread')}`;
  const className = `metric${section.data.unresolved > 0 ? ' unresolved' : ''}`;
  return <><a className={className} href={href} title={sectionTitle(section)} aria-label={accessibleLabel} aria-describedby={section.status === 'partial' ? descriptionId : undefined}>{section.data.unresolved} unresolved</a>{section.status === 'partial' && <Description id={descriptionId}>Lower-bound unresolved review threads: {section.reason}</Description>}</>;
}

function Diff({ href, section }: { href: string; section: PullRequestSummary['diff'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric diff" aria-label="Loading changed files">Loading files…</span>;
  if (section.status === 'error') return <><span className="metric diff" title={section.message} aria-describedby={descriptionId}>— files</span><Description id={descriptionId}>{section.message}</Description></>;
  const suffix = section.status === 'partial' ? '+' : '';
  const accessibleLabel = `${section.status === 'partial' ? 'At least ' : ''}${countLabel(section.data.deletions, 'deletion')}, ${countLabel(section.data.additions, 'addition')}, ${countLabel(section.data.filesChanged, 'file')} changed`;
  return <><a className="metric diff" href={href} title={sectionTitle(section)} aria-label={accessibleLabel} aria-describedby={section.status === 'partial' ? descriptionId : undefined}><span className="deletions">−{section.data.deletions}{suffix}</span>/<span className="additions">+{section.data.additions}{suffix}</span><span className="diff-separator" aria-hidden="true"> · </span>{section.data.filesChanged}{suffix} {section.data.filesChanged === 1 ? 'file' : 'files'}</a>{section.status === 'partial' && <Description id={descriptionId}>Lower-bound changed-file summary: {section.reason}</Description>}</>;
}

function Agents({ section }: { section: PullRequestSummary['agents'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric" aria-label="Loading AI agents">Loading agents…</span>;
  if (section.status === 'error') return <><span className="metric" title={section.message} aria-describedby={descriptionId}>AI agents unavailable</span><Description id={descriptionId}>{section.message}</Description></>;
  if (section.data.length === 0) return section.status === 'partial'
    ? <><span className="metric" title={section.reason} aria-describedby={descriptionId}>No AI agents detected yet</span><Description id={descriptionId}>Partial AI agent detection: {section.reason}</Description></>
    : <span className="metric">No AI agents</span>;
  return <>{section.data.map((agent, index) => {
    const title = `${agentTitle(agent)}${section.status === 'partial'
      ? ` At least ${countLabel(agent.responseCount, 'response')} detected. Partial agent data: ${section.reason}`
      : ''}`;
    const id = `${descriptionId}-${agent.agentId}`;
    return <Fragment key={agent.agentId}>
      {index > 0 && <Separator />}
      <span className="agent" title={title} aria-describedby={id}>{agentLabel(agent)}<Description id={id}>{title}</Description></span>
    </Fragment>;
  })}</>;
}

export function PullRequestCard({ conversationHref, filesHref, onRetry, refreshing = false, summary }: PullRequestCardProps) {
  const sections = [
    summary.reviewThreads,
    summary.diff,
    summary.agents,
  ];
  const loading = sections.some((section) => section.status === 'loading');
  const busy = refreshing || loading;
  const canRetry = sections.some((section) => section.status === 'error' || section.status === 'partial' && section.retryable);

  return <div className={`pr-overview-card${summary.authoredByViewer ? ' authored' : ''}`} data-testid="pr-card" role="group" aria-label="Pull request review overview" aria-busy={busy}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {busy ? 'Loading pull request overview.' : 'Pull request overview updated.'}
    </span>
    {summary.authoredByViewer && <span className="sr-only">Authored by you</span>}
    <ReviewThreads section={summary.reviewThreads} href={conversationHref} />
    <Separator />
    <Diff section={summary.diff} href={filesHref} />
    <Separator />
    <Agents section={summary.agents} />
    {canRetry && onRetry && <><Separator /><button className="retry" type="button" onClick={onRetry} disabled={busy} aria-label="Retry pull request overview">Retry</button></>}
  </div>;
}
