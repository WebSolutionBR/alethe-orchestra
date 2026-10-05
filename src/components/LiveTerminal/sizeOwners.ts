/**
 * Which live view decides a PTY's size. Two views that both fit the PTY to their own box would
 * resize it back and forth, and every resize makes an agent TUI repaint its whole frame — the
 * scrambling this view exists to avoid. Only the most recently claimed view (focused, or mounted
 * when nobody else held the PTY) resizes; the others read the mirror as it is.
 */
type Listener = () => void

const owners = new Map<string, symbol[]>()
const listeners = new Map<string, Set<Listener>>()

function notify(ptyId: string): void {
  for (const listener of [...(listeners.get(ptyId) ?? [])]) listener()
}

/** Registers a view; it becomes the owner when it claims or when nobody holds the PTY yet. */
export function joinSizeOwners(ptyId: string, token: symbol, claim: boolean): () => void {
  const stack = owners.get(ptyId) ?? []
  owners.set(ptyId, stack)
  if (claim || stack.length === 0) stack.push(token)
  else stack.unshift(token)
  notify(ptyId)
  return () => {
    const current = owners.get(ptyId)
    if (!current) return
    const index = current.indexOf(token)
    if (index === -1) return
    const wasOwner = index === current.length - 1
    current.splice(index, 1)
    if (current.length === 0) owners.delete(ptyId)
    if (wasOwner) notify(ptyId)
  }
}

/** Makes a registered view the owner (it was focused or clicked). */
export function claimSize(ptyId: string, token: symbol): void {
  const stack = owners.get(ptyId)
  if (!stack) return
  const index = stack.indexOf(token)
  if (index === -1 || index === stack.length - 1) return
  stack.splice(index, 1)
  stack.push(token)
  notify(ptyId)
}

export function isSizeOwner(ptyId: string, token: symbol): boolean {
  const stack = owners.get(ptyId)
  return !!stack && stack[stack.length - 1] === token
}

export function onSizeOwnerChange(ptyId: string, listener: Listener): () => void {
  const set = listeners.get(ptyId) ?? new Set<Listener>()
  listeners.set(ptyId, set)
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(ptyId)
  }
}
