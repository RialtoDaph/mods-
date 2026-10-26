import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionUsage } from 'claude-code'

import type {
  OrbitAgent,
  OrbitMission,
  OrbitStatus,
  OrbitStep,
  OrbitTask,
  OrbitTokens,
} from '../types'

const PANE = 'orbit'
const TITLE = 'Agents'
// macOS's own chime, played from the system; nothing of Apple's ships with the mod.
const CHIME = '/System/Library/Sounds/Glass.aiff'

// Prompt-cache lifetime in Claude Code: one hour after the last request.
const CACHE_TTL_MS = 60 * 60 * 1000

// Below this many tokens in context a cold restart costs little; no nagging.
const BIG_CONTEXT = 50_000
// How long before the cache goes cold the warning toast fires.
const WARN_BEFORE_MS = 5 * 60 * 1000

// Colors
const ACCENT = '#a78bfa'
const GREEN = '#4ade80'
const RED = '#f87171'
const ORANGE = '#f97316'
const AMBER = '#fbbf24'
const BLUE = '#60a5fa'
const TRACK = '#3f3f46'
const DOT = '#52525b'
const CARD = '#27272a'
const BODY = '#e07a5f'

// Roughly how many CSS pixels one layout cell is on the desktop surface.
const PX = 6

const mission = atom({ plugin: 'orbit', key: 'mission' } as const, null)
const tick = atom({ plugin: 'orbit', key: 'tick' } as const, 0)
const lastReplyAt = atom({ plugin: 'orbit', key: 'lastReplyAt' } as const, null)
const lastModel = atom({ plugin: 'orbit', key: 'lastModel' } as const, null)
const isFinishedOpen = atom({ plugin: 'orbit', key: 'isFinishedOpen' } as const, true)
const isCompact = atom({ plugin: 'orbit', key: 'isCompact' } as const, false)
const cacheWarnedAt = atom({ plugin: 'orbit', key: 'cacheWarnedAt' } as const, null)
const coldToldAt = atom({ plugin: 'orbit', key: 'coldToldAt' } as const, null)
const isUsageMinimized = atom({ plugin: 'orbit', key: 'isUsageMinimized' } as const, false)

// ---------- tiers: effort level -> label, color, hat ----------

type Hat = 'cap' | 'sailor' | 'hardhat' | 'brimmed' | 'beanie'
type Tier = { label: string; color: string; hat: Hat; emoji: string }

const TIERS: Record<string, Tier> = {
  low: { label: 'light', color: '#34d399', hat: 'cap', emoji: '🟢' },
  medium: { label: 'medium', color: BLUE, hat: 'sailor', emoji: '🔵' },
  high: { label: 'careful', color: '#f59e0b', hat: 'hardhat', emoji: '🟠' },
  xhigh: { label: 'heavy', color: RED, hat: 'brimmed', emoji: '🔴' },
  max: { label: 'max', color: '#f472b6', hat: 'brimmed', emoji: '🟣' },
}
const AUTO: Tier = { label: 'auto', color: ACCENT, hat: 'beanie', emoji: '🟣' }

const tierOf = (effort?: string): Tier => (effort && TIERS[effort]) || AUTO

// ---------- model prices (USD per million tokens) ----------

type Price = { name: string; input: number; read: number; color: string }

const PRICES: Price[] = [
  { name: 'OPUS', input: 4, read: 0.2, color: RED },
  { name: 'SONNET', input: 2, read: 0.2, color: '#a1a1aa' },
  { name: 'HAIKU', input: 0.1, read: 0.01, color: '#a1a1aa' },
]

// Haiku's long-prompt rate above 100K tokens.
const priceFor = (p: Price, tokens: number): Price =>
  p.name === 'HAIKU' && tokens > 100_000 ? { ...p, input: 0.5, read: 0.05 } : p

const familyOf = (model: string) =>
  /opus/i.test(model) ? 'OPUS' : /sonnet/i.test(model) ? 'SONNET' : /haiku/i.test(model) ? 'HAIKU' : ''

// What the next message's context costs on one model: a warm cache is read at
// the cache-read rate on the model that wrote it; anything else is written again
// at the one-hour rate (2x input).
const contextCostUsd = (p0: Price, tokens: number, family: string, isWarm: boolean) => {
  const p = priceFor(p0, tokens)
  const perM = isWarm && p.name === family ? p.read : p.input * 2
  return (tokens / 1_000_000) * perM
}

const priceOf = (family: string) => PRICES.find(p => p.name === family) ?? PRICES[0]!

// Green while the context is lean, amber past 30%, red past 50%.
const fillColor = (pct: number) => (pct >= 50 ? RED : pct >= 30 ? AMBER : GREEN)

// ---------- numbers ----------

const ZERO: OrbitTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const totalOf = (t: OrbitTokens) => t.input + t.output + t.cacheRead + t.cacheWrite

// Relative price weights, the same ratio across Claude models; used to split
// the session's real cost between the main loop and each agent.
const weightOf = (t: OrbitTokens) =>
  t.input + 1.25 * t.cacheWrite + 0.1 * t.cacheRead + 5 * t.output

const addUsage = (t: OrbitTokens, u: ModelUsage): OrbitTokens => ({
  input: t.input + u.input_tokens,
  output: t.output + u.output_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
})

