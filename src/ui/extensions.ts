/**
 * What a module adds to the page. A distribution gives the page its modules' UI parts (`src/modules/<id>/ui.tsx`);
 * each shows only when boardd has loaded its module, so the page fits whatever boardd it is served by.
 */
import type { ComponentType } from 'react'
import type { History, PageState } from './api.ts'
import type { Prompt, Run } from './kit.tsx'

export interface ViewProps { state: PageState, onPrompt: (prompt: Prompt) => void, onRun: Run }

export interface ModuleUi {
  /** The module whose UI this is. */
  module: string
  /** Sections of the settings tab. */
  settings?: ComponentType<ViewProps>
  /** Starting a scan, on the scan tab, and what the latest one found beside it. */
  scan?: ComponentType<ViewProps>
  scanResult?: ComponentType<ViewProps>
  /** Its part of the history tab, from what it adds to the history. */
  history?: ComponentType<{ history: History }>
}

let registered: ModuleUi[] = []

/** The distribution's module UIs, given once when the page starts (see mountPage). */
export function registerModuleUis(uis: ModuleUi[]) { registered = uis }

/** The module UIs for the modules this boardd has loaded. */
export function loadedUis(state: PageState): ModuleUi[] {
  return registered.filter(ui => state.modules.some(module => module.id === ui.module))
}
