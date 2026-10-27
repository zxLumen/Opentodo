import { createRoot } from 'react-dom/client'
import App from './ui/App'
import './ui/styles.css'
import './desktop.css'

function Shell() {
  return (
    <>
      <div className="win-drag-strip" />
      <button
        className="win-close"
        title="关闭（Esc）"
        onClick={() => void window.opentodo.window.hide()}
      >
        ×
      </button>
      <App />
    </>
  )
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const target = event.target as HTMLElement | null
    if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) {
      ;(target as HTMLInputElement).blur()
      return
    }
    void window.opentodo.window.hide()
  }
})

createRoot(document.getElementById('root')!).render(<Shell />)
