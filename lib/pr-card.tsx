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
  const source = agent.requestSources[0];
  const provenance = source === 'eyes-reaction'
    ? 'detected from 👀 reaction'
    : source === 'started-reviewing'
      ? 'detected from started reviewing'
      : 'a formal review request';
  return agent.state === 'responded' ? `Responded after ${provenance}.` : `Requested — ${provenance}.`;
}

function TotalComments({ section, fallbackHref }: { fallbackHref: string; section: PullRequestSummary['totalComments'] }) {
  if (section.status === 'loading') return <span className="metric total" aria-label="Loading total comments">Loading comments…</span>;
  if (section.status === 'error') return <span className="metric total" title={section.message}>— total comments</span>;
  return <a className="metric total" href={section.data.href || fallbackHref} title={sectionTitle(section)}>{section.data.count} total comments</a>;
}

function ReviewThreads({ href, section }: { href: string; section: PullRequestSummary['reviewThreads'] }) {
  if (section.status === 'loading') return <span className="metric" aria-label="Loading review threads">Loading threads…</span>;
  if (section.status === 'error') return <span className="metric" title={section.message}>— review threads</span>;
  const suffix = section.status === 'partial' ? '+' : '';
  return <a className="metric" href={href} title={sectionTitle(section)}>{section.data.total}{suffix} review threads · {section.data.unresolved} unresolved · {section.data.resolvedOrOutdated} resolved+outdated</a>;
}

function Diff({ href, section }: { href: string; section: PullRequestSummary['diff'] }) {
  if (section.status === 'loading') return <span className="metric" aria-label="Loading changed files">Loading files…</span>;
  if (section.status === 'error') return <span className="metric" title={section.message}>— files</span>;
  const suffix = section.status === 'partial' ? '+' : '';
  return <a className="metric" href={href} title={sectionTitle(section)}>{section.data.filesChanged}{suffix} files · +{section.data.additions}{suffix} −{section.data.deletions}{suffix}</a>;
}

function Agents({ section }: { section: PullRequestSummary['agents'] }) {
  if (section.status === 'loading') return <span className="metric" aria-label="Loading AI agents">Loading agents…</span>;
  if (section.status === 'error') return <span className="metric" title={section.message}>AI agents unavailable</span>;
  if (section.data.length === 0) return <span className="metric">No AI agents</span>;
  return <>{section.data.map((agent) => <span className="agent" key={agent.agentId} title={agentTitle(agent)}>{agentLabel(agent)}</span>)}</>;
}

export function PullRequestCard({ conversationHref, filesHref, summary }: PullRequestCardProps) {
  return <div className={`pr-overview-card${summary.authoredByViewer ? ' authored' : ''}`} data-testid="pr-card">
    {summary.authoredByViewer && <span className="sr-only">Authored by you</span>}
    <TotalComments section={summary.totalComments} fallbackHref={conversationHref} />
    <ReviewThreads section={summary.reviewThreads} href={conversationHref} />
    <Diff section={summary.diff} href={filesHref} />
    <Agents section={summary.agents} />
  </div>;
}
