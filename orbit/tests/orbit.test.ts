import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The engine beneath the plugin: a clock, a rising session cost, toasts,
// sound and panes, and a plain drawing where the plugin hands a site on.
const world = (on: On) => {
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  let usd = 0
  on('session.usage', () => {
    usd += 0.05
    return { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd } } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {})
  })
  return { clock, toasts }
}

const SURFACES = ['terminal', 'desktop'] as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PANE_PROPS = {
  title: 'Orbit',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('a mission shows its agents and tasks, then completes', async ($, on) => {
  const { clock, toasts } = world(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({
    result: { task: { id: '1', subject: e.subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.agent.spawn({
    prompt: 'Build it',
    description: 'Build the landing page',
    subagentType: 'general-purpose',
  })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Review the whole kit', description: 'Review' })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /Build the landing page/ })).toBeDefined()
    expect(await band.find({ text: /×1/ })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'orbit',
      surface,
      component: 'Pane',
      requestId: 'orbit',
      props: PANE_PROPS,
    })
    expect(await pane.find({ text: /Build the landing page/ })).toBeDefined()
    expect(await pane.find({ text: /Running · 1/ })).toBeDefined()
    expect(await pane.find({ text: /Opus 5\.5/ })).toBeDefined()
    expect(await pane.find({ text: /1\. Review the whole kit/ })).toBeDefined()
    await pane.unmount()
  }

  await clock.advance(26_000)
  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({
      plugin: 'orbit',
      surface,
      component: 'Pane',
      requestId: 'orbit',
      props: PANE_PROPS,
    })
    expect(await pane.find({ text: /Mission complete/ })).toBeDefined()
    expect(await pane.find({ text: /Finished · 1/ })).toBeDefined()
    await pane.unmount()

    const band = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /100%/ })).toBeDefined()
    await band.unmount()
  }
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Mission complete')
  expect(toasts[0]).toContain('€')
})

test('no band before any agent or task exists', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /×/ })).toBeUndefined()
    await band.unmount()
  }
})

test('the usage card shows limits, a warm cache and next-message costs', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 182_000, window: 1_000_000, percent: 18 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 58 },
        { kind: 'five_hour', percentUsed: 11 },
      ],
      cost: { usd: 1 },
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {})
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'hi', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
  await clock.advance(33 * 60_000)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: 'USAGE' })).toBeDefined()
    expect(await band.find({ text: /42% left/ })).toBeDefined()
    expect(await band.find({ text: /89% left/ })).toBeDefined()
    expect(await band.find({ text: /WARM/ })).toBeDefined()
    expect(await band.find({ text: /27m left/ })).toBeDefined()
    expect(await band.find({ text: /^33m$/ })).toBeDefined()
    expect(await band.find({ text: /182k/ })).toBeDefined()
    expect(await band.find({ text: /18% of the 1M context/ })).toBeDefined()
    expect(await band.find({ text: 'OPUS' })).toBeDefined()
    expect(await band.find({ text: /cold restart/ })).toBeDefined()

    await band.unmount()

    // A sidebar narrows the band: two columns, then everything stacked.
    for (const bodyColumns of [80, 50]) {
      const narrow = await $.ui.mount({
        plugin: 'orbit',
        surface,
        component: 'AbovePrompt',
        props: { ...BAND_PROPS, bodyColumns },
      })
      expect(await narrow.find({ text: 'IDLE' })).toBeDefined()
      expect(await narrow.find({ text: /182k/ })).toBeDefined()
      expect(await narrow.find({ text: bodyColumns < 64 ? /Opus €/ : 'OPUS' })).toBeDefined()
      await narrow.unmount()
    }

    const again = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    await again.press({ key: 'min-usage' })
    expect(await again.find({ text: 'USAGE' })).toBeDefined()
    expect(await again.find({ text: /182k cached/ })).toBeDefined()
    expect(await again.find({ text: 'IDLE' })).toBeUndefined()
    await again.press({ key: 'expand-usage' })
    expect(await again.find({ text: 'IDLE' })).toBeDefined()
    await again.unmount()
  }
})

test('a cold, heavy cache says what continuing costs and what to do', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 600_000, window: 1_000_000, percent: 60 },
      rateLimits: [],
      cost: { usd: 1 },
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {})
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'hi', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
  await clock.advance(61 * 60_000)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'orbit', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /COLD/ })).toBeDefined()
    expect(await band.find({ text: /heavy: \/compact soon/ })).toBeDefined()
    expect(await band.find({ text: /Cold cache, 600k in context/ })).toBeDefined()
    await band.unmount()
  }
})
