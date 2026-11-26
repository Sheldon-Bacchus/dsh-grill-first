import type { DimensionHit, JudgeMode } from '../judge/heuristics.js';
export interface ClarificationRound {
    answer: string;
    asked: (keyof DimensionHit)[];
}
export type SettlementKind = 'manual' | 'recommended';
/** 每个 agent 独立的待确认任务；确认修订不消耗追问轮数。 */
export interface GrillSession {
    agentId: string;
    task: string;
    mode: JudgeMode;
    startedAt: number;
    taskId?: string;
    rounds?: number;
    history?: ClarificationRound[];
    pendingRecommendations?: boolean;
    recommendationReady?: boolean;
    manualRequired?: boolean;
    gateRevision?: number;
}
export declare class SessionRegistry {
    private readonly sessions;
    private readonly settled;
    private taskSeq;
    start(session: GrillSession): GrillSession;
    /** 记录同一任务版本的最终结算方式（有界保留，避免旧请求重复结算或覆盖）。 */
    markSettled(agentId: string, taskId: string, kind: SettlementKind): void;
    getSettled(agentId: string, taskId: string): SettlementKind | undefined;
    /** 只在实际追问得到答案后计数；相同摘要和维度的重试幂等。 */
    recordAnswer(agentId: string, answer: string, asked: (keyof DimensionHit)[], maxRounds: number): number;
    bumpRound(agentId: string): number;
    get(agentId: string): GrillSession | undefined;
    end(agentId: string): void;
    clear(): void;
}
