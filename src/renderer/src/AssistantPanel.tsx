import {useEffect, useRef, useState} from 'react'
import type {AssistantState, AssistantSettings, MonitorInput, AssistantRun} from '../../shared/assistant'
import type {Result} from '../../shared/accounts'
import './styles/assistant.css'
import './styles/llm.css'

const freshMonitor = (source: 'mail' | 'schedule'): MonitorInput => ({name: source === 'mail' ? '留意重要新邮件' : '检查近期安排', source,
    instruction: source === 'mail' ? '留意需要我回复、报名、提交材料，或有明确截止时间的新邮件。普通宣传和无须行动的群发邮件保持安静。说明依据和建议的下一步。' : '检查未来七天的日程与未完成待办，提醒临近截止、时间冲突，以及需要提前准备的事项。已经完成或没有变化的事项不重复提醒。',
    intervalMinutes: source === 'mail' ? 15 : 360, enabled: true, includeMemory: false})
const statusLabel: Record<AssistantRun['status'], string> = {queued: '等待检查', running: '正在判断', quiet: '无需打扰', attention: '需要关注', failed: '检查未完成', cancelled: '已停止'}
const date = (value: number) => new Date(value).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})

export function AssistantPanel({onNavigate, onOpenMail}: {onNavigate: (tab: 'llm' | 'mail' | 'account') => void; onOpenMail: (id: string) => Promise<void>}) {
    const api = window.assistant
    const [state, setState] = useState<AssistantState | null>(null)
    const [error, setError] = useState('')
    const [feedback, setFeedback] = useState('')
    const [busy, setBusy] = useState(false)
    const [loading, setLoading] = useState(true)
    const [draft, setDraft] = useState<MonitorInput | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
    const [confirmClear, setConfirmClear] = useState(false)
    const [filter, setFilter] = useState<'attention' | 'all'>('attention')
    const lifecycle = useRef(0), sequence = useRef(0), locked = useRef(false)
    const heading = useRef<HTMLHeadingElement>(null), nameInput = useRef<HTMLInputElement>(null)
    const [dailyLimit, setDailyLimit] = useState('24')
    useEffect(() => {
        if (!api) {setLoading(false); return}
        const generation = ++lifecycle.current
        async function load() {
            const request = ++sequence.current
            try {
                const result = await api!.get()
                if (generation !== lifecycle.current || request !== sequence.current) return
                if (result.ok) {setState(result.data); setDailyLimit(String(result.data.settings.dailyLimit))}
                else setError(result.error)
            } catch {if (generation === lifecycle.current) setError('无法读取主动助手，请重试。')}
            finally {if (generation === lifecycle.current) setLoading(false)}
        }
        void load()
        const unsubscribe = api.onChanged(() => {if (!locked.current) void load()})
        return () => {lifecycle.current++; unsubscribe()}
    }, [api])
    useEffect(() => {if (draft) nameInput.current?.focus()}, [!!draft])
    async function perform(action: () => Promise<Result<AssistantState>>, success: string, after?: () => void) {
        if (locked.current) return
        locked.current = true; setBusy(true); setError(''); setFeedback('')
        const generation = lifecycle.current; sequence.current++
        try {
            const result = await action()
            if (generation !== lifecycle.current) return
            if (result.ok) {setState(result.data); setDailyLimit(String(result.data.settings.dailyLimit)); setFeedback(success); after?.()}
            else setError(result.error)
        } catch {if (generation === lifecycle.current) setError('操作未完成，请重试。你的输入已保留。')}
        finally {locked.current = false; if (generation === lifecycle.current) {setBusy(false); setLoading(false)}}
    }
    async function openMail(id: string) {
        if (locked.current) return
        locked.current = true; setBusy(true); setError('')
        const generation = lifecycle.current
        try {await onOpenMail(id)} catch {if (generation === lifecycle.current) setError('无法打开原邮件，请检查邮箱连接后重试。')}
        finally {locked.current = false; if (generation === lifecycle.current) setBusy(false)}
    }
    const configure = (patch: Partial<AssistantSettings>) => {if (api && state) void perform(() => api.configure({...state.settings, ...patch}), '设置已保存。')}
    const enabled = !!state?.settings.enabled
    const signedIn = !!state?.username
    const runs = state?.runs.filter(run => filter === 'all' || (run.status === 'attention' && !run.read)) ?? []
    const queued = state?.runs.some(run => run.status === 'queued')
    return <div className="assistant-panel" aria-busy={busy || loading}>
        <header className="assistant-intro">
            <div><p className="assistant-eyebrow">让助手持续留意</p><h2>主动助手</h2>
                <p>有值得关注的变化，再来找你。每次检查都能查看原因与依据。</p></div>
            <button type="button" className="llm-switch" role="switch" aria-label="开启主动助手" aria-checked={enabled}
                disabled={!api || !state || !signedIn || busy} onClick={() => configure({enabled: !enabled})}>
                <span className="llm-switch-track" aria-hidden="true"><span/></span></button>
        </header>
        <div className="assistant-status" role="status">
            <strong>{!signedIn ? '等待登录' : !enabled ? '当前已关闭' : state?.running ? '正在检查' : !state?.llmReady ? '等待配置 LLM' : queued && state.usedToday >= state.settings.dailyLimit ? '今日检查已达上限，明日继续' : queued ? '有检查等待处理' : '已开启，等待下一次变化'}</strong>
            <span>开启后，相关邮件正文节选或个人安排会发送给你配置的 LLM。仅在 FduNav 运行时工作；最小化到托盘后仍可检查，退出或电脑睡眠后暂停。</span>
        </div>
        {!api && <p className="account-notice">请在 FduNav 桌面应用中使用主动助手。</p>}
        {loading && <p role="status">正在读取设置…</p>}
        {error && <div className="assistant-error" role="alert">{error} <button type="button" disabled={busy || !api} onClick={() => void perform(() => api!.get(), '已刷新。')}>重新读取</button></div>}
        <p className="save-status" role="status">{busy ? '正在保存…' : feedback}</p>
        {state && <>
            {!signedIn && <p className="assistant-hint">登录后，监控与活动只属于当前校园账号。<button type="button" onClick={() => onNavigate('account')}>前往登录</button></p>}
            {signedIn && !state.llmReady && <p className="assistant-hint">需要已配置并开启的 LLM 才能判断。<button type="button" onClick={() => onNavigate('llm')}>配置 LLM</button></p>}
            <section className="assistant-section" aria-labelledby="assistant-monitors">
                <div className="assistant-section-heading"><div><h3 id="assistant-monitors" ref={heading} tabIndex={-1}>正在留意</h3><p>先定义关注目标，再决定多久检查一次。</p></div>
                    {!draft && <button className="assistant-primary" type="button" disabled={!signedIn || busy} onClick={() => setDraft(freshMonitor('mail'))}>添加监控</button>}</div>
                {state.monitors.length === 0 && !draft && <div className="assistant-empty"><strong>从一件值得留意的事开始</strong><p>比如新邮件中的截止时间，或未来几天的安排冲突。</p>
                    <div className="assistant-actions"><button type="button" disabled={!signedIn || busy} onClick={() => setDraft(freshMonitor('mail'))}>留意重要新邮件</button><button type="button" disabled={!signedIn || busy} onClick={() => setDraft(freshMonitor('schedule'))}>检查近期安排</button></div></div>}
                {draft && <form className="assistant-form" onSubmit={event => {event.preventDefault(); void perform(() => api!.saveMonitor(draft), '监控已保存。', () => {setDraft(null); heading.current?.focus()})}}>
                    <h4>{draft.id ? '编辑监控' : '添加监控'}</h4>
                    <label>监控名称<input ref={nameInput} value={draft.name} maxLength={60} required disabled={busy} onChange={event => setDraft({...draft, name: event.target.value})}/></label>
                    <label>关注资料<select value={draft.source} disabled={busy} onChange={event => setDraft({...freshMonitor(event.target.value as 'mail' | 'schedule'), id: draft.id})}>
                        <option value="mail">新邮件 · 已授权的收件箱</option><option value="schedule">个人安排 · 本地日历与待办</option></select></label>
                    <label>什么时候需要提醒你<textarea value={draft.instruction} maxLength={1500} rows={4} required disabled={busy} onChange={event => setDraft({...draft, instruction: event.target.value})}/></label>
                    <div className="assistant-form-row"><label>检查间隔（分钟）<input type="number" min={5} max={10080} required value={draft.intervalMinutes} disabled={busy} onChange={event => setDraft({...draft, intervalMinutes: Number(event.target.value)})}/></label>
                        <label className="assistant-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({...draft, enabled: event.target.checked})}/>启用这项监控</label></div>
                    <label className="assistant-check"><input type="checkbox" checked={draft.includeMemory} disabled={busy} onChange={event => setDraft({...draft, includeMemory: event.target.checked})}/>加入相关的已启用个人记忆</label>
                    <p className="assistant-hint">{draft.source === 'mail' ? '首次开启或修改监控时建立基线，只检查之后到达的新邮件。只读取已允许助手访问的邮箱，不改变已读状态。' : '读取未来七天日历与未完成待办，不会联网刷新教务系统。'}</p>
                    <div className="assistant-actions"><button type="button" disabled={busy} onClick={() => {setDraft(null); heading.current?.focus()}}>取消</button><button type="submit" className="assistant-primary" disabled={busy || !api}>保存监控</button></div>
                </form>}
                <div className="assistant-monitor-list">{state.monitors.map(monitor => <article key={monitor.id} className="assistant-monitor">
                    <div className="assistant-monitor-heading"><strong>{monitor.name}</strong><span className="assistant-tag">{monitor.enabled ? enabled ? '已启用' : '随助手暂停' : '已暂停'}</span></div>
                    <p>{monitor.instruction}</p><p className="assistant-meta">{monitor.source === 'mail' ? '新邮件' : '本地日历与待办'} · 每 {monitor.intervalMinutes} 分钟检查{monitor.includeMemory ? ' · 参考相关记忆' : ''}</p>
                    {monitor.source === 'mail' && state.mailAccounts === 0 && <p className="assistant-hint">还没有授权邮箱。<button type="button" onClick={() => onNavigate('mail')}>设置邮箱访问</button></p>}
                    {monitor.failures > 0 && <p className="assistant-hint">来源暂时不可用，将在 {date(monitor.nextAt)} 后重试。</p>}
                    <div className="assistant-actions"><button type="button" disabled={busy || !enabled || !monitor.enabled || !state.llmReady} onClick={() => void perform(() => api!.check(monitor.id), monitor.source === 'mail' ? '已请求检查新邮件；没有新邮件时不会调用模型。' : '已加入检查队列。')}>立即检查</button>
                        <button type="button" disabled={busy || !!draft} onClick={() => setDraft({...monitor})}>编辑</button>
                        <button type="button" disabled={busy} onClick={() => setConfirmDelete(monitor.id)}>删除</button></div>
                    {confirmDelete === monitor.id && <div className="assistant-confirm" role="group" aria-label="确认删除监控"><p>删除“{monitor.name}”并停止它的待处理检查？已有活动会保留。</p><div className="assistant-actions"><button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>保留监控</button><button type="button" disabled={busy} onClick={() => void perform(() => api!.removeMonitor(monitor.id), '监控已删除。', () => {setConfirmDelete(null); heading.current?.focus()})}>确认删除</button></div></div>}
                </article>)}</div>
            </section>
            <section className="assistant-section" aria-labelledby="assistant-controls"><h3 id="assistant-controls">提醒与用量</h3>
                <label className="assistant-check"><input type="checkbox" checked={state.settings.systemNotifications} disabled={!signedIn || busy} onChange={event => configure({systemNotifications: event.target.checked})}/>发现需要关注的变化时，发送系统提醒</label>
                <p className="assistant-meta">系统提醒隐藏邮件内容；所有结论都保留在下方活动中。后台不会发送邮件或修改你的安排。</p>
                <form className="assistant-budget" onSubmit={event => {event.preventDefault(); configure({dailyLimit: Number(dailyLimit)})}}><label>每日模型检查上限<input aria-label="每日模型检查上限" type="number" min={1} max={100} required value={dailyLimit} disabled={!signedIn || busy} onChange={event => setDailyLimit(event.target.value)}/></label><button type="submit" disabled={!signedIn || busy || dailyLimit === String(state.settings.dailyLimit)}>保存上限</button><span>今日已用 {state.usedToday} / {state.settings.dailyLimit} 次</span></form>
                <p className="assistant-meta">按北京时间零点重置。失败请求也计入上限；每次最多 1200 个输出 token。模型服务可能收费。</p>
            </section>
            <section className="assistant-section" aria-labelledby="assistant-activity"><div className="assistant-section-heading"><div><h3 id="assistant-activity">助手活动</h3><p>需要关注的结论会留在这里，直到你标为已读。</p></div>
                {(state.running || queued) && <button type="button" disabled={busy} onClick={() => void perform(() => api!.cancel(), '当前和等待中的检查已停止；后续监控仍按计划运行。')}>停止本轮检查</button>}</div>
                <div className="assistant-section-heading"><div className="assistant-filters" role="group" aria-label="活动筛选"><button type="button" aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>待关注 {state.runs.filter(run => run.status === 'attention' && !run.read).length}</button><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部活动</button></div>
                    <button type="button" disabled={busy || !state.runs.length} onClick={() => setConfirmClear(true)}>清空已结束记录</button></div>
                {confirmClear && <div className="assistant-confirm"><p>清空已结束的活动？监控配置和邮箱检查进度会保留。</p><div className="assistant-actions"><button type="button" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button><button type="button" disabled={busy} onClick={() => void perform(() => api!.clearHistory(), '活动记录已清空。', () => setConfirmClear(false))}>确认清空</button></div></div>}
                {!runs.length && <div className="assistant-empty"><strong>{filter === 'attention' ? '暂时没有需要关注的事' : '还没有检查记录'}</strong><p>{filter === 'attention' ? '安静是正常状态。可以切到全部活动，查看每一次检查。' : '开启监控后，检查原因、依据和结果会出现在这里。'}</p></div>}
                {runs.map(run => <article key={run.id} className={`assistant-run ${run.status === 'attention' && !run.read ? 'is-attention' : ''}`}><div className="assistant-monitor-heading"><strong>{run.decision?.title ?? run.monitorName}</strong><span className="assistant-tag">{statusLabel[run.status]}</span></div>
                    <p className="assistant-meta">{run.monitorName} · {date(run.createdAt)} · {run.trigger}</p>
                    {run.decision && <><p>{run.decision.summary}</p>{run.decision.nextStep && <p><strong>建议下一步：</strong>{run.decision.nextStep}</p>}</>}
                    {run.repeatOf && <p className="assistant-meta">与之前的提醒相同，未重复通知。</p>}
                    {run.error && <p className="assistant-hint">{run.error}{run.status === 'queued' ? ` 下次尝试：${date(run.retryAt)}（最多三次）。` : ''}</p>}
                    <details><summary>查看本次检查依据</summary><p>独立上下文 · 第 {run.attempts} 次尝试{run.context ? ` · ${run.context.chars} 字符 · ${run.context.timezone}` : ''}</p>
                        {run.context?.sources.map(source => <p key={source.ref}><strong>{source.ref}</strong> · {source.label}{source.truncated ? '（仅节选）' : ''}{run.decision?.evidence.includes(source.ref) ? ' · 本次结论引用' : ''}{source.id.startsWith('m2.') && <button type="button" disabled={busy} onClick={() => void openMail(source.id)}>打开原邮件</button>}</p>)}
                        {run.context?.gaps.map((gap, index) => <p key={index}>{gap}</p>)}
                        {!run.context && <p>尚未生成上下文；读取失败或已停止时不会生成成功结论。</p>}
                        <p className="assistant-meta">活动保存来源引用与判断，不保存邮件正文。记录最多保留 30 天、200 条。</p></details>
                    {['failed', 'cancelled'].includes(run.status) && state.monitors.some(m => m.id === run.monitorId && m.enabled) && <button type="button" disabled={busy || !enabled || !state.llmReady} onClick={() => void perform(() => api!.retry(run.id), '已重新加入检查队列。')}>重试这次检查</button>}
                    {run.status === 'attention' && !run.read && <div className="assistant-actions"><button type="button" disabled={busy} onClick={() => void perform(() => api!.markRead(run.id), '已标为已读。')}>标为已读</button></div>}
                </article>)}
            </section>
        </>}
    </div>
}
