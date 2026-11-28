import {MailAccounts} from '../src/main/mail-accounts.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AssistantStore, assistantDay} from '../src/main/assistant-store.ts'
import {AssistantRuntime, type AssistantDependencies} from '../src/main/assistant-runtime.ts'
import {buildAssistantContext, parseAssistantDecision, decisionPrompt} from '../src/main/assistant-context.ts'
import {validateMonitor, validateAssistantSettings, type Monitor} from '../src/shared/assistant.ts'
import {MailClient} from '../src/main/mail-client.ts'
import {completeLlm} from '../src/main/llm-connection.ts'

const monitor = (): Monitor => ({id: 'b6f20efc-3345-4b08-90f5-ceb2212db517', name: '重要邮件', source: 'mail', instruction: '有截止时间才提醒', enabled: true, includeMemory: false, intervalMinutes: 5, nextAt: 0, note: '', failures: 0})
const decision = (attention = true) => JSON.stringify({attention, title: '材料提交提醒', summary: '明日截止，请核查。', nextStep: '打开原邮件确认。', evidence: ['S1']})
function fixture(overrides: Partial<AssistantDependencies> = {}) {
    const store = new AssistantStore(':memory:')
    let time = Date.parse('2026-11-27T08:00:00Z'), user: string | null = 'alice', calls = 0
    const deps: AssistantDependencies = {owner: () => user, ready: () => true, revision: () => 0, accounts: async () => [{id: 'mail1', signature: 's1'}],
        poll: async (_owner, _id, previous) => ({checkpoint: {validity: '1', uid: previous ? previous.uid + 1 : 10}, refs: previous ? [`mail:${previous.uid + 1}`] : [], baseline: !previous}),
        sources: async () => ({items: [{id: 'mail:11', label: '提交', text: '明日截止'}], gaps: []}), evaluate: async () => {calls++; return decision()}, notify: () => {}, now: () => time, ...overrides}
    const doc = store.get('alice'); doc.settings.enabled = true; doc.monitors = [monitor()]; store.save('alice', doc)
    const runtime = new AssistantRuntime(store, deps)
    return {store, runtime, deps, calls: () => calls, advance: (ms = 300001) => {time += ms}, user: (value: string | null) => {user = value}, cleanup: () => {runtime.stop(); store.close()}}
}

