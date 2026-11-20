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
 * @returns `{ refresh, assertServable, servableNow, state }`. `assertServable`
 *   awaits a sweep; `servableNow` answers from the last one and says "no
 *   evidence" when there has not been one yet — the switcher cannot wait, so it
 *   uses that answer and lets the Host re-validate on the way through.
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
   * Why a snapshot cannot serve a route, or null when it can.
   *
   * Split out of {@link assertServable} so the switcher can ask the same
   * question synchronously: the switch has to land before the next step fixes
   * its selection, and awaiting a sweep there would lose the race again.
   *
   * @param route - normalized `{ provider, model, reasoningEffort? }`.
   * @param snapshot - a catalog state from {@link createCatalog}.
   * @returns the user-facing reason, or null when the route is servable.
   */
  function diagnosis(route, snapshot) {
    const reason = snapshot.failed?.get(route.provider)
    const models = snapshot.providers.get(route.provider)
    if (models === undefined) {
      if (reason !== undefined) {
        return `枚举 provider「${route.provider}」的模型失败：${reason}；`
          + '请检查该 provider 的凭据与配置。'
      }
      return `当前 provider「${route.provider}」不可用；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选。'
    }
    if (!models.has(route.model)) {
      return `provider「${route.provider}」下没有模型「${route.model}」；`
        + '请在“设置 → 双轨 · Plan / Act 模型”里改选。'
    }
    if (route.reasoningEffort === undefined) return null
    const efforts = models.get(route.model)?.efforts ?? []
    if (efforts.some((effort) => effort.id === route.reasoningEffort)) return null
    const known = efforts.map((effort) => effort.id).join(' / ') || '该模型不支持思考等级'
    return `模型「${formatRoute(route)}」不支持思考等级`
      + `「${route.reasoningEffort}」（可选：${known}）。`
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
    const reason = diagnosis(route, snapshot)
    if (reason !== null) throw new Error(reason)
  }

  /**
   * The same verdict, without touching the network.
   *
   * Three answers, because "we have not looked yet" is not "it is broken":
   * `null` means the last successful sweep proved the route servable, a string
   * is the reason it cannot be served, and `undefined` means no sweep has ever
   * succeeded, so there is no evidence either way. A route whose only doubt is
   * the missing evidence is switched optimistically and validated by the Host's
   * own `selectModel`, which is exactly what the user asked for by approving a
   * plan: a route that is very likely fine must not cost a step on the wrong
   * model to prove it.
   *
   * @param route - normalized `{ provider, model, reasoningEffort? }`.
   * @returns null when servable, a reason string when not, undefined when unknown.
   */
  function servableNow(route) {
    if (state.at === 0) return undefined
    return diagnosis(route, state)
  }

  return { refresh, assertServable, servableNow, state }
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
 * The *timing* is the part that has to be right, and it changed under us. Since
 * the 0.2.x loop, `preStep` fixes the step's model before any listener runs
 * (`const selection = this.model.current()`), and `prepareRequest` throws if
 * anything proposes a different route afterwards. `agent.model.select()` itself
 * is synchronous, but `sessionController.selectModel` is not: it enumerates
 * providers and resolves the call config first. So the switch is split in two:
 * commit the selection synchronously, then let the Host's own path validate and
 * persist it. Without that split the next step announces itself with the old
 * model and the new one arrives a second later, which is exactly the bug.
 *
 * One consequence is accepted and documented: the Host also records the
 * selection as the profile-wide default model.
 *
 * Failures never propagate. A rejected switch is a convenience lost, not a
 * request to block; the caller logs it once and the session keeps running on
 * whatever it had. A switch rejected *after* the optimistic commit is undone,
 * unless a newer decision already replaced it.
 *
 * @param options.sessionController - accessor for the `sessionController` service.
 * @param options.projections - accessor for the `sessionProjections` service.
 * @param options.servableNow - synchronous catalog verdict from {@link createCatalog}.
 * @param options.warm - accessor that refreshes the catalog in the background.
 * @param options.warn - called once per degradation class.
 * @returns `(agent, route, sessionId) => Promise<boolean>`, true when a switch
 *   was committed. The selection is already committed by the time the returned
 *   promise is created.
 */
export function createSwitcher({ sessionController, projections, servableNow, warm, warn }) {
  const warned = new Set()

  function degrade(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  function request(route, sessionId, agent) {
    return {
      sessionId: sessionId ?? agent?.id,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    }
  }

  /**
   * Commit the route now, before the step that will use it is prepared.
   *
   * Only this Host generation exposes `agent.model`; an older one keeps the
   * previous asynchronous behaviour, where the switch lands whenever the Host's
   * own path gets to it.
   *
   * @returns the selection to restore on failure, or null when nothing was
   *   committed synchronously.
   */
  function commitNow(agent, route) {
    const model = agent?.model
    if (model === undefined || typeof model.select !== 'function') return null
    let previous = null
    if (typeof model.current === 'function') {
      try {
        previous = model.current() ?? null
      } catch {
        previous = null
      }
    }
    model.select({ ...route })
    return { previous }
  }

  /**
   * Put the previous selection back after the Host rejected the switch.
   *
   * A newer decision that already replaced ours wins: reverting would undo a
   * choice the user made in the meantime.
   */
  function undoSync(agent, applied, route) {
    if (applied === null) return
    const session = agent?.session
    if (session !== undefined) {
      const current = committedSelection(projections, session)
      if (current !== null && !sameSelection(current, route)) return
    }
    // A cold session has no recorded selection to restore; leaving the rejected
    // route in place would break the next request, so it is reported instead.
    if (applied.previous === null) return
    try {
      agent.model.select({ ...applied.previous })
    } catch {
      // Reverting is best effort: the warning below already names the failure.
    }
  }

  return function select(agent, route, sessionId) {
    const controller = sessionController()
    if (controller === undefined || typeof controller.selectModel !== 'function') {
      degrade(
        'controller',
        '[plan-act-models] 宿主没有提供 sessionController，无法切换模型；'
        + '下拉框只能显示，请在原生模型选择器里手动改。',
      )
      return Promise.resolve(false)
    }

    const session = agent?.session
    if (session !== undefined) {
      const current = committedSelection(projections, session)
      if (current !== null && sameSelection(current, route)) return Promise.resolve(false)
    }

    // Everything above and below this comment runs in the caller's turn, before
    // the promise the caller ignores settles, which is what makes the switch
    // visible to the step that is already being prepared.
    if (typeof servableNow === 'function') {
      let verdict
      try {
        verdict = servableNow(route)
      } catch {
        verdict = undefined
      }
      if (typeof verdict === 'string') {
        degrade('catalog', `[plan-act-models] 不切换：${verdict}`)
        return Promise.resolve(false)
      }
    }
    const applied = commitNow(agent, route)
    // Keep the evidence fresh for the next switch without making this one wait.
    if (typeof warm === 'function') {
      try {
        Promise.resolve(warm()).catch(() => {})
      } catch {
        // A catalog that cannot be refreshed only costs the next switch its
        // pre-check; the Host validates the route again anyway.
      }
    }

    return (async () => {
      try {
        await controller.selectModel(request(route, sessionId, agent))
        return true
      } catch (error) {
        undoSync(agent, applied, route)
        degrade(
          'select',
          `[plan-act-models] 切换模型失败：${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      }
    })()
  }
}

/** The track word for a mode id, used by diagnostics only. */
export function trackWord(mode) {
  return mode === MODE_PLAN ? 'Plan' : MODE_ACT === mode ? 'Act' : 'Act'
}
