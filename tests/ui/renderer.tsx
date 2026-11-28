import {createRoot} from 'react-dom/client'
import {previewAssistant} from './preview'
import {AssistantPanel} from '../../src/renderer/src/AssistantPanel'
import '../../src/renderer/src/styles/base.css'
import '../../src/renderer/src/styles/app.css'
const browserPreview = !window.assistant
if (browserPreview) window.assistant = previewAssistant()
function TestApp() {
    return <main style={{margin: '0 auto', padding: '24px', maxWidth: 880, background: 'var(--color-bg-surface)'}}>
        <p style={{color: 'var(--color-text-muted)', fontSize: 12}}>界面验证专用 · 模拟账号与数据 · 不连接真实邮箱</p>
        <AssistantPanel onNavigate={() => {}} onOpenMail={async () => {}}/>
    </main>
}
createRoot(document.getElementById('root')!).render(<TestApp/> )
