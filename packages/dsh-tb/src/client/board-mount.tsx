/**
 * Board view mounting: a container appended inside the center column (a
 * trailing child React never manages), with a stylesheet rule hiding the
 * conversation content while the board is active. Toggling rides a data
 * attribute on <html> — no React involvement in the shell.
 *
 * Column matching is DUAL (0.4.2): the dev shell marks the column with
 * `data-pane="conversation"`; the DSH Desktop shell (dsh-client-ui-layout)
 * dropped data-pane entirely and uses CSS-Module hashed class names
 * (`pI_x6G_centerCol`) — the class-substring fallback keeps both mounting,
 * exactly like sidebar-entry's `[class*="sidebarCol"]` fallback.
 *
 * @module dsh-taskboard/client/board-mount
 */
import { createRoot, type Root } from 'react-dom/client'
import type { BoardController } from './controller.ts'
import { TaskBoard } from './board/TaskBoard.tsx'
import { ENTRY_SELECTOR } from './sidebar-entry.ts'

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
    // 0.4.1 竞态修复：任务看板自己的侧栏入口先整体豁免——在部分 shell
    // 的 DOM 里，插入点落在 class 含 newSession 的容器内部，此时入口点击
    // 会被本捕获监听器先 closeBoard，再被入口自身的 toggleBoard 翻回来
    // （症状：看板闪关或入口按钮关不掉）。豁免必须按「入口子树」判定
    // （closest 而非元素自身匹配）：入口可能嵌在带 newSession 类的祖先
    // 容器里，仅对选择器加 :not() 排除元素自身挡不住那种嵌套形态。
    if (target.closest(ENTRY_SELECTOR) !== null) return
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
