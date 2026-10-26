export type OrbitTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type OrbitStatus = 'pending' | 'in_progress' | 'completed'

export type OrbitStep = { id: string; content: string; status: OrbitStatus }

export type OrbitAgent = {
  id: string
  description: string
  type: string
  model?: string
  effort?: string
  status: 'running' | 'landed' | 'failed'
  startedAt: number
  endedAt?: number
  tokens: OrbitTokens
  contextTokens: number
  steps: OrbitStep[]
  currentTool?: string
  toolCount: number
}

export type OrbitTask = {
  id: string
  subject: string
  activeForm?: string
  status: OrbitStatus
  blockedBy: string[]
}

export type OrbitMission = {
  title: string
  startedAt: number
  finishedAt?: number
  usdAtStart: number
  usdNow: number
  window: number
  agents: OrbitAgent[]
  tasks: OrbitTask[]
  mainTokens: OrbitTokens
  mainModel?: string
  mainEffort?: string
  tools: Record<string, number>
  isCelebrated: boolean
}

declare module 'claude-code' {
  interface PluginState {
    orbit: {
      mission: OrbitMission | null
      tick: number
      lastReplyAt: number | null
      lastModel: string | null
      isFinishedOpen: boolean
      isCompact: boolean
      isUsageMinimized: boolean
      cacheWarnedAt: number | null
      coldToldAt: number | null
    }
  }
}
