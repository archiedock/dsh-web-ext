/**
 * Compatibility shim: the composer moved into TaskFormModal (create + edit
 * in one dialog). Kept so existing imports keep working.
 *
 * @module dsh-taskboard/client/board/NewTaskModal
 */
export { TaskFormModal as NewTaskModal } from './TaskFormModal.tsx'
export type { CatalogModel } from './TaskFormModal.tsx'