const promptOf = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n)

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// "33m", "2h 23m", "3d 12h"
const fmtSpan = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const prettyModel = (model?: string) => {
  if (!model) return '—'
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(model)
  const family = m?.[1]
  if (!m || !family) return model
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

const textBar = (frac: number, width: number) => {
  const n = Math.round(Math.min(1, Math.max(0, frac)) * width)
  return '▰'.repeat(n) + '▱'.repeat(width - n)
}

const textSweep = (t: number, width: number) => {
  const at = t % width
  return Array.from({ length: width }, (_, i) => (i >= at && i < at + 3 ? '▰' : '▱')).join('')
}

const textDots = (filled: number, total: number) =>
  '●'.repeat(Math.max(0, Math.min(total, filled))) + '·'.repeat(Math.max(0, total - filled))

// ---------- SVG pieces (desktop) ----------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

const barSvg = (frac: number, color: string, w: number, h = 6) => {
  const f = clamp01(frac) * w
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${TRACK}"/>` +
      (f > 0 ? `<rect width="${Math.max(h, f)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : ''),
  )
}

const sweepSvg = (t: number, color: string, w: number, h = 6) => {
  const seg = w * 0.28
  const x = ((t * w) / 12) % (w + seg) - seg
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${TRACK}"/>` +
      `<rect x="${Math.max(0, x)}" width="${Math.max(h, Math.min(seg, x + seg, w - x))}" height="${h}" rx="${h / 2}" fill="${color}"/>`,
  )
}

const dotsSvg = (filled: number, total: number, color: string) => {
  const r = 3.2
  const step = 9
  let body = ''
  for (let i = 0; i < total; i++) {
    const isOn = i < filled
    body += `<circle cx="${r + i * step}" cy="${r + 1}" r="${isOn ? r : r * 0.55}" fill="${isOn ? color : DOT}"/>`
  }
  return svg(total * step, r * 2 + 2, body)
}

const gridSvg = (frac: number, cols: number, color: string) => {
  const rows = 2
  const r = 3.4
  const step = 10
  const on = Math.round(clamp01(frac) * cols)
  let body = ''
  for (let c = 0; c < cols; c++) {
    for (let row = 0; row < rows; row++) {
      body += `<circle cx="${r + c * step}" cy="${r + row * step}" r="${r}" fill="${c < on && row === 0 ? color : DOT}"/>`
    }
  }
  return svg(cols * step, rows * step, body)
}

const idleSvg = (frac: number, w: number) => {
  const h = 14
  const solid = clamp01(frac) * (w - 14)
  let body = `<rect y="${h / 2 - 3}" width="${Math.max(6, solid)}" height="6" rx="3" fill="${frac >= 1 ? BLUE : RED}"/>`
  for (let x = solid + 10; x < w - 16; x += 11) body += `<circle cx="${x}" cy="${h / 2}" r="2" fill="${DOT}"/>`
  body += `<circle cx="${w - 8}" cy="${h / 2}" r="5.5" fill="none" stroke="${BLUE}" stroke-width="2"/>`
  return svg(w, h, body)
}

const towerSvg = (frac: number, color: string) => {
  const cols = 3
  const rows = 6
  const r = 3.2
  const step = 9
  const on = Math.round(clamp01(frac) * cols * rows)
  let body = ''
  let n = 0
  for (let row = rows - 1; row >= 0; row--) {
    for (let c = 0; c < cols; c++) {
      body += `<circle cx="${r + c * step}" cy="${r + row * step}" r="${r}" fill="${n < on ? color : DOT}"/>`
      n++
    }
  }
  return svg(cols * step, rows * step, body)
}

const pillSvg = (label: string, frac: number, t: number) => {
  const w = 190
  const h = 24
  const fill = Math.max(h, clamp01(frac) * w)
  let sparkles = ''
  for (let i = 0; i < 14; i++) {
    const x = ((i * 37 + t * 7) % w) + 2
    const y = 4 + ((i * 11) % (h - 8))
    if (x > fill) sparkles += `<rect x="${x}" y="${y}" width="2" height="2" fill="#6d5bb8" opacity="0.7"/>`
  }
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${CARD}"/>${sparkles}` +
      `<rect width="${fill}" height="${h}" rx="${h / 2}" fill="#8b7cf6"/>` +
      `<text x="${fill / 2}" y="${h / 2 + 4.5}" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="#fff">${esc(label)}</text>`,
  )
}

// A small pixel creature; the hat tells its effort tier apart.
const HATS: Record<Hat, string[]> = {
  cap: ['.........L..', '...GGGGG.L..', '..GGGGGGGG..'],
  sailor: ['............', '...WWWWWW...', '..NNNNNNNN..'],
  hardhat: ['....YYYY....', '...YYYYYY...', '..YYYYYYYYY.'],
  brimmed: ['...UUUUU.R..', '...UUUUUU...', '.UUUUUUUUUU.'],
  beanie: ['.....V......', '...VVVVVV...', '..VVVVVVVV..'],
}
const MASCOT_BODY = [
  '..BBBBBBBB..',
  '.BBWKBBWKBB.',
  '.BBBBBBBBBB.',
  'BBBBBBBBBBBB',
  '.BBBBBBBBBB.',
  '..B.B..B.B..',
  '..B.B..B.B..',
]
const PIXEL: Record<string, string> = {
  B: BODY,
  W: '#ffffff',
  K: '#1c1917',
  G: '#16a34a',
  L: '#bbf7d0',
  N: '#2563eb',
  Y: '#facc15',
  U: '#7c4a2d',
  R: '#ef4444',
  V: ACCENT,
}

