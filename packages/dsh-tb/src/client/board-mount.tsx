/**
 * Board view mounting: a container appended inside the `[data-pane=
 * "conversation"]` grid item (a trailing child React never manages), with a
 * stylesheet rule hiding the conversation content while the board is active.
 * Toggling rides a data attribute on <html> — no React involvement in the
 * shell.
 *
 * @module dsh-taskboard/client/board-mount
 */
import { createRoot, type Root } from 'react-dom/client'
import type { BoardController } from './controller.ts'
import { TaskBoard } from './board/TaskBoard.tsx'

/** The injected board container. */
export const BOARD_VIEW_SELECTOR = '[data-dsh-atb-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVE_ATTR = 'data-dsh-atb-active'
/** Sibling panels' activation attributes, evicted when this board opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
// 'taskboard' is the family ui-task-board panel's event name; stay distinct to keep eviction working.
const PANEL_NAME = 'dsh-taskboard'

/** Find the center column. */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/**
 * Mount the board React tree and bind visibility to the controller.
 * @param controller - the controller.
 * @returns disposer.
 */
export function mountBoard(controller: BoardController): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshAtbView = ''
    container.className = 'dsh-atb-view'
    column.appendChild(container)
    root = createRoot(container)
    root.render(<TaskBoard controller={controller} />)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().boardOpen) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== PANEL_NAME && controller.getSnapshot().boardOpen) {
      controller.closeBoard()
    }
  }
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().boardOpen) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    container?.remove()
  }
}
