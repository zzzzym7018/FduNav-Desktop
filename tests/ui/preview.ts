/** Browser-only UI fixture. Never imported by the production renderer entry. */
import {defaultAssistantSettings, type AssistantAPI, type AssistantState, type MonitorInput} from '../../src/shared/assistant'
import type {Result} from '../../src/shared/accounts'
export function previewAssistant(): AssistantAPI {
    let state: AssistantState = {username: '界面测试账号', settings: defaultAssistantSettings(), monitors: [], runs: [], running: false, usedToday: 0, llmReady: true, mailAccounts: 1}
    const listeners = new Set<() => void>()
    const result = async (): Promise<Result<AssistantState>> => ({ok: true, data: structuredClone(state)})
    const changed = () => listeners.forEach(listener => listener())
    const check = async (id: string) => {
        const monitor = state.monitors.find(m => m.id === id)
        if (!monitor || !state.settings.enabled) return {ok: false as const, error: '请先开启主动助手。'}
        state.running = true; changed()
        setTimeout(() => {
            state.running = false; state.usedToday++
            state.runs.unshift({id: crypto.randomUUID(), monitorId: id, monitorName: monitor.name, trigger: '模拟新邮件', createdAt: Date.now(), finishedAt: Date.now(), status: 'attention', attempts: 1, refs: ['fixture-mail'], retryAt: 0, read: false,
                decision: {attention: true, title: '明天下午有一项材料需要提交', summary: '模拟邮件中提到，申请材料须在明天下午 16:00 前提交。请先核对要求，再决定是否处理。', nextStep: '核对成绩单和报名表，确认自己的申请是否符合要求。', evidence: ['S1']},
                context: {version: 1, hash: 'preview', chars: 1300, timezone: 'Asia/Shanghai', gaps: [], sources: [{ref: 'S1', id: 'fixture-mail', label: '材料提交提醒（模拟邮件）', hash: 'fixture', truncated: false}]}})
            changed()
        }, 800)
        return result()
    }
    return {get: result,
        configure: async input => {state.settings = input; changed(); return result()},
        saveMonitor: async (input: MonitorInput) => {const monitor = {...input, id: input.id ?? crypto.randomUUID(), nextAt: Date.now(), note: '', failures: 0}; state.monitors = [...state.monitors.filter(m => m.id !== monitor.id), monitor]; changed(); return result()},
        removeMonitor: async id => {state.monitors = state.monitors.filter(m => m.id !== id); changed(); return result()},
        check, retry: async id => check(state.runs.find(run => run.id === id)?.monitorId ?? ''),
        cancel: async () => {state.running = false; return result()}, markRead: async id => {state.runs = state.runs.map(run => run.id === id ? {...run, read: true} : run); return result()},
        clearHistory: async () => {state.runs = []; return result()}, onChanged: callback => {listeners.add(callback); return () => {listeners.delete(callback)}}, onOpen: () => () => {}}
}