const mascotSvg = (hat: Hat, isDim: boolean) => {
  const rows = [...HATS[hat], ...MASCOT_BODY]
  const p = 4
  let body = ''
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const color = PIXEL[ch]
      if (color) body += `<rect x="${x * p}" y="${y * p}" width="${p}" height="${p}" fill="${color}"/>`
    }),
  )
  return svg(12 * p, rows.length * p, isDim ? `<g opacity="0.45">${body}</g>` : body)
}

// ---------- mission helpers ----------

const titleOf = (text: string) => {
  const line = text.trim().split(/[\n.!?]/)[0]?.trim() || 'Mission'
  return line.length > 36 ? line.slice(0, 35) + '…' : line
}

const fresh = (title: string, now: number, usd: number, window = 1_000_000): OrbitMission => ({
  title,
  startedAt: now,
  usdAtStart: usd,
  usdNow: usd,
  window,
  agents: [],
  tasks: [],
  mainTokens: ZERO,
  tools: {},
  isCelebrated: false,
})

const isEmpty = (m: OrbitMission | null): m is null =>
  m === null || (m.agents.length === 0 && m.tasks.length === 0)

const isSettled = (m: OrbitMission) =>
  m.agents.every(a => a.status !== 'running') && m.tasks.every(t => t.status === 'completed')

const progressOf = (m: OrbitMission) => {
  if (m.tasks.length > 0) {
    const done = m.tasks.filter(t => t.status === 'completed').length
    return { label: 'Tasks', done, total: m.tasks.length }
  }
  const done = m.agents.filter(a => a.status !== 'running').length
  return { label: 'Agents', done, total: m.agents.length }
}

const missionUsd = (m: OrbitMission) => Math.max(0, m.usdNow - m.usdAtStart)

const agentUsd = (m: OrbitMission, a: OrbitAgent) => {
  const all = weightOf(m.mainTokens) + m.agents.reduce((s, x) => s + weightOf(x.tokens), 0)
  return all > 0 ? (missionUsd(m) * weightOf(a.tokens)) / all : 0
}

const missionTokens = (m: OrbitMission) =>
  totalOf(m.mainTokens) + m.agents.reduce((s, a) => s + totalOf(a.tokens), 0)

const asStatus = (s: unknown): OrbitStatus =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

const mapAgent = (m: OrbitMission, id: string, fn: (a: OrbitAgent) => OrbitAgent) => ({
  ...m,
  agents: m.agents.map(a => (a.id === id ? fn(a) : a)),
})

// ---------- task tools: TaskCreate / TaskUpdate / TodoWrite ----------

type Todo = { content: string; status: string; activeForm?: string }

const applyTaskTool = (
  m: OrbitMission,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  agentId: string | undefined,
): OrbitMission => {
  const isMain = agentId === undefined

  if (tool === 'TodoWrite') {
    const todos = (input.todos as Todo[] | undefined) ?? []
    if (isMain) {
      return {
        ...m,
        tasks: todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content,
          activeForm: t.activeForm,
          status: asStatus(t.status),
          blockedBy: [],
        })),
      }
    }
    return mapAgent(m, agentId, a => ({
      ...a,
      steps: todos.map((t, i) => ({
        id: String(i + 1),
        content: t.activeForm || t.content,
        status: asStatus(t.status),
      })),
    }))
  }

  if (tool === 'TaskCreate') {
    const id = (result as { task?: { id?: string } } | undefined)?.task?.id
    if (!id) return m
    const subject = String(input.subject ?? 'Task')
    if (isMain) {
      const task: OrbitTask = {
        id,
        subject,
        activeForm: input.activeForm as string | undefined,
        status: 'pending',
        blockedBy: [],
      }
      return { ...m, tasks: [...m.tasks.filter(t => t.id !== id), task] }
    }
    const step: OrbitStep = { id, content: subject, status: 'pending' }
    return mapAgent(m, agentId, a => ({ ...a, steps: [...a.steps, step] }))
  }

  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    const status = input.status as string | undefined
    if (isMain) {
      const tasks = m.tasks
        .filter(t => !(t.id === id && status === 'deleted'))
        .map(t =>
          t.id !== id
            ? t
            : {
                ...t,
                subject: (input.subject as string | undefined) ?? t.subject,
                activeForm: (input.activeForm as string | undefined) ?? t.activeForm,
                status: status ? asStatus(status) : t.status,
                blockedBy: [...new Set([...t.blockedBy, ...((input.addBlockedBy as string[]) ?? [])])],
              },
        )
      // addBlocks on one task means the named tasks wait for it.
      const blocks = (input.addBlocks as string[] | undefined) ?? []
      return {
        ...m,
        tasks: tasks.map(t =>
          blocks.includes(t.id) && !t.blockedBy.includes(id) ? { ...t, blockedBy: [...t.blockedBy, id] } : t,
        ),
      }
    }
    return mapAgent(m, agentId, a => ({
      ...a,
      steps: a.steps
        .filter(s => !(s.id === id && status === 'deleted'))
        .map(s =>
          s.id !== id
            ? s
            : {
                ...s,
                content: (input.subject as string | undefined) ?? s.content,
                status: status ? asStatus(status) : s.status,
              },
        ),
    }))
  }

  return m
}

