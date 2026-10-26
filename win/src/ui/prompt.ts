/**
 * Electron does not implement window.prompt(). The web UI uses it for
 * "new project" / "new group"; this small in-app dialog replaces it.
 */
export function promptText(title: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.createElement('div')
    mask.className = 'win-prompt-mask'
    const box = document.createElement('div')
    box.className = 'win-prompt'
    const label = document.createElement('div')
    label.className = 'win-prompt-title'
    label.textContent = title
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.className = 'win-prompt-input'
    const actions = document.createElement('div')
    actions.className = 'win-prompt-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = '取消'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'primary'
    ok.textContent = '确定'
    actions.append(cancel, ok)
    box.append(label, input, actions)
    mask.append(box)
    document.body.append(mask)
    input.focus()
    input.select()

    let done = false
    const close = (value: string | null) => {
      if (done) return
      done = true
      mask.remove()
      resolve(value)
    }
    const submit = () => close(input.value.trim() ? input.value : null)
    ok.addEventListener('click', submit)
    cancel.addEventListener('click', () => close(null))
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) close(null)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      }
    })
  })
}
