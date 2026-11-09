/** When a person is needed at a board: getting their attention, and the panel to say it is done. */
import { useState } from 'react'
import { api, type PageState } from '../api.ts'
import { who, type Run } from '../kit.tsx'

// ---------- a person is needed at a board ----------

/** Get the person's attention: a short tone, a flashing tab title, and a system notification where allowed. */
export function alertPerson(board: string, message: string) {
  try {
    const audio = new AudioContext()
    const tone = audio.createOscillator(), gain = audio.createGain()
    tone.frequency.value = 880
    gain.gain.setValueAtTime(0.15, audio.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6)
    tone.connect(gain).connect(audio.destination)
    tone.start()
    tone.stop(audio.currentTime + 0.6)
  } catch {}
  flashTitle(`【需要操作】${board}`)
  if ('Notification' in window && Notification.permission === 'granted') {
    const note = new Notification(`${board}：需要你操作`, { body: `${message}\n做完后点这里确认`, tag: `attention-${board}`, requireInteraction: true })
    note.onclick = () => { window.focus(); document.getElementById('attention')?.scrollIntoView({ behavior: 'smooth' }); note.close() }
  }
}

let titleTimer: number | undefined
export function flashTitle(text: string) {
  const original = document.title.replace(/^【需要操作】.*? · /, '')
  window.clearInterval(titleTimer)
  let on = false, count = 0
  titleTimer = window.setInterval(() => {
    on = !on
    document.title = on ? `${text} · ${original}` : original
    if (++count > 40 || (document.hasFocus() && count > 6)) { window.clearInterval(titleTimer); document.title = original }
  }, 800)
}

/**
 * Boards waiting for a person (press RESET, hold BOOT, …), wherever the reset or boot was started: a panel that stays
 * until the board is done waiting, with the button that tells the lab the person did it.
 */
export function AttentionPanel({ state, onRun }: { state: PageState, onRun: Run }) {
  const [later, setLater] = useState<Record<string, string>>({})
  const waiting = state.boards.filter(board => board.lab?.attention && later[board.name] !== board.lab.attention)
  const canNotify = 'Notification' in window && window.isSecureContext && Notification.permission === 'default'
  if (!waiting.length) return null
  return (
    <div className="attention-panel" id="attention" role="alertdialog" aria-label="需要人操作">
      {waiting.map(board => (
        <div key={board.name} className="attention-item">
          <div className="grow">
            <b>{board.name}</b>{board.lease && <span className="muted"> · {who(board.lease.holder)} 在用</span>}
            <p>{board.lab!.attention}</p>
          </div>
          <div className="actions">
            {board.lab!.canConfirm && <button className="primary" onClick={() => onRun(`已告诉实验室：${board.name} 做完了`, () => api.confirm(board.name))}>我已完成</button>}
            <button onClick={() => setLater({ ...later, [board.name]: board.lab!.attention! })}>稍后</button>
          </div>
        </div>
      ))}
      {canNotify && <button className="link" onClick={() => void Notification.requestPermission()}>开启系统通知（不在这个页面时也能看到）</button>}
    </div>
  )
}
