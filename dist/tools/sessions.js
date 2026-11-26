import { randomUUID } from 'node:crypto';
const MAX_SETTLED_AGENTS = 200;
const MAX_SETTLED_PER_AGENT = 50;
export class SessionRegistry {
    sessions = new Map();
    settled = new Map();
    taskSeq = 0;
    start(session) {
        this.taskSeq += 1;
        const taskId = typeof session.taskId === 'string' && session.taskId.trim() !== ''
            ? session.taskId.trim()
            : `${session.agentId}:${this.taskSeq}:${randomUUID().slice(0, 8)}`;
        const created = {
            ...session,
            taskId,
            rounds: session.rounds ?? 0,
            history: session.history ?? [],
        };
        if (!session.agentId)
            return created;
        this.sessions.set(session.agentId, created);
        return created;
    }
    /** 记录同一任务版本的最终结算方式（有界保留，避免旧请求重复结算或覆盖）。 */
    markSettled(agentId, taskId, kind) {
        if (!agentId || !taskId)
            return;
        let agentMap = this.settled.get(agentId);
        if (!agentMap) {
            if (this.settled.size >= MAX_SETTLED_AGENTS) {
                const oldestAgent = this.settled.keys().next().value;
                if (oldestAgent !== undefined)
                    this.settled.delete(oldestAgent);
            }
            agentMap = new Map();
            this.settled.set(agentId, agentMap);
        }
        else {
            // 刷新该 agent 的活跃顺序，避免热会话被外层淘汰。
            this.settled.delete(agentId);
            this.settled.set(agentId, agentMap);
        }
        if (agentMap.has(taskId)) {
            agentMap.delete(taskId);
        }
        else if (agentMap.size >= MAX_SETTLED_PER_AGENT) {
            const oldestTask = agentMap.keys().next().value;
            if (oldestTask !== undefined)
                agentMap.delete(oldestTask);
        }
        agentMap.set(taskId, kind);
    }
    getSettled(agentId, taskId) {
        if (!agentId || !taskId)
            return undefined;
        return this.settled.get(agentId)?.get(taskId);
    }
    /** 只在实际追问得到答案后计数；相同摘要和维度的重试幂等。 */
    recordAnswer(agentId, answer, asked, maxRounds) {
        const session = this.sessions.get(agentId);
        if (!session)
            return 0;
        const history = session.history ??= [];
        const last = history.at(-1);
        if (!answer || !asked.length || (last?.answer === answer && last.asked.join() === asked.join()))
            return session.rounds ?? 0;
        if ((session.rounds ?? 0) >= maxRounds)
            return session.rounds ?? 0;
        history.push({ answer, asked: [...asked] });
        return this.bumpRound(agentId);
    }
    bumpRound(agentId) {
        const session = this.sessions.get(agentId);
        if (!session)
            return 0;
        return session.rounds = (session.rounds ?? 0) + 1;
    }
    get(agentId) { return this.sessions.get(agentId); }
    end(agentId) { this.sessions.delete(agentId); }
    clear() {
        this.sessions.clear();
        this.settled.clear();
    }
}
