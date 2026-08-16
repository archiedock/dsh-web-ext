/**
 * A lightweight alert modal — replaces native alert() with a themed overlay
 * that matches the shell design tokens.
 *
 * @module dsh-taskboard/client/board/AlertModal
 */
import { useState, useEffect } from 'react'

/** Show a non-blocking alert modal. Returns true when opened. */
export function useAlert(): { alert: (msg: string) => void; el: React.ReactNode } {
  const [msg, setMsg] = useState<string | null>(null)
  const show = (m: string) => setMsg(m)
  const close = () => setMsg(null)
  const el = msg !== null
    ? <AlertModal message={msg} onClose={close} />
    : null
  return { alert: show, el }
}

function AlertModal({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="dsh-atb-alert-backdrop" onClick={onClose}>
      <div className="dsh-atb-alert" onClick={e => e.stopPropagation()}>
        <div className="dsh-atb-alert-icon">⛔</div>
        <div className="dsh-atb-alert-msg">{message}</div>
        <button type="button" className="dsh-atb-btn" data-primary="true" onClick={onClose}>知道了</button>
      </div>
    </div>
  )
}
