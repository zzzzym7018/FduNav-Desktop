/** Isolated native Electron regression harness. All accounts, emails and model responses are fixtures. */
import {app, BrowserWindow} from 'electron'
import {createServer} from 'node:http'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AppDatabase} from '../../src/main/database'
import {registerAssistantHandlers} from '../../src/main/assistant'
import type {AccountService} from '../../src/main/accounts'
import type {LlmSettingsService} from '../../src/main/llm-settings'
import type {MailService} from '../../src/main/mail-service'
const data = mkdtempSync(join(tmpdir(), 'fdunav-assistant-ui-'))
app.setPath('userData', data)
let stop: (() => void) | undefined
app.whenReady().then(async () => {
    const server = createServer((request, response) => {
        let body = ''; request.on('data', chunk => {body += chunk})
        request.on('end', () => {
            const value = JSON.parse(body)
            if (value.tools || value.max_tokens !== 1200) throw new Error('unsafe request')
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({choices: [{message: {content: JSON.stringify({attention: true, title: '明日有一项材料需要提交', summary: '测试数据中的材料提交截止在明天下午，请先核对要求。', nextStep: '打开原安排，确认材料清单。', evidence: ['S1']})}}]}))
        })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const address = server.address() as {port: number}
    const db = new AppDatabase(join(data, 'fdunav.sqlite'))
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA')
    db.saveTodo('qa-student', {id: 'qa-task', title: '提交奖学金材料（测试数据）', notes: '请核对成绩单与报名表。', dueDate: tomorrow, dueTime: '16:00', completed: false, reminderMinutes: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()})
    const accounts = {getState: () => ({status: 'signed-in', username: 'qa-student'})} as unknown as AccountService
    const llm = {get: () => ({enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture'}), getRequestSignal: () => new AbortController().signal,
        getConnection: async () => ({baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKey: ''})} as unknown as LlmSettingsService
    const mail = {revision: () => 0, monitorAccounts: async () => []} as unknown as MailService
    const window = new BrowserWindow({width: 1060, height: 900, show: true, webPreferences: {preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true}})
    stop = registerAssistantHandlers(join(data, 'assistant.sqlite'), db, accounts, llm, mail, event => event.sender === window.webContents, () => window.show())
    await window.loadFile(join(__dirname, '../renderer/index.html'))
    console.log('隔离界面已启动：测试账号、本地模拟模型服务；未接入真实邮箱。')
    app.on('before-quit', () => {stop?.(); server.close(); db.close()})
})
