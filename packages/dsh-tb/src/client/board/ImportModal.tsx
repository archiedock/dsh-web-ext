/**
 * The ledger-import modal (0.4.0): pick a JSON file → dry-run preview
 * (create / overwrite / invalid classification) → commit as merge or
 * replace. Replace swaps the WHOLE ledger after an automatic backup and a
 * double confirmation. Files exported by ⬇ JSON import as-is.
 *
 * @module dsh-taskboard/client/board/ImportModal
 */
import { useRef, useState } from 'react'
import type { BoardController } from '../controller.ts'
import type { ImportPreviewResponse } from '../../shared/api.ts'
import { useAlert } from './AlertModal.tsx'

/** One classified row (create / overwrite). */
function PlanRow({ row }: { row: { id: string; title: string; status: string } }) {
  return (
    <div className="dsh-atb-imp-row" title={row.id}>
      <span className="dsh-atb-imp-row-title">{row.title}</span>
      <span className="dsh-atb-imp-row-status">{row.status}</span>
    </div>
  )
}

/**
 * The import modal.
 * @param controller - the controller.
 */
export function ImportModal({ controller }: { controller: BoardController }) {
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<unknown>(null)
  const [parseError, setParseError] = useState<string | undefined>(undefined)
  const [plan, setPlan] = useState<ImportPreviewResponse['plan'] | undefined>(undefined)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | undefined>(undefined)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { alert: showAlert, el: alertEl } = useAlert()

  /** Read + parse the picked file, then dry-run the preview. */
  const onFile = (file: File | undefined): void => {
    setPlan(undefined)
    setParseError(undefined)
    setResult(undefined)
    setConfirmReplace(false)
    setFileName('')
    setParsed(null)
    if (file === undefined) return
    void file.text().then(text => {
      try {
        const value: unknown = JSON.parse(text)
        setParsed(value)
        setFileName(file.name)
        void controller.importPreview(value).then(p => {
          if (p !== undefined) setPlan(p)
        })
      } catch {
        setParseError('文件不是合法 JSON')
      }
    })
  }

  /** Commit the import (replace requires the inline double confirmation). */
  const commit = (): void => {
    if (parsed === null || plan === undefined || busy) return
    if (mode === 'replace' && !confirmReplace) {
      setConfirmReplace(true)
      return
    }
    setBusy(true)
    void controller.importCommit(mode, parsed).then(r => {
      setBusy(false)
      setConfirmReplace(false)
      if (r === undefined) return
      setResult(r.mode === 'replace'
        ? `整册替换完成：导入 ${r.created + r.overwritten} 张（原 ${r.replacedTotal} 张已整册备份）`
        : `合并完成：新增 ${r.created} 张、覆盖 ${r.overwritten} 张`)
    })
  }

  const close = (): void => controller.closeImport()

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <div className="dsh-atb-modal dsh-atb-imp" role="dialog" aria-modal="true" aria-label="导入台账">
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">⬆</span>
          <div className="dsh-atb-modal-headtext">
            <h3>导入台账</h3>
            <p>选择导出的 JSON 备份文件：先预览、再合并或整册替换</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label="关闭" onClick={close}>✕</button>
        </div>
        <div className="dsh-atb-modal-body">
          <div className="dsh-atb-imp-picker">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={e => onFile(e.target.files?.[0])}
            />
            {fileName.length > 0 && <span className="dsh-atb-imp-filename">{fileName}</span>}
          </div>
          <div className="dsh-atb-imp-note">⬇ JSON 导出的文件即为同格式备份，可直接导入恢复；导入文件的 schemaVersion 必须与当前版本一致。</div>

          {parseError !== undefined && <div className="dsh-atb-imp-error">{parseError}</div>}
          {plan === undefined && parseError === undefined && fileName.length > 0 && <div className="dsh-atb-empty2">预览中…</div>}

          {plan !== undefined && (
            <>
              <div className="dsh-atb-imp-stats">
                <div className="dsh-atb-imp-stat" data-tone="ok"><b>{plan.create.length}</b><span>新增</span></div>
                <div className="dsh-atb-imp-stat" data-tone="warn"><b>{plan.overwrite.length}</b><span>覆盖（同 id）</span></div>
                <div className="dsh-atb-imp-stat" data-tone={plan.invalid.length > 0 ? 'bad' : undefined}><b>{plan.invalid.length}</b><span>无效（跳过）</span></div>
              </div>

              {plan.create.length > 0 && (
                <div className="dsh-atb-imp-sec">
                  <h4>新增任务</h4>
                  <div className="dsh-atb-imp-list">{plan.create.map(r => <PlanRow key={r.id} row={r} />)}</div>
                </div>
              )}
              {plan.overwrite.length > 0 && (
                <div className="dsh-atb-imp-sec">
                  <h4>覆盖任务（整卡替换，含执行历史与评论）</h4>
                  <div className="dsh-atb-imp-list">{plan.overwrite.map(r => <PlanRow key={r.id} row={r} />)}</div>
                </div>
              )}
              {plan.invalid.length > 0 && (
                <div className="dsh-atb-imp-sec">
                  <h4>无效条目（不会导入）</h4>
                  <div className="dsh-atb-imp-list">
                    {plan.invalid.map((r, i) => (
                      <div key={r.id ?? `invalid-${i}`} className="dsh-atb-imp-row" data-tone="bad" title={r.id ?? ''}>
                        <span className="dsh-atb-imp-row-title">{r.id ?? '（无 id）'}</span>
                        <span className="dsh-atb-imp-row-status">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="dsh-atb-mode-picker">
                <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'merge'} onClick={() => { setMode('merge'); setConfirmReplace(false) }}>
                  <span className="dsh-atb-mode-name">⊕ 合并</span>
                  <span className="dsh-atb-mode-hint">新增 + 按 id 覆盖，其余不动</span>
                </button>
                <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'replace'} onClick={() => setMode('replace')}>
                  <span className="dsh-atb-mode-name">💣 整册替换</span>
                  <span className="dsh-atb-mode-hint">清空当前台账，以导入文件为准（先自动备份）</span>
                </button>
              </div>

              {result !== undefined && <div className="dsh-atb-imp-result">{result}</div>}
            </>
          )}
        </div>
        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint">
            {mode === 'replace'
              ? confirmReplace ? '⚠ 再次点击确认执行整册替换（不可撤销，已自动备份）' : '整册替换需要二次确认'
              : '合并只写入预览中列出的任务'}
          </span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={close}>{result !== undefined ? '关闭' : '取消'}</button>
            <button
              type="button"
              className="dsh-atb-btn"
              data-primary="true"
              data-danger={mode === 'replace' && confirmReplace ? 'true' : undefined}
              disabled={plan === undefined || busy || (result !== undefined && false)}
              onClick={commit}
            >
              {mode === 'replace' && confirmReplace ? '确认整册替换' : '执行导入'}
            </button>
          </span>
        </div>
      </div>
      {alertEl}
    </div>
  )
}
