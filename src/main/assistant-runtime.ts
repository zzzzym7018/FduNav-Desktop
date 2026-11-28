import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {defaultAssistantSettings, validateAssistantSettings, validateMonitor, type AssistantState, type AssistantRun, type Monitor} from '../shared/assistant'
import {AssistantStore, assistantDay, type MailCheckpoint} from './assistant-store'
import {buildAssistantContext, parseAssistantDecision, type AssistantSource} from './assistant-context'
import type {ChatMessage} from './llm-connection'

export interface AssistantDependencies {
    owner(): string | null
    ready(): boolean
    revision(owner: string): number
    accounts(owner: string): Promise<{id: string; signature: string}[]>
    poll(owner: string, id: string, previous: MailCheckpoint | undefined, signal: AbortSignal): Promise<{checkpoint: {validity: string; uid: number}; refs: string[]; baseline: boolean; hasMore?: boolean}>
    sources(owner: string, monitor: Monitor, refs: string[], signal: AbortSignal): Promise<{items: AssistantSource[]; gaps: string[]}>
    evaluate(messages: ChatMessage[], signal: AbortSignal): Promise<string>
    notify(run: AssistantRun): void
    now?(): number
}
/** Typed wake bus; durable events live in AssistantStore, never only in EventEmitter. */
export class AssistantWakeBus {
    private events = new EventEmitter()
    subscribe(listener: () => void) {this.events.on('wake', listener); return () => this.events.off('wake', listener)}
    publish() {this.events.emit('wake')}
}
export class AssistantRuntime {
    readonly bus = new AssistantWakeBus()
    private generation = 0
    private controller: AbortController | null = null
    private ticking = false
    private stopped = false
    private observed = ''
    private timer?: ReturnType<typeof setInterval>
    private watch?: ReturnType<typeof setInterval>
    private afterStop?: () => void
    private changedListeners = new Set<() => void>()
    private now() {return this.deps.now?.() ?? Date.now()}
    constructor(readonly store: AssistantStore, private deps: AssistantDependencies) {this.bus.subscribe(() => {void this.tick()})}
    onChanged(callback: () => void) {this.changedListeners.add(callback); return () => {this.changedListeners.delete(callback)}}
    private changed() {for (const listener of this.changedListeners) {try {listener()} catch { /* Observer failure cannot fail a committed run. */ }}}
    start() {
        if (this.timer) return
        this.stopped = false
        this.observed = this.identity()
        this.timer = setInterval(() => this.bus.publish(), 30_000)
        this.watch = setInterval(() => {
            const identity = this.identity()
            if (identity !== this.observed) {
                const oldOwner = this.observed.split('|')[0]
                this.invalidate(); if (oldOwner && oldOwner !== this.deps.owner()) this.store.cancel(oldOwner)
                this.observed = identity; this.changed(); this.bus.publish()
            }
        }, 250)
        this.bus.publish()
    }
    stop(after?: () => void) {this.stopped = true; clearInterval(this.timer); clearInterval(this.watch); this.timer = undefined; this.watch = undefined; this.invalidate(); if (this.ticking) this.afterStop = after; else after?.()}
    private identity() {const owner = this.deps.owner(); return `${owner ?? ''}|${owner ? this.deps.revision(owner) : ''}|${this.deps.ready()}`}
    private invalidate() {this.generation++; this.controller?.abort(); this.controller = null}
    private owner() {const owner = this.deps.owner(); if (!owner) throw new Error('请先登录校园账号。'); return owner}
    async state(): Promise<AssistantState> {
        const username = this.deps.owner()
        let mailAccounts = 0
        if (username) try {mailAccounts = (await this.deps.accounts(username)).length} catch { /* Configuration stays accessible if keychain/mail is unavailable. */ }
        if (username !== this.deps.owner()) return this.state()
        const doc = username ? this.store.get(username) : null
        return {username, settings: doc?.settings ?? defaultAssistantSettings(), monitors: doc?.monitors ?? [], runs: username ? this.store.runs(username).slice(0, 200) : [],
            running: !!this.controller, usedToday: doc?.usage.day === assistantDay(this.now()) ? doc.usage.count : 0, llmReady: this.deps.ready(), mailAccounts}
    }
    configure(raw: unknown) {
        const settings = validateAssistantSettings(raw), owner = this.owner(), doc = this.store.get(owner)
        if (!settings.enabled) {this.invalidate(); this.store.cancel(owner)}
        if (settings.enabled !== doc.settings.enabled) {doc.cursors = {}; for (const monitor of doc.monitors) monitor.nextAt = this.now()}
        doc.settings = settings; this.store.save(owner, doc); this.changed(); this.bus.publish()
    }
    saveMonitor(raw: unknown) {
        const input = validateMonitor(raw), owner = this.owner(), doc = this.store.get(owner)
        const existing = input.id ? doc.monitors.find(monitor => monitor.id === input.id) : undefined
        if (input.id && !existing) throw new Error('监控已删除，请刷新。')
        if (!existing && doc.monitors.length >= 12) throw new Error('最多保留 12 个监控。')
        // All mail monitors receive the same cursor stream only if they are independent consumers.
        const id = existing?.id ?? randomUUID()
        this.invalidate(); this.store.cancel(owner, id)
        for (const key of Object.keys(doc.cursors)) if (key.startsWith(id + ':')) delete doc.cursors[key]
        const next: Monitor = {...input, id, nextAt: this.now(), note: '', failures: 0}
        doc.monitors = [...doc.monitors.filter(monitor => monitor.id !== id), next]
        this.store.save(owner, doc); this.changed(); this.bus.publish()
    }
    removeMonitor(id: unknown) {
        const owner = this.owner(), doc = this.store.get(owner)
        if (typeof id !== 'string' || !doc.monitors.some(monitor => monitor.id === id)) throw new Error('监控不存在。')
        this.invalidate(); this.store.cancel(owner, id)
        doc.monitors = doc.monitors.filter(monitor => monitor.id !== id)
        for (const key of Object.keys(doc.cursors)) if (key.startsWith(id + ':')) delete doc.cursors[key]
        this.store.save(owner, doc); this.changed()
    }
    check(id: unknown) {
        const owner = this.owner(), doc = this.store.get(owner), monitor = doc.monitors.find(m => m.id === id)
        if (!doc.settings.enabled || !monitor?.enabled) throw new Error('请先开启主动助手和这项监控。')
        if (!this.deps.ready()) throw new Error('请先配置并开启 LLM。')
        if (this.store.runs(owner).some(run => run.monitorId === id && ['queued', 'running'].includes(run.status))) throw new Error('这项检查已在队列中。')
        monitor.nextAt = this.now()
        if (monitor.source === 'schedule') this.store.enqueue(owner, monitor, [], '手动检查个人安排', this.now())
        this.store.save(owner, doc); this.changed(); this.bus.publish()
    }
    retry(id: unknown) {
        const owner = this.owner(), doc = this.store.get(owner), run = this.store.runs(owner).find(run => run.id === id)
        const monitor = doc.monitors.find(m => m.id === run?.monitorId && m.enabled)
        if (!doc.settings.enabled || !this.deps.ready() || !monitor || !run || !['failed', 'cancelled'].includes(run.status)) throw new Error('请先开启助手和原监控，再重试已结束的检查。')
        if (monitor.source === 'mail' && !run.refs.length) {this.check(monitor.id); return}
        if (!this.store.enqueue(owner, monitor, run.refs, '手动重试：' + run.trigger, this.now())) throw new Error('这项监控已有检查等待处理。')
        this.changed(); this.bus.publish()
    }
    cancel() {const owner = this.owner(); this.invalidate(); this.store.cancel(owner); this.changed()}
    markRead(id: unknown) {
        const owner = this.owner(), run = this.store.runs(owner).find(run => run.id === id)
        if (!run) throw new Error('记录不存在。')
        run.read = true; this.store.putRun(owner, run); this.changed()
    }
    clearHistory() {this.store.clear(this.owner()); this.changed()}
    async tick(): Promise<void> {
        if (this.ticking || this.stopped) return
        const owner = this.deps.owner()
        if (!owner || !this.store.get(owner).settings.enabled || !this.deps.ready()) return
        this.ticking = true
        const generation = this.generation, identity = this.identity(), controller = new AbortController()
        this.controller = controller
        const deadline = AbortSignal.timeout(90_000), signal = AbortSignal.any([controller.signal, deadline])
        const valid = () => !signal.aborted && !this.stopped && this.generation === generation && this.identity() === identity && this.deps.owner() === owner && this.store.get(owner).settings.enabled
        const assert = () => {if (!valid()) throw new Error('stale_run')}
        // Also race adapters that ignore cancellation, so one stuck adapter cannot block the worker forever.
        const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
            const abort = () => reject(new Error('cancelled_or_timeout'))
            signal.addEventListener('abort', abort, {once: true})
            work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
            if (signal.aborted) abort()
        })
        let active: AssistantRun | undefined
        try {
            const current = this.store.get(owner)
            for (const initial of current.monitors.filter(m => m.enabled && m.nextAt <= this.now())) {
                assert()
                if (this.store.runs(owner).some(run => run.monitorId === initial.id && ['queued', 'running'].includes(run.status))) continue
                try {
                if (initial.source === 'schedule') {
                    this.store.transaction(() => {
                        const doc = this.store.get(owner), monitor = doc.monitors.find(m => m.id === initial.id)!
                        this.store.enqueue(owner, monitor, [], '定时检查个人安排', this.now())
                        monitor.nextAt = this.now() + monitor.intervalMinutes * 60000; this.store.save(owner, doc)
                    })
                } else {
                    const accounts = await bounded(this.deps.accounts(owner)); assert()
                    if (!accounts.length) throw new Error('mail_not_authorized')
                    let backlog = false
                    for (const account of accounts.slice(0, 20)) {
                        const key = initial.id + ':' + account.id, previous = this.store.get(owner).cursors[key]
                        const result = await bounded(this.deps.poll(owner, account.id, previous?.signature === account.signature ? previous : undefined, signal)); assert()
                        this.store.transaction(() => {
                            const doc = this.store.get(owner), monitor = doc.monitors.find(m => m.id === initial.id)!
                            if (result.refs.length) {
                                if (!this.store.enqueue(owner, monitor, result.refs, '发现新邮件', this.now())) return
                                backlog = true
                            }
                            doc.cursors[key] = {...result.checkpoint, signature: account.signature}
                            this.store.save(owner, doc)
                        })
                        // Preserve later account cursors until the existing batch is consumed.
                        if (result.hasMore) backlog = true
                        if (backlog) break
                    }
                    const doc = this.store.get(owner), monitor = doc.monitors.find(m => m.id === initial.id)!
                    monitor.nextAt = this.now() + (backlog ? 30000 : monitor.intervalMinutes * 60000)
                    monitor.failures = 0; this.store.save(owner, doc)
                }
                } catch (error) {
                    assert()
                    const doc = this.store.get(owner), monitor = doc.monitors.find(m => m.id === initial.id)!
                    monitor.failures++; monitor.nextAt = this.now() + Math.min(60, 2 ** Math.min(monitor.failures, 6)) * 60000
                    this.store.putRun(owner, {id: randomUUID(), monitorId: monitor.id, monitorName: monitor.name, trigger: '检查来源', createdAt: this.now(), status: 'failed', attempts: 0, refs: [], retryAt: 0, read: false,
                        error: error instanceof Error && error.message === 'mail_not_authorized' ? '没有允许助手读取的邮箱，请在邮箱设置中授权。' : '读取监控来源失败，将退避后重试。'})
                    this.store.save(owner, doc)
                }
            }
            assert()
            const doc = this.store.get(owner), day = assistantDay(this.now())
            if (doc.usage.day !== day) doc.usage = {day, count: 0}
            this.store.save(owner, doc)
            if (doc.usage.count >= doc.settings.dailyLimit) return
            active = this.store.runs(owner).filter(run => run.status === 'queued' && run.retryAt <= this.now()).sort((a, b) => a.createdAt - b.createdAt)[0]
            if (!active) return
            const monitor = doc.monitors.find(m => m.id === active!.monitorId && m.enabled)
            if (!monitor) {active.status = 'cancelled'; this.store.putRun(owner, active); return}
            active.status = 'running'; active.attempts++; this.store.putRun(owner, active); this.changed()
            const sources = await bounded(this.deps.sources(owner, monitor, active.refs, signal)); assert()
            const context = buildAssistantContext(monitor, active.trigger, sources.items, sources.gaps, this.now())
            active.context = context.manifest; this.store.putRun(owner, active)
            const latest = this.store.get(owner)
            latest.usage.count++; this.store.save(owner, latest) // Charge before requesting, including failed requests.
            const raw = await bounded(this.deps.evaluate(context.messages, signal)); assert()
            const decision = parseAssistantDecision(raw, context.manifest.sources.map(source => source.ref), context.manifest.gaps.length > 0 || context.manifest.sources.some(source => source.truncated))
            const duplicate = decision.attention ? this.store.runs(owner).find(run => run.status === 'attention' && run.monitorId === monitor.id && run.createdAt > this.now() - 86400000 &&
                run.decision?.title === decision.title && run.decision?.nextStep === decision.nextStep &&
                JSON.stringify(run.context?.sources.filter(source => run.decision?.evidence.includes(source.ref)).map(source => source.id).sort()) ===
                JSON.stringify(context.manifest.sources.filter(source => decision.evidence.includes(source.ref)).map(source => source.id).sort())) : undefined
            if (duplicate) {active.repeatOf = duplicate.id; active.read = true}
            active.decision = decision; active.status = decision.attention ? 'attention' : 'quiet'; active.error = undefined; active.finishedAt = this.now()
            this.store.transaction(() => {
                this.store.putRun(owner, active!)
                const saved = this.store.get(owner), target = saved.monitors.find(m => m.id === monitor.id)!
                target.note = decision.summary; this.store.save(owner, saved)
            })
            if (decision.attention && !duplicate && this.store.get(owner).settings.systemNotifications) {try {this.deps.notify(active)} catch { /* In-app activity remains the source of truth. */ }}
        } catch (error) {
            const cancelled = !valid() && !deadline.aborted
            const canResume = cancelled && !this.stopped && this.deps.owner() === owner && this.store.get(owner).settings.enabled
            if (active) {
                // Disabling/removing/account changes may already have cancelled this durable job.
                const saved = this.store.runs(owner).find(run => run.id === active!.id)
                if (saved?.status === 'running') {
                    active.error = cancelled ? '检查已取消。' : error instanceof Error && error.message === 'invalid_decision' ? '模型未返回有效的判断，请重试。' : error instanceof Error && error.message === 'incomplete_evidence' ? '资料不完整，无法确认是否无需处理。请查看来源或重试。' : '检查未完成，可能是连接失败或超时。稍后会有限重试。'
                    active.status = cancelled ? canResume && this.store.get(owner).monitors.some(m => m.id === active!.monitorId && m.enabled) ? 'queued' : 'cancelled' : active.attempts < 3 && !(error instanceof Error && error.message === 'incomplete_evidence') ? 'queued' : 'failed'
                    if (canResume) {active.attempts = Math.max(0, active.attempts - 1); active.error = '配置发生变化，本次检查将在新配置下重新开始。'}
                    active.retryAt = this.now() + Math.max(1, active.attempts) * 60000; active.finishedAt = this.now(); this.store.putRun(owner, active)
                }
            } else if (!cancelled) {
                const doc = this.store.get(owner), monitor = doc.monitors.find(m => m.enabled && m.nextAt <= this.now())
                if (monitor) {
                    monitor.failures++; monitor.nextAt = this.now() + Math.min(60, 2 ** Math.min(monitor.failures, 6)) * 60000
                    this.store.putRun(owner, {id: randomUUID(), monitorId: monitor.id, monitorName: monitor.name, trigger: '检查来源', createdAt: this.now(), status: 'failed', attempts: 0, refs: [], retryAt: 0, read: false,
                        error: error instanceof Error && error.message === 'mail_not_authorized' ? '没有允许助手读取的邮箱，请在邮箱设置中授权。' : '读取监控来源失败，将退避后重试。'})
                    this.store.save(owner, doc)
                }
            }
        } finally {
            if (this.controller === controller) this.controller = null
            this.ticking = false; this.store.prune(owner, this.now()); this.changed(); this.afterStop?.(); this.afterStop = undefined
        }
    }
}