test('settings default off, field whitelisting and validation', () => {
    const store = new AssistantStore(':memory:'); assert.equal(store.get('alice').settings.enabled, false)
    assert.throws(() => validateAssistantSettings({enabled: true, systemNotifications: true, dailyLimit: 0}))
    assert.throws(() => validateMonitor({...monitor(), intervalMinutes: 1}))
    assert.equal('apiKey' in validateMonitor({...monitor(), apiKey: 'secret'}), false); store.close()
})
test('first mailbox check establishes baseline without calling model; next message wakes once', async () => {
    const f = fixture(); await f.runtime.tick(); assert.equal(f.calls(), 0); assert.equal(f.store.runs('alice').length, 0)
    f.advance(); await f.runtime.tick(); assert.equal(f.calls(), 1); assert.equal(f.store.runs('alice')[0].status, 'attention')
    await f.runtime.tick(); assert.equal(f.calls(), 1); f.cleanup()
})
test('cursor and durable event roll back together', () => {
    const store = new AssistantStore(':memory:'), doc = store.get('alice')
    assert.throws(() => store.transaction(() => {store.enqueue('alice', monitor(), ['m1'], 'mail', f.deps.now!()); doc.cursors.x = {validity: '1', uid: 10, signature: 'x'}; store.save('alice', doc); throw new Error('crash')}))
    assert.equal(store.runs('alice').length, 0); assert.deepEqual(store.get('alice').cursors, {}); store.close()
})
test('mail backlog drains ascending pages; repeated triggers coalesce', async () => {
    const f = fixture({poll: async (_o, _i, previous) => ({checkpoint: {validity: '1', uid: (previous?.uid ?? 0) + 10}, refs: Array.from({length: 10}, (_, i) => 'm' + ((previous?.uid ?? 0) + i + 1)), baseline: false})})
    await f.runtime.tick(); assert.equal(f.store.runs('alice')[0].refs.length, 10); assert.equal(Object.values(f.store.get('alice').cursors)[0].uid, 10)
    assert.equal(f.store.enqueue('alice', monitor(), [], 'test', 2), true); assert.equal(f.store.enqueue('alice', monitor(), [], 'again', 3), false)
    await Promise.all([f.runtime.tick(), f.runtime.tick()]); assert.equal(f.calls(), 2); f.cleanup()
})
test('invalid model output retries finitely without notifying or recording success', async () => {
    let notices = 0; const f = fixture({evaluate: async () => 'broken json', notify: () => {notices++}})
    f.store.enqueue('alice', monitor(), ['m1'], 'new mail', f.deps.now!())
    await f.runtime.tick(); let run = f.store.runs('alice')[0]; assert.equal(run.status, 'queued'); assert.equal(run.attempts, 1)
    f.advance(); await f.runtime.tick(); f.advance(); await f.runtime.tick()
    run = f.store.runs('alice')[0]; assert.equal(run.status, 'failed'); assert.equal(run.attempts, 3); assert.equal(notices, 0); f.cleanup()
})
test('daily cap charges failed calls, preserves queued event and resets next day', async () => {
    const f = fixture(); const doc = f.store.get('alice'); doc.settings.dailyLimit = 1; doc.usage = {day: assistantDay(f.deps.now!()), count: 1}; f.store.save('alice', doc)
    f.store.enqueue('alice', monitor(), ['m1'], 'mail', f.deps.now!()); await f.runtime.tick(); assert.equal(f.calls(), 0); assert.equal(f.store.runs('alice')[0].status, 'queued')
    f.advance(86400000); await f.runtime.tick(); assert.equal(f.calls(), 1); f.cleanup()
})
test('turning off cancels in-flight and stale result cannot commit or notify', async () => {
    let resolve!: (value: string) => void, entered!: () => void, notifications = 0
    const ready = new Promise<void>(r => {entered = r})
    const f = fixture({evaluate: () => {entered(); return new Promise(r => {resolve = r})}, notify: () => {notifications++}})
    f.store.enqueue('alice', monitor(), ['m1'], 'mail', f.deps.now!())
    const work = f.runtime.tick(); await ready
    f.runtime.configure({enabled: false, systemNotifications: true, dailyLimit: 24}); resolve(decision()); await work
    assert.equal(f.store.runs('alice')[0].status, 'cancelled'); assert.equal(notifications, 0); f.cleanup()
})
test('account switch rejects stale result and keeps records account-scoped', async () => {
    const f = fixture({evaluate: async () => {f.user('bob'); return decision()}})
    f.store.enqueue('alice', monitor(), ['m1'], 'mail', f.deps.now!()); await f.runtime.tick()
    assert.equal(f.store.runs('alice')[0].status, 'cancelled'); assert.equal((await f.runtime.state()).username, 'bob'); assert.equal((await f.runtime.state()).runs.length, 0); f.cleanup()
})
test('empty mail source fails without advancing decision or silent quiet result', async () => {
    const f = fixture({sources: async () => {throw new Error('raw error with password')}})
    f.store.enqueue('alice', monitor(), ['m1'], 'mail', f.deps.now!()); await f.runtime.tick()
    assert.equal(f.calls(), 0); assert.equal(f.store.runs('alice')[0].status, 'queued'); assert.doesNotMatch(f.store.runs('alice')[0].error!, /password/); f.cleanup()
})
test('context has bounded source DTOs, references and truncation, no raw IDs to model', () => {
    const result = buildAssistantContext(monitor(), 'mail', Array.from({length: 60}, (_, i) => ({id: `secret-ref-${i}`, label: '课程', text: '字'.repeat(3000)})), [], Date.now())
    assert.ok(result.messages[1].content.length <= 28000); assert.ok(result.manifest.sources.every(source => source.truncated)); assert.doesNotMatch(result.messages[1].content, /secret-ref/)
    assert.ok(result.manifest.gaps.length); assert.match(decisionPrompt, /不可信/)
    assert.throws(() => parseAssistantDecision(decision(), [])); assert.throws(() => parseAssistantDecision(decision(false), ['S1'], true))
    const parsed = parseAssistantDecision(JSON.stringify({...JSON.parse(decision()), password: 'secret'}), ['S1']); assert.equal('password' in parsed, false)
})
test('restart restores queued event, flags interrupted worker and retains cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdunav-assistant-')); const path = join(dir, 'test.sqlite')
    let store = new AssistantStore(path); const doc = store.get('alice'); doc.cursors.x = {validity: '5', uid: 30, signature: 's'}; store.save('alice', doc)
    store.enqueue('alice', monitor(), ['m30'], 'mail', Date.now()); const run = store.runs('alice')[0]; run.status = 'running'; run.attempts = 1; store.putRun('alice', run); store.close()
    store = new AssistantStore(path); assert.equal(store.runs('alice')[0].status, 'queued'); assert.equal(store.get('alice').cursors.x.uid, 30); store.close(); rmSync(dir, {recursive: true})
})
test('clearing history preserves progress and live work', () => {
    const store = new AssistantStore(':memory:'), doc = store.get('alice'); doc.cursors.x = {validity: '1', uid: 9, signature: 's'}; store.save('alice', doc)
    store.enqueue('alice', monitor(), ['m1'], 'mail', Date.now()); store.clear('alice'); assert.equal(store.runs('alice').length, 1)
    const run = store.runs('alice')[0]; run.status = 'quiet'; store.putRun('alice', run); store.clear('alice'); assert.equal(store.runs('alice').length, 0); assert.equal(store.get('alice').cursors.x.uid, 9); store.close()
})
test('actual IMAP adapter baselines validity, handles UID gaps/backdates, enforces read-only and cancellation', async () => {
    let readOnly = false, closed = 0, search = '', validity = 1n
    const fakeClient = {options: {auth: {pass: 'secret'}}, on() {}, close() {closed++}, connect: async () => {}, mailboxOpen: async (_folder: string, options: {readOnly: boolean}) => {readOnly = options.readOnly; return {uidValidity: validity, uidNext: 50}},
        search: async (query: {uid: string}) => {search = query.uid; return [9, 40, 12, 15, 49, 50]}}
    const accounts = {owner: () => 'alice', withAccount: async (_o: string, _id: string, agent: boolean, work: Function, signal: AbortSignal) => {assert.equal(agent, true); return work({id: '1234567890123456'}, signal)}}
    const client = new MailClient(accounts as never, {} as never, () => fakeClient as never)
    const signal = new AbortController().signal
    assert.equal((await client.pollInbox('alice', '1234567890123456', undefined, signal)).checkpoint.uid, 49)
    const page = await client.pollInbox('alice', '1234567890123456', {validity: '1', uid: 10}, signal)
    assert.equal(readOnly, true); assert.equal(search, '11:49'); assert.deepEqual(page.refs.map(ref => ref.split('.').at(-1)), ['12', '15', '40', '49']); assert.equal(page.checkpoint.uid, 49)
    validity = 2n; assert.equal((await client.pollInbox('alice', '1234567890123456', {validity: '1', uid: 10}, signal)).baseline, true)
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(() => client.pollInbox('alice', '1234567890123456', undefined, aborted.signal)); assert.ok(closed >= 4)
})
test('model request includes hard output budget and never offers tools', async () => {
    let body: Record<string, unknown> = {}
    const output = await completeLlm({baseUrl: 'https://example.com/v1', apiKey: 'test-secret', model: 'test'}, [{role: 'system', content: decisionPrompt}], new AbortController().signal,
        async (_url, init) => {body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({choices: [{message: {content: decision()}}]}), {status: 200})}, {maxTokens: 1200, retries: 0})
    assert.equal(body.max_tokens, 1200); assert.equal(body.tools, undefined); assert.ok(output); assert.doesNotMatch(JSON.stringify(body), /test-secret/)
})

