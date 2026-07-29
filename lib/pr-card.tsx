import { useId, type ReactNode } from 'react';
import type { AgentParticipation, PullRequestSummary, SectionState } from './domain';
import { AI_AGENT_REGISTRY } from './domain';

export const CARD_STYLES = `
:host { display: inline-block; max-width: 100%; }
.pr-overview-card { color: var(--fgColor-default, #1f2328); font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; flex-wrap: wrap; gap: 3px 8px; align-items: center; border: 1px solid var(--borderColor-muted, #d0d7de); border-radius: 6px; background: var(--bgColor-default, #fff); padding: 4px 6px; }
.pr-overview-card.authored { border-left: 3px solid var(--fgColor-accent, #0969da); }
.metric { color: var(--fgColor-muted, #59636e); text-decoration: none; white-space: nowrap; }
.metric:hover { color: var(--fgColor-accent, #0969da); text-decoration: underline; }
.metric:focus-visible { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: 2px; border-radius: 2px; }
.total { color: var(--fgColor-default, #1f2328); font-size: 13px; font-weight: 600; }
.agent { border-radius: 999px; background: var(--bgColor-neutral-muted, #f6f8fa); color: var(--fgColor-default, #1f2328); padding: 1px 5px; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (prefers-color-scheme: dark) { .pr-overview-card { color: var(--fgColor-default, #f0f6fc); background: var(--bgColor-default, #0d1117); border-color: var(--borderColor-muted, #30363d); } .agent { background: var(--bgColor-neutral-muted, #21262d); color: var(--fgColor-default, #f0f6fc); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

export interface PullRequestCardProps {
  conversationHref: string;
  filesHref: string;
  summary: PullRequestSummary;
}

function sectionTitle<T>(section: SectionState<T>): string | undefined {
  return section.status === 'error' ? section.message : section.status === 'partial' ? section.reason : undefined;
}

function agentLabel(agent: AgentParticipation): string {
  const name = AI_AGENT_REGISTRY.find((candidate) => candidate.id === agent.agentId)?.label ?? agent.agentId;
  return agent.state === 'responded' ? `${name} Responded · ${agent.responseCount}` : `${name} Requested`;
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

function TotalComments({ section, fallbackHref }: { fallbackHref: string; section: PullRequestSummary['totalComments'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric total" aria-label="Loading total comments">Loading comments…</span>;
  if (section.status === 'error') return <><span className="metric total" title={section.message} aria-describedby={descriptionId}>— total comments</span><Description id={descriptionId}>{section.message}</Description></>;
  const partial = section.status === 'partial';
  return <><a className="metric total" href={section.data.href || fallbackHref} title={sectionTitle(section)} aria-describedby={partial ? descriptionId : undefined}>{section.data.count}{partial ? '+' : ''} total {section.data.count === 1 ? 'comment' : 'comments'}</a>{partial && <Description id={descriptionId}>Lower-bound total comments: {section.reason}</Description>}</>;
}

function ReviewThreads({ href, section }: { href: string; section: PullRequestSummary['reviewThreads'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric" aria-label="Loading review threads">Loading threads…</span>;
  if (section.status === 'error') return <><span className="metric" title={section.message} aria-describedby={descriptionId}>— review threads</span><Description id={descriptionId}>{section.message}</Description></>;
  const suffix = section.status === 'partial' ? '+' : '';
  return <><a className="metric" href={href} title={sectionTitle(section)} aria-describedby={section.status === 'partial' ? descriptionId : undefined}>{section.data.total}{suffix} {section.data.total === 1 ? 'review thread' : 'review threads'} · {section.data.unresolved}{suffix} unresolved · {section.data.resolvedOrOutdated}{suffix} resolved+outdated</a>{section.status === 'partial' && <Description id={descriptionId}>Lower-bound review thread aggregate and breakdown: {section.reason}</Description>}</>;
}

function Diff({ href, section }: { href: string; section: PullRequestSummary['diff'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric" aria-label="Loading changed files">Loading files…</span>;
  if (section.status === 'error') return <><span className="metric" title={section.message} aria-describedby={descriptionId}>— files</span><Description id={descriptionId}>{section.message}</Description></>;
  const suffix = section.status === 'partial' ? '+' : '';
  return <><a className="metric" href={href} title={sectionTitle(section)} aria-describedby={section.status === 'partial' ? descriptionId : undefined}>{section.data.filesChanged}{suffix} {section.data.filesChanged === 1 ? 'file' : 'files'} · +{section.data.additions}{suffix} −{section.data.deletions}{suffix}</a>{section.status === 'partial' && <Description id={descriptionId}>Lower-bound changed-file summary: {section.reason}</Description>}</>;
}

function Agents({ section }: { section: PullRequestSummary['agents'] }) {
  const descriptionId = useId();
  if (section.status === 'loading') return <span className="metric" aria-label="Loading AI agents">Loading agents…</span>;
  if (section.status === 'error') return <><span className="metric" title={section.message} aria-describedby={descriptionId}>AI agents unavailable</span><Description id={descriptionId}>{section.message}</Description></>;
  if (section.data.length === 0) return section.status === 'partial'
    ? <><span className="metric" title={section.reason} aria-describedby={descriptionId}>No AI agents detected yet</span><Description id={descriptionId}>Partial AI agent detection: {section.reason}</Description></>
    : <span className="metric">No AI agents</span>;
  return <>{section.data.map((agent) => {
    const title = `${agentTitle(agent)}${section.status === 'partial' ? ` Partial agent data: ${section.reason}` : ''}`;
    const id = `${descriptionId}-${agent.agentId}`;
    return <span className="agent" key={agent.agentId} title={title} aria-describedby={id}>{agentLabel(agent)}<Description id={id}>{title}</Description></span>;
  })}</>;
}

export function PullRequestCard({ conversationHref, filesHref, summary }: PullRequestCardProps) {
  return <div className={`pr-overview-card${summary.authoredByViewer ? ' authored' : ''}`} data-testid="pr-card" role="group" aria-label="Pull request review overview">
    {summary.authoredByViewer && <span className="sr-only">Authored by you</span>}
    <TotalComments section={summary.totalComments} fallbackHref={conversationHref} />
    <ReviewThreads section={summary.reviewThreads} href={conversationHref} />
    <Diff section={summary.diff} href={filesHref} />
    <Agents section={summary.agents} />
  </div>;
}
