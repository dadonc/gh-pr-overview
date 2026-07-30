export type SectionState<T> =
  | { status: 'loading' }
  | { data: T; status: 'ready' }
  | { data: T; reason: string; status: 'partial' }
  | { message: string; status: 'error' };

export interface TotalComments {
  count: number;
  href: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
}

export interface ReviewThreadCounts {
  unresolved: number;
  resolvedOrOutdated: number;
  total: number;
}

export type RequestSource =
  | 'formal-review-request'
  | 'started-reviewing'
  | 'eyes-reaction';

export type AgentId =
  | 'gemini'
  | 'codex'
  | 'claude'
  | 'cubic'
  | 'coderabbit'
  | 'devin'
  | 'copilot';

export interface AiAgentDefinition {
  id: AgentId;
  label: string;
  logins: readonly string[];
}

/**
 * The single allowlist for recognized AI reviewers. Add a login here rather
 * than adding identity checks at individual GitHub API call sites.
 */
export const AI_AGENT_REGISTRY: readonly AiAgentDefinition[] = [
  { id: 'gemini', label: 'Gemini', logins: ['gemini-code-assist', 'gemini-cli'] },
  { id: 'codex', label: 'Codex', logins: ['chatgpt-codex-connector', 'openai-code-agent'] },
  { id: 'claude', label: 'Claude', logins: ['claude', 'anthropic-code-agent'] },
  { id: 'cubic', label: 'Cubic', logins: ['cubic-dev-ai'] },
  { id: 'coderabbit', label: 'CodeRabbit', logins: ['coderabbitai'] },
  { id: 'devin', label: 'Devin', logins: ['devin-ai-integration'] },
  { id: 'copilot', label: 'Copilot', logins: ['copilot-pull-request-reviewer'] },
];

export interface AgentParticipation {
  agentId: AgentId;
  responseCount: number;
  /** Provenance is retained even when `state` is `responded`. */
  requestSources: readonly RequestSource[];
  /** A response always takes precedence over one or more request signals. */
  state: 'requested' | 'responded';
}

