import type {AssistantAPI} from '../../shared/assistant'
import type {PluginManagerAPI, PluginServices, WindowControlsAPI} from '../../shared/plugins'

declare global {
    interface Window extends Partial<PluginServices> {
        assistant?: AssistantAPI
        fdunavServices?: PluginServices
        plugins?: PluginManagerAPI
        windowControls?: WindowControlsAPI
    }
}
