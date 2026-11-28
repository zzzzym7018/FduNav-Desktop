import {DatabaseSync} from 'node:sqlite'
import {randomUUID} from 'node:crypto'
import {defaultAssistantSettings, type AssistantRun, type AssistantSettings, type Monitor} from '../shared/assistant'

export type MailCheckpoint = {validity: string; uid: number; signature: string}
export type AssistantDocument = {settings: AssistantSettings; monitors: Monitor[]; cursors: Record<string, MailCheckpoint>; usage: {day: string; count: number}}
export const assistantDay = (now: number) => new Date(now).toLocaleDateString('en-CA', {timeZone: 'Asia/Shanghai'})
export class AssistantStore {
    private db: DatabaseSync
    constructor(path: string) {
        this.db = new DatabaseSync(path)
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS assistant_state(owner TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assistant_runs(owner TEXT NOT NULL, id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS assistant_runs_owner ON assistant_runs(owner,created);`)
        // A crash is never represented as a completed decision. At most three attempts per durable event.
        for (const row of this.db.prepare('SELECT owner,data FROM assistant_runs').all()) {
            const run = JSON.parse(String(row.data)) as AssistantRun
            if (run.status === 'running') {
                run.status = run.attempts < 3 ? 'queued' : 'failed'
                run.error = '上次检查被应用退出中断。'; run.retryAt = Date.now() + 30_000
                this.putRun(String(row.owner), run)
            }
        }
    }
    close() { this.db.close() }
    get(owner: string): AssistantDocument {
        const row = this.db.prepare('SELECT data FROM assistant_state WHERE owner=?').get(owner)
        return row ? JSON.parse(String(row.data)) : {settings: defaultAssistantSettings(), monitors: [], cursors: {}, usage: {day: '', count: 0}}
    }
    save(owner: string, doc: AssistantDocument) {
        this.db.prepare('INSERT INTO assistant_state VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').run(owner, JSON.stringify(doc))
    }
    runs(owner: string): AssistantRun[] {
        return this.db.prepare('SELECT data FROM assistant_runs WHERE owner=? ORDER BY created DESC,id DESC').all(owner).map(row => JSON.parse(String(row.data)))
    }
    putRun(owner: string, run: AssistantRun) {
        this.db.prepare('INSERT INTO assistant_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(owner, run.id, run.createdAt, JSON.stringify(run))
    }
    transaction<T>(work: () => T): T {
        this.db.exec('BEGIN IMMEDIATE')
        try {const result = work(); this.db.exec('COMMIT'); return result}
        catch (error) {this.db.exec('ROLLBACK'); throw error}
    }
    enqueue(owner: string, monitor: Monitor, refs: string[], trigger: string, now: number): boolean {
        if (this.runs(owner).some(run => run.monitorId === monitor.id && ['queued', 'running'].includes(run.status))) return false
        this.putRun(owner, {id: randomUUID(), monitorId: monitor.id, monitorName: monitor.name, trigger, createdAt: now, status: 'queued', refs, attempts: 0, retryAt: now, read: false})
        return true
    }
    cancel(owner: string, monitorId?: string) {
        for (const run of this.runs(owner)) if (['queued', 'running'].includes(run.status) && (!monitorId || run.monitorId === monitorId)) {
            run.status = 'cancelled'; run.finishedAt = Date.now(); run.error = '检查已停止。'; this.putRun(owner, run)
        }
    }
    prune(owner: string, now: number) {
        let retained = 0
        for (const run of this.runs(owner)) if (!['queued', 'running'].includes(run.status) && (++retained > 200 || run.createdAt < now - 30 * 86400000)) this.db.prepare('DELETE FROM assistant_runs WHERE owner=? AND id=?').run(owner, run.id)
    }
    clear(owner: string) {
        for (const run of this.runs(owner)) if (!['queued', 'running'].includes(run.status)) this.db.prepare('DELETE FROM assistant_runs WHERE owner=? AND id=?').run(owner, run.id)
    }
}
