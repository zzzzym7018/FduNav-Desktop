import {BrowserWindow, ipcMain, Notification, powerMonitor, type IpcMainInvokeEvent} from 'electron'
import {createHash} from 'node:crypto'
import type {AppDatabase} from './database'
import type {AccountService} from './accounts'
import type {LlmSettingsService} from './llm-settings'
import type {MailService} from './mail-service'
import {AssistantRuntime} from './assistant-runtime'
import {AssistantStore} from './assistant-store'
import {completeLlm} from './llm-connection'
import type {AssistantSource} from './assistant-context'
import {selectMemories} from '../shared/memory'
import type {Result} from '../shared/accounts'
import type {AssistantState} from '../shared/assistant'

export function registerAssistantHandlers(path: string, db: AppDatabase, accounts: AccountService, llm: LlmSettingsService, mail: MailService,
    trusted: (event: IpcMainInvokeEvent) => boolean, showWindow: () => void) {
    const owner = () => {const state = accounts.getState(); return state.status === 'signed-in' ? state.username : null}
    let notification: Notification | undefined
    const runtime = new AssistantRuntime(new AssistantStore(path), {
        owner, ready: () => {const settings = llm.get(); return settings.enabled && !!settings.baseUrl && !!settings.model},
        revision: username => mail.revision(username),
        accounts: async username => (await mail.monitorAccounts(username)).map(value => ({...value, signature: createHash('sha256').update(value.signature).digest('hex')})),
        poll: (username, id, cursor, signal) => mail.pollInbox(username, id, cursor, signal),
        sources: async (username, monitor, refs, signal) => {
            const items: AssistantSource[] = [], gaps: string[] = []
            if (monitor.source === 'mail') {
                for (const id of refs.slice(0, 10)) {
                    signal.throwIfAborted()
                    try {
                        const value = await mail.read(username, {id, limit: 1800}, signal)
                        items.push({id, label: value.subject, text: JSON.stringify({subject: value.subject, from: value.from, receivedAt: value.receivedAt, body: value.body}), truncated: value.hasMore || value.bodyTruncated})
                    } catch {signal.throwIfAborted(); gaps.push('有新邮件未能读取，不能确认是否需要处理。')}
                }
                if (!items.length) throw new Error('mail_read_failed')
            } else {
                const today = new Date().toLocaleDateString('en-CA'), end = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-CA')
                const events = db.getCalendarEvents(username).filter(event => event.endDate >= today && event.startDate <= end).sort((a, b) => a.startDate.localeCompare(b.startDate))
                const todos = db.getTodos(username).filter(todo => !todo.completed).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
                for (const event of events.slice(0, 20)) items.push({id: `calendar:${event.id}`, label: event.title, text: JSON.stringify({title: event.title, startDate: event.startDate, endDate: event.endDate, startTime: event.startTime, endTime: event.endTime, allDay: event.allDay, location: event.location, notes: event.notes})})
                for (const todo of todos.slice(0, 20)) items.push({id: `todo:${todo.id}`, label: todo.title, text: JSON.stringify({title: todo.title, dueDate: todo.dueDate, dueTime: todo.dueTime, notes: todo.notes})})
                if (events.length > 20 || todos.length > 20) gaps.push('日程或待办较多，本次仅包含最早的各 20 项。')
                if (!items.length) items.push({id: 'local:empty', label: '个人安排', text: '未来七天没有本地日历事件，也没有未完成的本地待办。未联网同步其他系统。'})
            }
            if (monitor.includeMemory && db.getMemoryEnabled(username)) {
                const memories = selectMemories(db.getMemories(username), monitor.instruction, Date.now()).slice(0, 6)
                for (const item of memories) items.push({id: `memory:${item.id}`, label: '个人记忆', text: item.text})
            }
            return {items, gaps}
        },
        evaluate: async (messages, signal) => {
            const settingsSignal = llm.getRequestSignal(), connection = await llm.getConnection()
            try {return await completeLlm(connection, messages, AbortSignal.any([signal, settingsSignal]), fetch, 1200)}
            finally {connection.apiKey = ''}
        },
        notify: () => {
            if (!Notification.isSupported()) return
            notification?.close()
            notification = new Notification({title: 'FduNav 主动助手', body: '发现需要你关注的变化，打开查看判断依据。'})
            notification.on('click', () => {
                showWindow()
                for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('assistant:open')
            })
            notification.show()
        }
    })
    const broadcast = () => {for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('assistant:changed')}
    runtime.onChanged(broadcast)
    function handle(channel: string, action: (input: unknown) => void) {
        ipcMain.handle(channel, async (event, input): Promise<Result<AssistantState>> => {
            if (!trusted(event)) return {ok: false, error: '请求来源无效。'}
            try {action(input); return {ok: true, data: await runtime.state()}}
            catch (error) {return {ok: false, error: error instanceof Error ? error.message : '主动助手操作失败，请重试。'}}
        })
    }
    handle('assistant:get', () => {})
    handle('assistant:configure', input => runtime.configure(input))
    handle('assistant:save-monitor', input => runtime.saveMonitor(input))
    handle('assistant:remove-monitor', input => runtime.removeMonitor(input))
    handle('assistant:check', input => runtime.check(input))
    handle('assistant:retry', input => runtime.retry(input))
    handle('assistant:cancel', () => runtime.cancel())
    handle('assistant:mark-read', input => runtime.markRead(input))
    handle('assistant:clear-history', () => runtime.clearHistory())
    const resume = () => runtime.bus.publish()
    powerMonitor.on('resume', resume)
    runtime.start()
    return () => {powerMonitor.removeListener('resume', resume); runtime.stop(() => runtime.store.close()); notification?.close()}
}