// ---------- engine calls ----------

function euroOf(usd: number, rate: number) {
  const v = usd * rate
  return v > 0 && v < 0.01 ? '<€0.01' : `≈€${v.toFixed(2)}`
}

async function usageOf($: EngineInterface): Promise<SessionUsage | null> {
  try {
    return await $.session.usage()
  } catch {
    return null
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// When every agent has landed and every task is done, say so once.
async function settle($: EngineInterface, rate: number, shouldChime: boolean) {
  const now = await $.clock.now()
  let done: OrbitMission | null = null
  await update($, mission, m => {
    done = null
    if (isEmpty(m) || m.isCelebrated || !isSettled(m)) return m
    done = { ...m, finishedAt: now, isCelebrated: true }
    return done
  })
  const m = done as OrbitMission | null
  if (m === null) return
  const p = progressOf(m)
  $.ui.toast(
    `🌍 Mission complete · ${p.done}/${p.total} ${p.label.toLowerCase()} · ${euroOf(missionUsd(m), rate)} · ${fmtTime(now - m.startedAt)}`,
    { timeoutMs: 6000 },
  )
  if (shouldChime) await $.process.run(['afplay', CHIME]).catch(() => {})
}

// Toast once when a big cache is about to go cold, and once when it has.
async function watchCache($: EngineInterface, rate: number) {
  const replyAt = await read($, lastReplyAt)
  if (replyAt === null) return
  const now = await $.clock.now()
  const idle = now - replyAt
  const isNearCold = idle >= CACHE_TTL_MS - WARN_BEFORE_MS && idle < CACHE_TTL_MS
  const isCold = idle >= CACHE_TTL_MS
  if (!isNearCold && !isCold) return
  if (isNearCold && (await read($, cacheWarnedAt)) === replyAt) return
  if (isCold && (await read($, coldToldAt)) === replyAt) return

  const usage = await usageOf($)
  const tokens = usage?.context.tokens ?? 0
  if (tokens < BIG_CONTEXT) return
  const family = familyOf((await read($, lastModel)) ?? '')
  const price = priceOf(family)
  const warm = euroOf(contextCostUsd(price, tokens, family, true), rate).replace('≈', '')
  const cold = euroOf(contextCostUsd(price, tokens, family, false), rate).replace('≈', '')

  if (isNearCold) {
    await update($, cacheWarnedAt, () => replyAt)
    $.ui.toast(
      `⏳ Cache goes cold in ${fmtSpan(CACHE_TTL_MS - idle)}: your next message costs ${warm} now, ${cold} after.`,
      { timeoutMs: 15000 },
    )
  } else {
    await update($, coldToldAt, () => replyAt)
    $.ui.toast(
      `🧊 Cache is cold with ${fmtTokens(tokens)} in context: /compact or /clear before continuing to avoid paying ${cold} to rewrite it.`,
      { timeoutMs: 15000 },
    )
  }
}

// ---------- register ----------

export const register: Register = (on, options) => {
  const rate = typeof options.eurRate === 'number' ? options.eurRate : 0.92
  const shouldChime = options.playSound !== false
  const euro = (usd: number) => euroOf(usd, rate)
  let beats = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orbit',
      description: 'Open the Agents sidebar; "/orbit usage" minimizes or expands the usage card',
      argumentHint: '[usage]',
    })
    // Redraw every second while a mission runs, every 20 s otherwise (idle clock).
    $.clock.every(1000, () => {
      beats += 1
      void (async () => {
        const m = await read($, mission)
        const isLive = !isEmpty(m) && m.finishedAt === undefined
        if (isLive || beats % 20 === 0) await update($, tick, n => (n ?? 0) + 1)
        if (beats % 15 === 0) await watchCache($, rate)
      })().catch(() => {})
    })
    return next(e)
  })

  on('command.run', { command: 'orbit' }, async ($, e) => {
    if (e.args.trim() === 'usage') {
      let isMin = false
      await update($, isUsageMinimized, v => (isMin = !v))
      return { text: isMin ? 'Usage card minimized.' : 'Usage card expanded.' }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Agents opened.' : 'Agents will open when there is room.' }
  })

  // A new prompt after a finished mission starts the next one.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      const now = await $.clock.now()
      const usage = await usageOf($)
      await update($, mission, m =>
        m === null || isSettled(m)
          ? fresh(titleOf(e.text), now, usage?.cost?.usd ?? 0, usage?.context.window)
          : m,
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || !spawned.agentId) return spawned

    const agentId = spawned.agentId
    const now = await $.clock.now()
    const usage = await usageOf($)
    let isFirst = false
    await update($, mission, m => {
      const base = m ?? fresh(titleOf(e.description || 'Mission'), now, usage?.cost?.usd ?? 0, usage?.context.window)
      isFirst = base.agents.length === 0
      const agent: OrbitAgent = {
        id: agentId,
        description: e.description || e.subagentType,
        type: e.subagentType,
        model: spawned.model,
        status: 'running',
        startedAt: now,
        tokens: ZERO,
        contextTokens: 0,
        steps: [],
        toolCount: 0,
      }
      return {
        ...base,
        finishedAt: undefined,
        isCelebrated: false,
        agents: [...base.agents.filter(a => a.id !== agentId), agent],
      }
    })
    if (isFirst) void openPane($).catch(() => {})
    return spawned
  }).catch(($, e, next) => next(e))

  // Every model request: who ran it, on what model and effort, and its tokens.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const usage = step.usage
    const session = await usageOf($)
    const usd = session?.cost?.usd
    const effort = e.effort === undefined ? undefined : String(e.effort)
    const model = usage?.model ?? e.model
    if (e.agentId === undefined) await update($, lastModel, () => model)
    await update($, mission, m => {
      if (m === null) return m
      const base = { ...m, usdNow: usd ?? m.usdNow, window: session?.context.window ?? m.window }
      if (e.agentId === undefined) {
        return {
          ...base,
          mainModel: model,
          mainEffort: effort ?? m.mainEffort,
          mainTokens: usage ? addUsage(m.mainTokens, usage) : m.mainTokens,
        }
      }
      return mapAgent(base, e.agentId, a => ({
        ...a,
        model,
        effort: effort ?? a.effort,
        tokens: usage ? addUsage(a.tokens, usage) : a.tokens,
        contextTokens: usage ? promptOf(usage) : a.contextTokens,
      }))
    })
    return step
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const tool = String(e.tool)
    await update($, mission, m => {
      if (m === null) return m
      if (agentId === undefined) {
        return { ...m, tools: { ...m.tools, [tool]: (m.tools[tool] ?? 0) + 1 } }
      }
      return mapAgent(m, agentId, a => ({ ...a, currentTool: tool, toolCount: a.toolCount + 1 }))
    })

    const ran = await next(e)

    if (
      (tool === 'TaskCreate' || tool === 'TaskUpdate' || tool === 'TodoWrite') &&
      ran.deny === undefined &&
      ran.isError !== true
    ) {
      const input = e as unknown as Record<string, unknown>
      await update($, mission, m => (m === null ? m : applyTaskTool(m, tool, input, ran.result, agentId)))
      await settle($, rate, shouldChime)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId
    const now = await $.clock.now()
    if (agentId === undefined) {
      await update($, lastReplyAt, () => now)
    } else {
      const usage = await usageOf($)
      const status = e.reason === 'answer' ? 'landed' : 'failed'
      await update($, mission, m =>
        m === null
          ? m
          : {
              ...mapAgent(m, agentId, a =>
                a.status === 'running' ? { ...a, status, endedAt: now, currentTool: undefined } : a,
              ),
              usdNow: usage?.cost?.usd ?? m.usdNow,
            },
      )
    }
    await settle($, rate, shouldChime)
    return done
  })

  // ---------- the band above the prompt: usage card + mission strip ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const m = await read($, mission)
    const t = await read($, tick)
    const isMin = await read($, isUsageMinimized)
    const replyAt = await read($, lastReplyAt)
    const model = (await read($, lastModel)) ?? ''
    const usage = await usageOf($)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns

    const hasMission = !isEmpty(m)
    const hasUsage = usage !== null && (replyAt !== null || usage.rateLimits.length > 0)
    if (!hasMission && !hasUsage) return next(e)

    const pic = (key: string, source: string, alt: string) =>
      Svg ? <Svg key={key} source={source} alt={alt} /> : null

    // ---- usage card ----
    let card = null
    if (hasUsage && usage) {
      const limits = usage.rateLimits
        .filter(l => l.kind === 'seven_day' || l.kind === 'five_hour')
        .sort((a, b) => (a.kind === 'seven_day' ? -1 : b.kind === 'seven_day' ? 1 : 0))
      const idle = replyAt === null ? 0 : now - replyAt
      const isWarm = replyAt !== null && idle < CACHE_TTL_MS
      const warmLeft = Math.max(0, CACHE_TTL_MS - idle)
      const inCache = usage.context.tokens ?? 0
      const window = usage.context.window
      const pct = usage.context.percent ?? (window > 0 ? Math.round((inCache / window) * 100) : 0)
      const family = familyOf(model)
      const costs = PRICES.map(p => ({ ...p, usd: contextCostUsd(p, inCache, family, isWarm) }))
      const coldUsd = contextCostUsd(priceOf(family), inCache, family, false)
      const isBig = inCache >= BIG_CONTEXT
      const fill = fillColor(pct)
      const maxUsd = Math.max(...costs.map(c => c.usd), 0.0001)
      // Three columns side by side whenever they fit; a sidebar only makes them
      // tighter. Below that the card shows as its one-line summary.
      const layout = cols >= 100 ? 'wide' : cols >= 64 ? 'medium' : 'narrow'
      const colW = Math.floor((cols - 6) / 3)
      const colPx = Math.max(80, Math.min(layout === 'wide' ? 240 : 170, colW * PX))
      const restart = euro(coldUsd).replace('≈', '')

      const idleCol = (
        <Box key="idle" flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text dimColor bold size="caption">
            IDLE
          </Text>
          <Text bold size="heading">
            {replyAt === null ? '—' : fmtSpan(idle)}
          </Text>
          {Svg
            ? pic('idle-bar', idleSvg(idle / CACHE_TTL_MS, colPx), 'idle')
            : <Text color={RED}>{textBar(idle / CACHE_TTL_MS, Math.max(6, Math.min(14, colW - 2)))}</Text>}
          <Text wrap="truncate-end">
            <Text color={BLUE}>{isWarm ? `cold in ${fmtSpan(warmLeft)}` : 'cold'}</Text>
            {replyAt !== null && inCache > 0 && <Text dimColor> · restart {restart}</Text>}
          </Text>
        </Box>
      )

      const cacheCol = (
        <Box key="cache" flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text dimColor bold size="caption">
            IN CACHE
          </Text>
          <Text>
            <Text bold size="heading">
              {fmtTokens(inCache)}
            </Text>
            <Text dimColor> tokens</Text>
          </Text>
          {Svg
            ? pic('cache-grid', gridSvg(pct / 100, Math.max(8, Math.min(22, Math.floor(colPx / 10))), fill), `${pct}% of context`)
            : <Text color={fill}>{textDots(Math.round(pct / 10), 10)}</Text>}
          <Text wrap="truncate-end">
            <Text dimColor>
              {pct}% of {fmtTokens(window).toUpperCase()}
            </Text>
            {pct >= 30 && <Text color={fill}> · {pct >= 50 ? '/compact soon' : '/compact when done'}</Text>}
          </Text>
        </Box>
      )

      const nextCol = (
        <Box key="next" flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text dimColor bold size="caption">
            NEXT MSG, {isWarm ? 'CACHED' : 'COLD'}
          </Text>
          {layout === 'wide' ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {costs.map(c => (
                <Box key={c.name} flexDirection="row" columnGap={1} alignItems="flex-end">
                  {pic(`tower-${c.name}`, towerSvg(c.usd / maxUsd, c.name === family ? RED : '#a1a1aa'), c.name)}
                  <Box flexDirection="column">
                    <Text bold={c.name === family} dimColor={c.name !== family}>
                      {euro(c.usd).replace('≈', '')}
                    </Text>
                    <Text size="caption" bold color={c.name === family ? RED : undefined} dimColor={c.name !== family}>
                      {c.name}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ) : (
            costs.map(c => (
              <Text key={c.name} wrap="truncate-end">
                <Text bold={c.name === family} color={c.name === family ? RED : undefined} dimColor={c.name !== family}>
                  {euro(c.usd).replace('≈', '')}
                </Text>
                <Text dimColor> {c.name.charAt(0) + c.name.slice(1).toLowerCase()}</Text>
              </Text>
            ))
          )}
        </Box>
      )

      const grid = (
        <Box key="grid" flexDirection="row" columnGap={2}>
          {idleCol}
          {cacheCol}
          {nextCol}
        </Box>
      )
      const current = costs.find(c => c.name === family) ?? costs[0]

      // Too narrow for three columns: the one-line summary, with no way to grow.
      const isForcedMin = layout === 'narrow'
      card = isMin || isForcedMin ? (
        <Box
          key="usage"
          flexDirection="row"
          borderStyle="round"
          borderColor={ORANGE}
          paddingX={1}
          marginBottom={hasMission ? 1 : 0}
        >
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center" flexGrow={1} flexShrink={1}>
          <Text bold>USAGE</Text>
          {limits.map(l => {
            const left = Math.max(0, Math.round(100 - l.percentUsed))
            return (
              <Text key={l.kind}>
                <Text dimColor>{l.kind === 'seven_day' ? '7D ' : '5H '}</Text>
                <Text color={l.kind === 'seven_day' ? ORANGE : AMBER} bold>
                  {left}%
                </Text>
              </Text>
            )
          })}
          {replyAt !== null && (
            <Text>
              <Text backgroundColor={isWarm ? RED : BLUE} color="#1c1917" bold>
                {isWarm ? ' WARM ' : ' COLD '}
              </Text>
              {isWarm && <Text color={RED}> {fmtSpan(warmLeft)}</Text>}
            </Text>
          )}
          <Text color={pct >= 30 ? fill : undefined} dimColor={pct < 30}>
            {fmtTokens(inCache)} cached
          </Text>
          {current && (
            <Text dimColor>
              next {euro(current.usd).replace('≈', '')} {current.name}
            </Text>
          )}
          {isWarm && isBig && <Text dimColor>· cold {euro(coldUsd).replace('≈', '')}</Text>}
          {!isWarm && isBig && <Text color={BLUE}>/compact or /clear first</Text>}
          </Box>
          <Box key="corner" flexShrink={0} alignSelf="flex-start" marginLeft={1}>
            {!isForcedMin && (
              <Button key="expand-usage" label="+" plain onPress={() => update($, isUsageMinimized, () => false)} />
            )}
          </Box>
        </Box>
      ) : (
        <Box
          key="usage"
          flexDirection="column"
          borderStyle="round"
          borderColor={ORANGE}
          paddingX={1}
          marginBottom={hasMission ? 1 : 0}
        >
          <Box flexDirection="row">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center" flexGrow={1} flexShrink={1}>
            <Text bold>USAGE</Text>
            {limits.map(l => {
              const left = Math.max(0, Math.round(100 - l.percentUsed))
              const color = l.kind === 'seven_day' ? ORANGE : AMBER
              const reset = l.resetsAt ? fmtSpan(Date.parse(l.resetsAt) - Date.now()) : ''
              const filled = Math.round(left / 10)
              return (
                <Box key={l.kind} flexDirection="row" columnGap={1} alignItems="center">
                  <Text dimColor>{l.kind === 'seven_day' ? '7D' : '5H'}</Text>
                  {Svg ? pic(`dots-${l.kind}`, dotsSvg(filled, 10, color), `${left}% left`) : <Text color={color}>{textDots(filled, 10)}</Text>}
                  <Text color={color} bold>
                    {left}% left
                  </Text>
                  {reset !== '' && <Text dimColor>· {reset}</Text>}
                </Box>
              )
            })}
            {replyAt !== null && (
              <Box key="warm" flexDirection="row" columnGap={1} alignItems="center">
                <Text backgroundColor={isWarm ? RED : BLUE} color="#1c1917" bold>
                  {isWarm ? ' WARM ' : ' COLD '}
                </Text>
                {isWarm && <Text color={RED}>{fmtSpan(warmLeft)} left</Text>}
              </Box>
            )}
          </Box>
          <Box key="corner" flexShrink={0} alignSelf="flex-start" marginLeft={1}>
            <Button key="min-usage" label="—" plain onPress={() => update($, isUsageMinimized, () => true)} />
          </Box>
          </Box>

          {grid}
          {!isWarm && isBig && (
            <Box key="advice" marginTop={1}>
              <Text color={BLUE}>
                🧊 Cold cache, {fmtTokens(inCache)} in context. Continuing rewrites it for{' '}
                {euro(coldUsd).replace('≈', '')}: run /compact to keep the thread, or /clear for a new topic.
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    // ---- mission strip ----
    let strip = null
    if (hasMission) {
      const p = progressOf(m)
      const frac = p.total > 0 ? p.done / p.total : 0
      const pct = Math.round(frac * 100)
      const isDone = m.finishedAt !== undefined
      const running = m.agents.filter(a => a.status === 'running')
      const reviewing = m.tasks.find(x => x.status === 'in_progress')
      const label = `${reviewing && p.label === 'Tasks' ? 'Working' : p.label} ${p.done}/${p.total}`
      const lead = running[0] ?? m.agents.at(-1)

      strip = (
        <Box key="mission" flexDirection="row" columnGap={2} alignItems="center" flexWrap="wrap">
          <Text color={isDone ? GREEN : ACCENT}>{isDone ? '✓' : '●'}</Text>
          <Text bold>{m.title}</Text>
          {Svg ? (
            pic('pill', pillSvg(label, frac, t), label)
          ) : (
            <Text color={ACCENT}>
              {label} {p.total === 0 ? textSweep(t, 12) : textBar(frac, 12)}
            </Text>
          )}
          <Text dimColor>{pct}%</Text>
          {lead && pic('lead', mascotSvg(tierOf(lead.effort).hat, false), 'agent')}
          <Text dimColor>×{m.agents.length}</Text>
          <Text dimColor>
            {euro(missionUsd(m))} · {fmtTokens(missionTokens(m))} · {fmtTime((m.finishedAt ?? now) - m.startedAt)}
          </Text>
          <Box key="spacer" flexGrow={1} />
          <Button key="open" label="Agents" plain onPress={() => openPane($)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {card}
        {strip}
      </Box>
    )
  })

  // ---------- the Agents sidebar ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const m = await read($, mission)
    const t = await read($, tick)
    const isOpen = await read($, isFinishedOpen)
    const compact = await read($, isCompact)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const barCols = Math.max(10, cols - (Svg ? 9 : 4))

    const pic = (key: string, source: string, alt: string) =>
      Svg ? <Svg key={key} source={source} alt={alt} /> : null

    if (isEmpty(m)) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No agents yet. They show up here as Claude starts them.</Text>
        </Box>
      )
    }

    const elapsed = (m.finishedAt ?? now) - m.startedAt

    const stat = (key: string, label: string, value: string) => (
      <Box
        key={key}
        flexDirection="column"
        flexGrow={1}
       
        backgroundColor={Svg ? CARD : undefined}
        borderStyle={Svg ? undefined : 'round'}
        borderColor={TRACK}
        paddingX={1}
      >
        <Text dimColor>{label}</Text>
        <Text bold size="heading">
          {value}
        </Text>
      </Box>
    )

    const divider = (key: string) =>
      Svg ? (
        <Box key={key} marginY={1}>
          {pic(`${key}-svg`, svg(cols * PX, 1, `<rect width="${cols * PX}" height="1" fill="${TRACK}"/>`), '')}
        </Box>
      ) : (
        <Text key={key} dimColor>
          {'─'.repeat(Math.max(4, cols))}
        </Text>
      )

    const progressPic = (key: string, frac: number | null, color: string) =>
      Svg ? (
        pic(key, frac === null ? sweepSvg(t, color, barCols * PX) : barSvg(frac, color, barCols * PX), 'progress')
      ) : (
        <Text key={key} color={color}>
          {frac === null ? textSweep(t, Math.min(30, barCols)) : textBar(frac, Math.min(30, barCols))}
        </Text>
      )

    const row = (
      key: string,
      hat: Hat,
      isDim: boolean,
      title: string,
      mark: { glyph: string; color?: string },
      tierLine: { label: string; color: string; rest: string },
      left: string,
      right: string,
      bar: { frac: number | null; color: string },
    ) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {Svg ? (
            <Box flexShrink={0} paddingTop={1}>
              {pic(`${key}-m`, mascotSvg(hat, isDim), tierLine.label)}
            </Box>
          ) : null}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold dimColor={isDim} wrap="truncate-end">
                {title}
              </Text>
              <Text color={mark.color} dimColor={!mark.color} bold>
                {mark.glyph}
              </Text>
            </Box>
            <Text>
              <Text color={tierLine.color}>{tierLine.label}</Text>
              <Text dimColor> {tierLine.rest}</Text>
            </Text>
            {!compact && (
              <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                <Text wrap="truncate-end">{left}</Text>
                <Text dimColor>{right}</Text>
              </Box>
            )}
            {!compact && progressPic(`${key}-bar`, bar.frac, bar.color)}
          </Box>
        </Box>
      </Box>
    )

    const agentRow = (a: OrbitAgent) => {
      const tier = tierOf(a.effort)
      const isRunning = a.status === 'running'
      const stepsDone = a.steps.filter(s => s.status === 'completed').length
      const current = a.steps.find(s => s.status === 'in_progress')
      const left =
        a.steps.length > 0
          ? `${stepsDone}/${a.steps.length}${current ? ` · ${current.content}` : ''}`
          : isRunning
            ? a.currentTool
              ? `${a.currentTool} · ${a.toolCount} calls`
              : 'Starting'
            : `${a.toolCount} calls`
      const ctx = m.window > 0 ? Math.round((a.contextTokens / m.window) * 100) : 0
      const right = `ctx ${ctx}% · ${fmtTokens(totalOf(a.tokens))} ${euro(agentUsd(m, a))} ${fmtTime((a.endedAt ?? now) - a.startedAt)}`
      const frac = !isRunning ? 1 : a.steps.length > 0 ? stepsDone / a.steps.length : null
      const mark = isRunning
        ? { glyph: t % 2 === 0 ? '●' : '○', color: tier.color }
        : a.status === 'landed'
          ? { glyph: '✓', color: GREEN }
          : { glyph: '✗', color: RED }
      return row(
        `agent-${a.id}`,
        tier.hat,
        false,
        a.description,
        mark,
        { label: tier.label, color: tier.color, rest: `${prettyModel(a.model)} · ${a.effort ?? 'auto'}` },
        left,
        right,
        { frac, color: a.status === 'failed' ? RED : tier.color },
      )
    }

    const taskRow = (task: OrbitTask, index: number) => {
      const doneIds = new Set(m.tasks.filter(x => x.status === 'completed').map(x => x.id))
      const waits = task.blockedBy.filter(id => !doneIds.has(id))
      return row(
        `task-${task.id}`,
        'beanie',
        true,
        `${index + 1}. ${task.subject}`,
        { glyph: '◷' },
        {
          label: 'planned',
          color: '#a1a1aa',
          rest: waits.length > 0 ? `after ${waits.join(', ')}` : 'ready',
        },
        '0/… · Brief',
        `#${task.id}`,
        { frac: 0, color: TRACK },
      )
    }

    const running = m.agents.filter(a => a.status === 'running')
    const finished = m.agents.filter(a => a.status !== 'running').reverse()
    const planned = m.tasks.filter(x => x.status === 'pending')
    const inWork = m.tasks.filter(x => x.status === 'in_progress')

    const sectionTitle = (key: string, text: string) => (
      <Box key={key} marginTop={1}>
        <Text dimColor size="heading">
          {text}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold size="title" wrap="truncate-end">
          {m.title}
        </Text>
        {m.finishedAt !== undefined && <Text color={GREEN}>🌍 Mission complete</Text>}

        <Box flexDirection="row" columnGap={1} marginTop={1}>
          {stat('cost', 'Cost', euro(missionUsd(m)))}
          {stat('tokens', 'Tokens', fmtTokens(missionTokens(m)))}
          {stat('time', 'Time', fmtTime(elapsed))}
        </Box>

        <Box marginTop={1}>
          <Button key="compact" plain onPress={() => update($, isCompact, v => !v)}>
            <Text dimColor size="heading">
              {compact ? 'Expand' : 'Collapse'}
            </Text>
          </Button>
        </Box>

        {running.length > 0 && sectionTitle('h-run', `Running · ${running.length}`)}
        {running.flatMap((a, i) => (i > 0 ? [divider(`d-run-${a.id}`), agentRow(a)] : [agentRow(a)]))}
        {inWork.length > 0 && running.length === 0 && sectionTitle('h-work', `Running · ${inWork.length}`)}
        {running.length === 0 &&
          inWork.map(task => (
            <Text key={`work-${task.id}`}>
              <Text color={ACCENT}>●</Text> {task.activeForm ?? task.subject}
            </Text>
          ))}

        {finished.length > 0 && divider('d-fin')}
        {finished.length > 0 && (
          <Button key="toggle-finished" plain onPress={() => update($, isFinishedOpen, v => !v)}>
            <Text size="heading">
              {isOpen ? '▾' : '▸'} Finished · {finished.length}
            </Text>
          </Button>
        )}
        {isOpen && finished.flatMap((a, i) => (i > 0 ? [divider(`d-fin-${a.id}`), agentRow(a)] : [agentRow(a)]))}

        {planned.length > 0 && divider('d-plan')}
        {planned.length > 0 && sectionTitle('h-plan', `Planned · ${planned.length}`)}
        {planned.flatMap((task, i) =>
          i > 0 ? [divider(`d-plan-${task.id}`), taskRow(task, m.tasks.indexOf(task))] : [taskRow(task, m.tasks.indexOf(task))],
        )}
      </Box>
    )
  })
}
