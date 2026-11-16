/** Agent skill destinations shared by distribution commands. Content and naming stay with the command. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentSkills { agent: string, home: string, skills: string }
export interface AgentSkillDestination extends AgentSkills { directory: string }

const AGENTS: AgentSkills[] = [
  { agent: 'Claude Code', home: '.claude', skills: '.claude/skills' },
  { agent: 'codex', home: '.codex', skills: '.codex/skills' },
  { agent: 'opencode', home: '.config/opencode', skills: '.config/opencode/skill' },
  { agent: 'hermes', home: '.hermes', skills: '.hermes/skills/embedded' },
]

export function installedAgentSkills(home: string): AgentSkillDestination[] {
  return AGENTS.filter(item => existsSync(join(home, item.home))).map(item => ({ ...item, directory: join(home, item.skills) }))
}

export function noAgentsMessage(instruction: string): string {
  return `这台机器上没找到 agent（${AGENTS.map(item => `~/${item.home}`).join('、')} 都不存在）；${instruction}`
}