test('changing notification settings keeps queued mail and cursor intact', () => {
    const f = fixture(); f.store.enqueue('alice', monitor(), ['m11'], 'mail', f.deps.now!())
    f.runtime.configure({enabled: true, systemNotifications: true, dailyLimit: 10})
    assert.equal(f.store.runs('alice')[0].status, 'queued'); assert.deepEqual(f.store.runs('alice')[0].refs, ['m11']); f.cleanup()
})
test('changing another monitor preserves interrupted mail for retry', async () => {
    let entered!: () => void
    const ready = new Promise<void>(r => {entered = r})
    const f = fixture({evaluate: async () => {entered(); return new Promise(() => {})}})
    f.store.enqueue('alice', monitor(), ['m11'], 'mail', f.deps.now!())
    const work = f.runtime.tick(); await ready
    f.runtime.saveMonitor({...monitor(), id: undefined, name: '其他监控', source: 'schedule'})
    await work; assert.equal(f.store.runs('alice')[0].status, 'queued'); assert.deepEqual(f.store.runs('alice')[0].refs, ['m11']); f.cleanup()
})
test('truncated evidence cannot become quiet success and does not automatically spend three calls', async () => {
    const f = fixture({sources: async () => ({items: [{id: 'm11', label: '长邮件', text: '节选', truncated: true}], gaps: []}), evaluate: async () => decision(false)})
    f.store.enqueue('alice', monitor(), ['m11'], 'mail', f.deps.now!()); await f.runtime.tick()
    const run = f.store.runs('alice')[0]; assert.equal(run.status, 'failed'); assert.equal(run.attempts, 1)
    f.runtime.retry(run.id); assert.ok(f.store.runs('alice').some(r => r.status === 'queued' && r.refs[0] === 'm11')); f.cleanup()
})
test('identical reminders are suppressed, changed source content is a new reminder', async () => {
    let text = '明日截止', notices = 0
    const f = fixture({sources: async () => ({items: [{id: 'same-todo', label: '提交', text}], gaps: []}), notify: () => {notices++}})
    const doc = f.store.get('alice'); doc.settings.systemNotifications = true; doc.monitors[0].source = 'schedule'; f.store.save('alice', doc)
    await f.runtime.tick(); assert.equal(notices, 1)
    f.advance(); await f.runtime.tick(); assert.equal(notices, 1); assert.ok(f.store.runs('alice').some(run => run.repeatOf))
    text = '截止时间改为今日'; f.advance(); await f.runtime.tick(); assert.equal(notices, 2); f.cleanup()
})
test('one broken mail monitor does not block another scheduled monitor', async () => {
    const f = fixture({accounts: async () => {throw new Error('offline')}}), doc = f.store.get('alice')
    doc.monitors.push({...monitor(), id: 'a6f20efc-3345-4b08-90f5-ceb2212db517', source: 'schedule'}); f.store.save('alice', doc)
    await f.runtime.tick(); assert.ok(f.store.runs('alice').some(run => run.status === 'failed')); assert.ok(f.store.runs('alice').some(run => run.status === 'attention')); f.cleanup()
})
test('context budget remains hard with heavily escaped strings and does not persist source body', () => {
    const context = buildAssistantContext(monitor(), 'mail', Array.from({length: 60}, (_, i) => ({id: 'source' + i, label: 's', text: '\u0001'.repeat(1800)})), [], Date.now())
    assert.ok(context.messages.reduce((size, item) => size + item.content.length, 0) <= 28000)
    assert.doesNotMatch(JSON.stringify(context.manifest), /\\u0001/); assert.ok(context.manifest.sources.every(source => /^[a-f0-9]{64}$/.test(source.hash)))
})
test('model adapter does not perform hidden retries for a budgeted background check', async () => {
    let requests = 0
    await assert.rejects(() => completeLlm({baseUrl: 'https://example.com', apiKey: '', model: 'test'}, [], new AbortController().signal, async () => {requests++; return new Response('', {status: 503})}, {maxTokens: 1200, retries: 0}))
    assert.equal(requests, 1)
})