export interface DiffSummary {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface PullRequestIdentity {
  number: number;
  owner: string;
  repository: string;
}

export interface PullRequestSummary {
  agents: SectionState<readonly AgentParticipation[]>;
  authoredByViewer: boolean;
  diff: SectionState<DiffSummary>;
  reviewThreads: SectionState<ReviewThreadCounts>;
  totalComments: SectionState<TotalComments>;
}

export interface ResponseArtifact {
  actorLogin?: string;
  id: string;
}

export interface ReviewRequestArtifact {
  id: string;
  requestedLogin?: string;
}

export interface ReviewEventArtifact extends ResponseArtifact {
  action: string;
}

export interface ReactionArtifact extends ResponseArtifact {
  content: string;
}

export interface AgentParticipationInput {
  comments?: readonly ResponseArtifact[];
  inlineComments?: readonly ResponseArtifact[];
  reactions?: readonly ReactionArtifact[];
  reviewEvents?: readonly ReviewEventArtifact[];
  reviewRequests?: readonly ReviewRequestArtifact[];
  reviews?: readonly ResponseArtifact[];
  threadReplies?: readonly ResponseArtifact[];
}

export function classifyReviewThreads(
  reviewThreads: readonly ReviewThread[],
): ReviewThreadCounts {
  const uniqueThreads = new Map<string, { isOutdated: boolean; isResolved: boolean }>();

  for (const thread of reviewThreads) {
    const existing = uniqueThreads.get(thread.id);
    uniqueThreads.set(thread.id, {
      isOutdated: existing?.isOutdated || thread.isOutdated,
      isResolved: existing?.isResolved || thread.isResolved,
    });
  }

  let resolvedOrOutdated = 0;
  for (const thread of uniqueThreads.values()) {
    if (thread.isResolved || thread.isOutdated) {
      resolvedOrOutdated += 1;
    }
  }

  return {
    unresolved: uniqueThreads.size - resolvedOrOutdated,
    resolvedOrOutdated,
    total: uniqueThreads.size,
  };
}

export function normalizeAgentAccountLogin(
  login: string | null | undefined,
): string | undefined {
  if (!login) {
    return undefined;
  }

  const loginFromPath = login.trim().match(/(?:^|\/)(?:apps|users)\/([^/?#]+)/i)?.[1];
  const normalizedLogin = (loginFromPath ?? login)
    .trim()
    .split(/[/?#]/, 1)[0]
    .replace(/\[bot\]$/i, '')
    .toLowerCase();

  return AI_AGENT_REGISTRY.some((agent) => agent.logins.includes(normalizedLogin))
    ? normalizedLogin
    : undefined;
}

export function normalizeAgentLogin(login: string | null | undefined): AgentId | undefined {
  const accountLogin = normalizeAgentAccountLogin(login);
  return accountLogin
    ? AI_AGENT_REGISTRY.find((agent) => agent.logins.includes(accountLogin))?.id
    : undefined;
}

export function aggregateAgentParticipation(
  input: AgentParticipationInput,
): AgentParticipation[] {
  const participation = new Map<
    AgentId,
    { requestSources: Set<RequestSource>; responseCount: number }
  >();
  const seenResponseIds = new Set<string>();
  const seenReviewEventIds = new Set<string>();
  const seenReviewRequestIds = new Set<string>();
  const seenReactionIds = new Set<string>();

  const getParticipation = (agentId: AgentId) => {
    let entry = participation.get(agentId);
    if (!entry) {
      entry = { requestSources: new Set<RequestSource>(), responseCount: 0 };
      participation.set(agentId, entry);
    }
    return entry;
  };

  const addResponse = (artifact: ResponseArtifact) => {
    const agentId = normalizeAgentLogin(artifact.actorLogin);
    if (!agentId) {
      return;
    }

    if (seenResponseIds.has(artifact.id)) {
      return;
    }
    seenResponseIds.add(artifact.id);
    getParticipation(agentId).responseCount += 1;
  };

  for (const artifact of [
    ...(input.comments ?? []),
    ...(input.reviews ?? []),
    ...(input.inlineComments ?? []),
    ...(input.threadReplies ?? []),
  ]) {
    addResponse(artifact);
  }

  for (const request of input.reviewRequests ?? []) {
    const agentId = normalizeAgentLogin(request.requestedLogin);
    if (!agentId) {
      continue;
    }

    if (seenReviewRequestIds.has(request.id)) {
      continue;
    }
    seenReviewRequestIds.add(request.id);
    getParticipation(agentId).requestSources.add('formal-review-request');
  }

  for (const event of input.reviewEvents ?? []) {
    const agentId = normalizeAgentLogin(event.actorLogin);
    if (!agentId || event.action !== 'started-reviewing') {
      continue;
    }

    if (seenReviewEventIds.has(event.id)) {
      continue;
    }
    seenReviewEventIds.add(event.id);
    getParticipation(agentId).requestSources.add('started-reviewing');
  }

  for (const reaction of input.reactions ?? []) {
    const accountLogin = normalizeAgentAccountLogin(reaction.actorLogin);
    const agentId = normalizeAgentLogin(reaction.actorLogin);
    if (!accountLogin || !agentId || reaction.content.toLowerCase() !== 'eyes') {
      continue;
    }

    const reactionActorId = `${reaction.id}\0${accountLogin}`;
    if (seenReactionIds.has(reactionActorId)) {
      continue;
    }
    seenReactionIds.add(reactionActorId);
    getParticipation(agentId).requestSources.add('eyes-reaction');
  }

  return [...participation.entries()]
    .map(([agentId, entry]) => ({
      agentId,
      requestSources: [...entry.requestSources],
      responseCount: entry.responseCount,
      state: entry.responseCount > 0 ? ('responded' as const) : ('requested' as const),
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}
