/** The scan tab: each module's way to scan, labs that find boards themselves, and the proposals waiting. */
import { loadedUis, type ViewProps } from '../extensions.ts'
import { LabScan } from './labs.tsx'
import { ProposalList } from './proposals.tsx'

export function ScanTab(props: ViewProps) {
  const { state } = props
  const uis = loadedUis(state)
  const results = uis.filter(ui => ui.scanResult)
  return (
    <div className="columns">
      <div className="stack">
        {uis.map(ui => ui.scan && <ui.scan key={ui.module} {...props} />)}
        {state.labs.filter(lab => lab.enabled && lab.canDiscover).map(lab => <LabScan key={lab.id} lab={lab} state={state} onPrompt={props.onPrompt} />)}
        <ProposalList proposals={state.proposals} onRun={props.onRun} />
      </div>
      {results.length > 0 && <div className="stack">{results.map(ui => ui.scanResult && <ui.scanResult key={ui.module} {...props} />)}</div>}
    </div>
  )
}

/** Whether there is anything to scan or review: a module that scans, a lab that finds boards, or proposals waiting. */
export function canScan(props: Pick<ViewProps, 'state'>): boolean {
  const { state } = props
  return loadedUis(state).some(ui => ui.scan) || state.labs.some(lab => lab.enabled && lab.canDiscover) || state.proposals.length > 0
}