test('mail permission epoch survives restart, changes on revoke/regrant and never leaks credentials', async () => {
    let encrypted: Uint8Array | null = null
    const repository = {getMailConfiguration: () => encrypted, saveMailConfiguration: (_owner: string, value: Uint8Array) => {encrypted = value}, clearMailConfiguration: () => {encrypted = null}}
    const secrets = {available: async () => true, encrypt: async (value: string) => new TextEncoder().encode(value), decrypt: async (value: Uint8Array) => new TextDecoder().decode(value)}
    let accounts = new MailAccounts(repository, secrets, async () => {}, () => 'alice')
    const created = await accounts.save({label: '测试', address: 'test@example.com', username: 'test@example.com', host: 'imap.example.com', port: 993, security: 'tls', password: 'test-password', enabled: true, smtp: null})
    const first = (await accounts.monitorAccounts('alice'))[0]
    accounts = new MailAccounts(repository, secrets, async () => {}, () => 'alice')
    assert.equal((await accounts.monitorAccounts('alice'))[0].signature, first.signature)
    await accounts.setAgentAccess(created.id, false); assert.equal((await accounts.monitorAccounts('alice')).length, 0)
    await accounts.setAgentAccess(created.id, true); const changed = (await accounts.monitorAccounts('alice'))[0]
    assert.notEqual(changed.signature, first.signature); assert.doesNotMatch(changed.signature, /test-password/)
    assert.equal('agentEpoch' in (await accounts.list())[0], false); assert.equal('password' in (await accounts.list())[0], false)
})
test('one broken mailbox cannot starve another mailbox within the same monitor', async () => {
    const f = fixture({accounts: async () => [{id: 'broken', signature: 'a'}, {id: 'working', signature: 'b'}], poll: async (_owner, id) => {
        if (id === 'broken') throw new Error('offline')
        return {checkpoint: {validity: '1', uid: 11}, refs: ['m11'], baseline: false}
    }})
    await f.runtime.tick(); assert.ok(f.store.runs('alice').some(run => run.status === 'attention')); assert.ok(f.store.runs('alice').some(run => run.status === 'failed'))
    assert.equal(Object.keys(f.store.get('alice').cursors).length, 1); f.cleanup()
})

test('normal app shutdown returns an interrupted durable event to the queue', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => {entered = resolve})
    const f = fixture({evaluate: async () => {entered(); return new Promise(() => {})}})
    f.store.enqueue('alice', monitor(), ['m11'], 'mail', f.deps.now!())
    const work = f.runtime.tick(); await ready; f.runtime.stop(); await work
    assert.equal(f.store.runs('alice')[0].status, 'queued'); assert.deepEqual(f.store.runs('alice')[0].refs, ['m11']); f.store.close()
})
