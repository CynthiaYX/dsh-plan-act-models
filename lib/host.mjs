/**
 * Host-facing helpers extracted from `index.js` so they can be tested without a
 * running Harness (the plugin entry imports schemastery, which only resolves
 * inside a packaged Host).
 *
 * Both factories take plain accessors, never the Host context itself.
 */

import { formatRoute, MODE_ACT, MODE_PLAN } from './routing.mjs'

/**
 * Build the committed-mode reader.
 *
 * The plan-mode service is mounted inside the Agent preset with
 * `isolate: { planMode: true }`, so it lives under a realm symbol the plugin's
 * own profile-plane fiber cannot name: `ctx.get('planMode')` is always
 * `undefined` there. Two Host-sanctioned routes reach it, and the second does
 * not depend on preset internals:
 *
 * 1. `agentPresets.serviceFor(agent, 'planMode')` — the per-Agent isolated
 *    lookup the Host itself uses for preset-owned services.
 * 2. `sessionProjections.stateOf(session, 'plan')` — the `plan` projection is
 *    published on the root `sessionProjections` service.
 *
 * Failing both is a real degradation, so it is reported once rather than
 * silently routing every Plan session down the Act branch.
 *
 * @param options.agentPresets - accessor for the `agentPresets` service.
 * @param options.projections - accessor for the `sessionProjections` service.
 * @param options.warn - called once when neither source is usable.
 * @returns `(agent) => 'plan' | 'act'`
 */
export function createModeReader({ agentPresets, projections, warn }) {
  let warned = false

  function degrade(error) {
    if (warned) return
    warned = true
    const detail = error === undefined ? '' : ` (${error instanceof Error ? error.message : String(error)})`
    warn(
      '[plan-act-models] 读不到 plan 模式，所有会话将按 Act 路由；'
      + `agentPresets.serviceFor 与 sessionProjections.stateOf 都不可用${detail}`,
    )
  }

  return function modeOf(agent) {
    let failure
    try {
      const controller = agentPresets()?.serviceFor?.(agent, 'planMode')
      if (controller !== undefined && typeof controller.get === 'function') {
        return controller.get(agent)?.active === true ? MODE_PLAN : MODE_ACT
      }
    } catch (error) {
      failure = error
    }
    try {
      const state = projections()?.stateOf?.(agent?.session, 'plan')
      if (state !== undefined) return state.active === true ? MODE_PLAN : MODE_ACT
    } catch (error) {
      failure = error
    }
    degrade(failure)
    return MODE_ACT
  }
}

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
    // Fail closed as documented: an unusable catalog must not silently pass a
    // route through, because the point of the check is to surface a bad
    // configuration instead of letting the Host fall back.
    if (snapshot === null) {
      throw new Error(
        '[plan-act-models] 宿主没有提供 llm 服务，无法校验路由可用性；'
        + '请确认 llm 插件已启用，或关闭本插件。',
      )
    }
    const reason = snapshot.failed?.get(route.provider)
    const models = snapshot.providers.get(route.provider)
    if (models === undefined) {
      if (reason !== undefined) {
        throw new Error(
          `[plan-act-models] 枚举 provider「${route.provider}」的模型失败：${reason}；`
          + '请检查该 provider 的凭据与配置，或关闭本插件。',
        )
      }
      throw new Error(
        `[plan-act-models] 配置的 provider「${route.provider}」当前不可用；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选，或关闭本插件。',
      )
    }
    if (!models.has(route.model)) {
      throw new Error(
        `[plan-act-models] provider「${route.provider}」下没有模型「${route.model}」；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选，或关闭本插件。',
      )
    }
    if (route.reasoningEffort === undefined) return
    const efforts = models.get(route.model)?.efforts ?? []
    if (!efforts.some((effort) => effort.id === route.reasoningEffort)) {
      const known = efforts.map((effort) => effort.id).join(' / ') || '该模型不支持思考等级'
      throw new Error(
        `[plan-act-models] 模型「${formatRoute(route)}」不支持思考等级`
        + `「${route.reasoningEffort}」（可选：${known}）；请在设置里改选，或关闭本插件。`,
      )
    }
  }

  return { refresh, assertServable, state }
}
