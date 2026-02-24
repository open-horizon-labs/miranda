// Agent/session status
export type AgentStatus = 'starting' | 'working' | 'thinking' | 'asking' | 'error' | 'blocked' | 'done';

// Issue phase in the build pipeline
export type Phase = 'queued' | 'building' | 'review' | 'done';

// Issue marker visual state
export type MarkerState = 'hollow-dim' | 'hollow-warm' | 'filled-pulsing' | 'filled-frozen' | 'filled-accent' | 'rotating' | 'check-fading';

// Mapped from Miranda's Session
export interface AgentInfo {
	sessionId: string;
	taskId: string;
	skill: string;
	status: AgentStatus;
	startedAt: string;
	elapsed: string;
	pendingQuestion: {
		messageId: number;
		questions: string[];
		receivedAt: string;
	} | null;
}

// Mapped from Miranda's issue endpoint
export interface IssueInfo {
	number: number;
	title: string;
	state: string;
	labels: string[];
	dependsOn: number[];
	blockedBy: number[];
	pr: {
		number: number;
		state: string;
		mergeable: boolean | null;
		url: string;
	} | null;
}

// CI check info
export interface CICheck {
	name: string;
	status: string;
	conclusion: string | null;
}

// PR enrichment data
export interface PREnrichment {
	ci: { state: string; checks: CICheck[] };
	coderabbit: { reviewed: boolean; state: string | null };
}

// A project with its issues organized by phase
export interface AppRegionData {
	name: string;
	repoUrl: string;
	phases: Record<Phase, IssueInfo[]>;
	agents: Map<number, AgentInfo>; // issue number -> agent
	enrichment: Record<number, PREnrichment>; // pr number -> enrichment
}

// Attention item (needs human action)
export interface AttentionItem {
	id: string;
	project: string;
	issueNumber: number;
	title: string;
	reason: 'asking' | 'ci-failed' | 'conflicts' | 'review-needed';
	agent?: AgentInfo;
	prUrl?: string;
	urgency: number; // 0-1, higher = more urgent
}

// Portfolio-level summary
export interface PortfolioState {
	apps: AppRegionData[];
	attention: AttentionItem[];
	activeAgents: number;
	totalCapacity: number;
	lastUpdated: Date;
}
