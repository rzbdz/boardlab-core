/** The settings tab: each module's settings, the labs, and the firmware boardd ships. */
import { loadedUis, type ViewProps } from '../extensions.ts'
import { Section } from '../kit.tsx'
import { LabSection } from './labs.tsx'

export function SettingsTab(props: ViewProps) {
  const { state } = props
  return (
    <div className="stack narrow">
      {loadedUis(state).map(ui => ui.settings && <ui.settings key={ui.module} {...props} />)}

      {state.labs.map(lab => <LabSection key={lab.id} lab={lab} onRun={props.onRun} onPrompt={props.onPrompt} />)}

      <Section title="自带固件">
        <p className="muted">boardd 只加载仓库 <code>firmware/</code> 里 <code>firmware.json</code> 列出、且 sha256 仍然一致的固件；要换就改那里再提交。扫描固定用 minor-board-info，只改内核时 <code>boardlab boot</code> 用 fsbl 和 u-boot-opensbi。</p>
        <ul className="images">
          {state.firmware.map(item => (
            <li key={`${item.soc}/${item.purpose}`}>
              <span className="kind">{item.soc.toUpperCase()}</span>
              <div className="grow"><b>{item.purpose}</b><code className="path">{item.path}</code><small>sha256 {item.sha256.slice(0, 16)}…{item.note ? ` · ${item.note}` : ''}</small></div>
            </li>
          ))}
        </ul>
        {!state.firmware.length && <p className="warn">没有找到 firmware.json。</p>}
      </Section>
    </div>
  )
}
