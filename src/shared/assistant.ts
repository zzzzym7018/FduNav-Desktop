import type {Result} from './accounts'

export type MonitorInput = {
    id?: string; name: string; source: 'mail' | 'schedule'; instruction: string;
    intervalMinutes: number; enabled: boolean; includeMemory: boolean
}
export type Monitor = MonitorInput & {id: string; nextAt: number; note: string; failures: number}
export type AssistantSettings = {enabled: boolean; systemNotifications: boolean; dailyLimit: number}
export type AssistantDecision = {attention: boolean; title: string; summary: string; nextStep: string; evidence: string[]}
export type AssistantRun = {
    id: string; monitorId: string; monitorName: string; trigger: string; createdAt: number; finishedAt?: number;
    status: 'queued' | 'running' | 'quiet' | 'attention' | 'failed' | 'cancelled'; attempts: number;
    retryAt: number; refs: string[]; model?: string; decision?: AssistantDecision; error?: string; read: boolean; repeatOf?: string;
    context?: {version: 1; hash: string; chars: number; sources: {ref: string; id: string; label: string; hash: string; truncated: boolean}[]; gaps: string[]; timezone: string}
}
export type AssistantState = {
    username: string | null; settings: AssistantSettings; monitors: Monitor[]; runs: AssistantRun[];
    running: boolean; usedToday: number; llmReady: boolean; mailAccounts: number
}
export interface AssistantAPI {
    get(): Promise<Result<AssistantState>>
    configure(input: AssistantSettings): Promise<Result<AssistantState>>
    saveMonitor(input: MonitorInput): Promise<Result<AssistantState>>
    removeMonitor(id: string): Promise<Result<AssistantState>>
    check(id: string): Promise<Result<AssistantState>>
    retry(id: string): Promise<Result<AssistantState>>
    cancel(): Promise<Result<AssistantState>>
    markRead(id: string): Promise<Result<AssistantState>>
    clearHistory(): Promise<Result<AssistantState>>
    onChanged(callback: () => void): () => void
    onOpen(callback: () => void): () => void
}
export const defaultAssistantSettings = (): AssistantSettings => ({enabled: false, systemNotifications: false, dailyLimit: 24})
export function validateAssistantSettings(raw: unknown): AssistantSettings {
    if (!raw || typeof raw !== 'object') throw new Error('助手设置无效。')
    const v = raw as AssistantSettings
    if (typeof v.enabled !== 'boolean' || typeof v.systemNotifications !== 'boolean' || !Number.isInteger(v.dailyLimit) || v.dailyLimit < 1 || v.dailyLimit > 100) throw new Error('每日检查上限须为 1–100 次。')
    return {enabled: v.enabled, systemNotifications: v.systemNotifications, dailyLimit: v.dailyLimit}
}
export function validateMonitor(raw: unknown): MonitorInput {
    if (!raw || typeof raw !== 'object') throw new Error('监控格式无效。')
    const v = raw as MonitorInput
    if ((v.id !== undefined && !/^[a-f0-9-]{36}$/.test(v.id)) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 60 ||
        typeof v.instruction !== 'string' || !v.instruction.trim() || v.instruction.length > 1500 || !['mail', 'schedule'].includes(v.source) ||
        !Number.isInteger(v.intervalMinutes) || v.intervalMinutes < 5 || v.intervalMinutes > 10080 || typeof v.enabled !== 'boolean' || typeof v.includeMemory !== 'boolean') throw new Error('请填写名称、关注目标和 5 分钟至 7 天的检查间隔。')
    return {id: v.id, name: v.name.trim(), instruction: v.instruction.trim(), source: v.source, intervalMinutes: v.intervalMinutes, enabled: v.enabled, includeMemory: v.includeMemory}
}
