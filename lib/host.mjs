/**
 * Host-facing helpers extracted from `index.js` so they can be tested without a
 * running Harness (the plugin entry imports schemastery, which only resolves
 * inside a packaged Host).
 *
 * Both factories take plain accessors, never the Host context itself.
 */

import { MODE_ACT, MODE_PLAN, formatRoute, sameSelection } from './routing.mjs'

/**
 * Build the provider/model/effort catalog used to reject unservable routes.
 *
 * One failing provider must not poison the whole catalog: providers are
 * enumerated independently, each failure is recorded per provider, and the
 * timestamp only advances once the sweep succeeded so a broken registry is
 * retried on the next request instead of blocking for the full TTL. Concurrent
 * callers share one in-flight sweep.
 *
 * @param options.llm - accessor for the `llm` service.
 * @param options.ttlMs - cache lifetime in milliseconds.
 * @returns `{ refresh, assertServable }`
 */
export function createCatalog({ llm, ttlMs = 15_000 }) {
  const state = { at: 0, providers: new Map(), failed: new Map(), error: null, inflight: undefined }

  async function sweep(service) {
    const providers = new Map()
    const failed = new Map()
    let list = []
    try {
      list = service.listProviders()
    } catch (error) {
      state.providers = providers
      state.failed = failed
      state.error = error instanceof Error ? error.message : String(error)
      return state
    }
    for (const provider of list) {
      try {
        const models = await service.listModels(provider.id)
        const table = new Map()
        for (const model of models) {
          let reasoning
          try {
            reasoning = (await service.resolveModelInfo(provider.id, model.id))?.reasoning
          } catch {
            reasoning = undefined
          }
          table.set(model.id, reasoning)
        }
        providers.set(provider.id, table)
      } catch (error) {
        failed.set(provider.id, error instanceof Error ? error.message : String(error))
      }
    }
    state.providers = providers
    state.failed = failed
    state.error = null
    state.at = Date.now()
    return state
  }

  /**
   * @returns the snapshot, or null when no `llm` service is available.
   */
  async function refresh() {
    const service = llm()
    if (service === undefined) return null
    if (state.at !== 0 && Date.now() - state.at < ttlMs) return state
    if (state.inflight !== undefined) return state.inflight
    state.inflight = sweep(service).finally(() => {
      state.inflight = undefined
    })
    return state.inflight
  }

  /**
   * Reject a route the current provider registry cannot serve.
   * @param route - normalized `{ provider, model, reasoningEffort? }`.
   */
  async function assertServable(route) {
    const snapshot = await refresh()
    // A missing catalog is not fatal any more: the switch is a convenience, and
    // the Host's own `selectModel` validates the route again before committing
    // it. Reporting "unknown" keeps the switch possible when `llm` is absent.
    if (snapshot === null) return
    const reason = snapshot.failed?.get(route.provider)
    const models = snapshot.providers.get(route.provider)
    if (models === undefined) {
      if (reason !== undefined) {
        throw new Error(
          `枚举 provider「${route.provider}」的模型失败：${reason}；`
          + '请检查该 provider 的凭据与配置。',
        )
      }
      throw new Error(
        `当前 provider「${route.provider}」不可用；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选。',
      )
    }
    if (!models.has(route.model)) {
      throw new Error(
        `provider「${route.provider}」下没有模型「${route.model}」；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选。',
      )
    }
    if (route.reasoningEffort === undefined) return
    const efforts = models.get(route.model)?.efforts ?? []
    if (!efforts.some((effort) => effort.id === route.reasoningEffort)) {
      const known = efforts.map((effort) => effort.id).join(' / ') || '该模型不支持思考等级'
      throw new Error(
        `模型「${formatRoute(route)}」不支持思考等级`
        + `「${route.reasoningEffort}」（可选：${known}）。`,
      )
    }
  }

  return { refresh, assertServable, state }
}

/**
 * The Host's committed model selection for one session.
 *
 * `modelSelection.next` is `pending ?? lastUsed`, which is exactly "the route
 * the next prompt in this session would use". Reading that value is how the
 * switcher avoids appending a duplicate `model/selection` event: selecting a
 * route the session already uses is a no-op, not a new decision.
 *
 * @param projections - accessor for the `sessionProjections` service.
 * @param session - the live session object.
 * @returns the committed selection, or null when nothing is committed yet.
 */
export function committedSelection(projections, session) {
  try {
    const state = projections()?.stateOf?.(session, 'modelSelection')
    if (state === null || typeof state !== 'object') return null
    return state.pending ?? state.lastUsed ?? null
  } catch {
    return null
  }
}

/**
 * Build the selection switcher.
 *
 * The switch is performed through the Host's own `session.selectModel` Remote
 * surface, which is the same call the native selector makes. That is deliberate:
 * the browser half, the composer chip, the durable log and the profile default
 * all follow one code path, so the dropdown can never describe a route the
 * native selector disagrees with.
 *
 * Two consequences are accepted and documented: the Host also records the
 * selection as the profile-wide default model, and a session that already has a
 * request header keeps it for the parts of the turn that already started.
 *
 * Failures never propagate. A rejected switch is a convenience lost, not a
 * request to block; the caller logs it once and the session keeps running on
 * whatever it had.
 *
 * @param options.sessionController - accessor for the `sessionController` service.
 * @param options.projections - accessor for the `sessionProjections` service.
 * @param options.assertServable - catalog check from {@link createCatalog}.
 * @param options.warn - called once per degradation class.
 * @returns `(agent, route, sessionId) => Promise<boolean>`, true when a switch
 *   was committed.
 */
export function createSwitcher({ sessionController, projections, assertServable, warn }) {
  const warned = new Set()

  function degrade(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  return async function select(agent, route, sessionId) {
    const controller = sessionController()
    if (controller === undefined || typeof controller.selectModel !== 'function') {
      degrade(
        'controller',
        '[plan-act-models] 宿主没有提供 sessionController，无法切换模型；'
        + '下拉框只能显示，请在原生模型选择器里手动改。',
      )
      return false
    }

    const session = agent?.session
    if (session !== undefined) {
      const current = committedSelection(projections, session)
      if (current !== null && sameSelection(current, route)) return false
    }

    try {
      await assertServable(route)
    } catch (error) {
      degrade(
        'catalog',
        `[plan-act-models] 不切换：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }

    try {
      await controller.selectModel({
        sessionId: sessionId ?? agent?.id,
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      })
      return true
    } catch (error) {
      degrade(
        'select',
        `[plan-act-models] 切换模型失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }
}

/** The track word for a mode id, used by diagnostics only. */
export function trackWord(mode) {
  return mode === MODE_PLAN ? 'Plan' : MODE_ACT === mode ? 'Act' : 'Act'
}
