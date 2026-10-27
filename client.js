window.__ModuleLoader__.load({
  id: 'dsh-plan-act-models',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const ENTRY = 'plan-act-models'
    const FALLBACK = 'rgba(127, 127, 127, 0.45)'
    // Host tokens only: `--dsw-alias-text-secondary` and friends do not exist,
    // so the settings page used to paint itself with these grey fallbacks.
    const muted = 'var(--dsw-alias-label-secondary, #8b8b8b)'
    const danger = 'var(--dsw-alias-state-error-primary, #d14343)'
    const border = `1px solid var(--dsw-alias-border-l2, ${FALLBACK})`
    const radius = '10px'

    const control = {
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'inherit',
      border,
      borderRadius: radius,
      padding: '4px 8px',
      font: 'inherit',
      minWidth: 0,
    }

    const EMPTY_ROUTE = { provider: '', model: '', reasoningEffort: '' }

    function routeOf(value) {
      const route = value && typeof value === 'object' ? value : EMPTY_ROUTE
      return {
        provider: typeof route.provider === 'string' ? route.provider : '',
        model: typeof route.model === 'string' ? route.model : '',
        reasoningEffort: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
      }
    }

    function draftOf(value) {
      const source = value && typeof value === 'object' ? value : {}
      const projects = {}
      const raw = source.projects && typeof source.projects === 'object' ? source.projects : {}
      for (const key of Object.keys(raw)) {
        const entry = raw[key] && typeof raw[key] === 'object' ? raw[key] : {}
        projects[key] = {
          mode: entry.mode === 'override' || entry.mode === 'off' ? entry.mode : 'inherit',
          plan: routeOf(entry.plan),
          act: routeOf(entry.act),
        }
      }
      return {
        enabled: source.enabled === true,
        plan: routeOf(source.plan),
        act: routeOf(source.act),
        projects,
      }
    }

    function complete(route) {
      return route.provider.trim() !== '' && route.model.trim() !== ''
    }

    function routeError(route, label) {
      if (!complete(route)) return `${label} 需要同时选择 provider 与 model`
      return null
    }

    function toPayload(route) {
      const out = { provider: route.provider.trim(), model: route.model.trim() }
      const effort = route.reasoningEffort.trim()
      if (effort !== '') out.reasoningEffort = effort
      return out
    }

    function samevalue(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    // #region plan-act-view — test/client-view.test.mjs extracts this block verbatim
    //
    // The composer chip has to answer "which route would the next request use"
    // in the browser, while the Host answers the same question in
    // `lib/routing.mjs` with `resolveTarget`. The bundle cannot import `lib/`
    // (it is a classic script served to the page), so the decision table is
    // mirrored here. Every function below is self-contained so the test can
    // evaluate the region with `new Function` and compare it against the real
    // `resolveTarget` over an input matrix — a one-sided edit fails the suite.

    /** Full-width colon: the chip reads `模式：模型`. */
    const LABEL_SEPARATOR = '：'
    const MODE_WORDS = { plan: 'Plan', act: 'Act' }

    function mirrorUnref(value) {
      if (value === null || value === undefined) return value
      if (typeof value !== 'object' && typeof value !== 'function') return value
      if (typeof value.get === 'function') {
        try {
          return mirrorUnref(value.get())
        } catch {
          return undefined
        }
      }
      if (typeof value === 'function') return mirrorUnref(value())
      if (Object.prototype.hasOwnProperty.call(value, 'value') && typeof value.get !== 'function') {
        return mirrorUnref(value.value)
      }
      return value
    }

    function mirrorText(value) {
      return typeof value === 'string' ? value.trim() : ''
    }

    function mirrorRoute(input) {
      const value = mirrorUnref(input)
      if (value === null || typeof value !== 'object') return null
      const provider = mirrorText(value.provider)
      const model = mirrorText(value.model)
      if (provider === '' || model === '') return null
      const effort = mirrorText(value.reasoningEffort)
      return effort === '' ? { provider, model } : { provider, model, reasoningEffort: effort }
    }

    function mirrorKey(path) {
      const raw = mirrorText(path)
      if (raw === '') return ''
      return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    function mirrorMode(entry) {
      const value = mirrorUnref(entry)
      if (value === null || typeof value !== 'object') return 'inherit'
      const mode = mirrorText(value.mode)
      return mode === 'override' || mode === 'off' ? mode : 'inherit'
    }

    function mirrorFindProject(projects, path) {
      const table = mirrorUnref(projects)
      const want = mirrorKey(path)
      if (want === '' || table === null || typeof table !== 'object') return null
      for (const key of Object.keys(table)) {
        if (mirrorKey(key) === want) return { key, entry: mirrorUnref(table[key]) }
      }
      return null
    }

    /** Browser twin of `resolveTarget`: `{ kind, route, scope, projectKey }`. */
    function mirrorResolve(config, path, mode) {
      const hit = mirrorFindProject(config?.projects, path)
      const entryMode = hit === null ? 'inherit' : mirrorMode(hit.entry)
      const scope = hit === null || entryMode === 'inherit' ? 'global' : 'project'
      const key = hit === null ? null : hit.key

      if (entryMode === 'off') return { kind: 'off', scope: 'project', projectKey: key }

      const source = entryMode === 'override' ? mirrorUnref(hit.entry)[mode] : mirrorUnref(config?.[mode])
      const route = mirrorRoute(source)
      if (route === null) return { kind: 'invalid', scope, projectKey: key }
      return { kind: 'route', route, scope, projectKey: key }
    }

    /**
     * Browser twin of `sameTrack`: a configured route that leaves the effort
     * empty follows the model default, and the Host writes that default back
     * into the committed selection, so an empty configured effort matches any.
     */
    function mirrorSameTrack(selection, wanted) {
      const current = mirrorRoute(selection)
      const target = mirrorRoute(wanted)
      if (current === null || target === null) return false
      if (current.provider !== target.provider || current.model !== target.model) return false
      if (target.reasoningEffort === undefined) return true
      return current.reasoningEffort === target.reasoningEffort
    }

    /**
     * Browser twin of `sessionTrack`: which track the committed selection sits
     * on, or null when it is neither (`mode` only breaks a tie).
     */
    function mirrorTrackOf(selection, config, path, mode) {
      const current = mirrorRoute(selection)
      if (current === null) return null
      const plan = mirrorResolve(config, path, 'plan')
      const act = mirrorResolve(config, path, 'act')
      const onPlan = plan.kind === 'route' && mirrorSameTrack(current, plan.route)
      const onAct = act.kind === 'route' && mirrorSameTrack(current, act.route)
      if (onPlan && onAct) return mode === 'plan' ? 'plan' : 'act'
      if (onPlan) return 'plan'
      if (onAct) return 'act'
      return null
    }

    /** Display name of a route's model, falling back to its id. */
    function routeName(catalog, route) {
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const group = groups.find((item) => item?.id === route.provider)
      const models = Array.isArray(group?.models) ? group.models : []
      const found = models.find((item) => item?.id === route.model)
      const name = found?.name
      return typeof name === 'string' && name.trim() !== '' ? name : route.model
    }

    /**
     * The option text: `模式：模型`.
     * @param track - `plan` | `act`
     * @param resolved - {@link mirrorResolve} result for that track
     * @param catalog - model catalog, or null while it is still loading
     */
    function routeLabel(track, resolved, catalog) {
      const word = MODE_WORDS[track] ?? MODE_WORDS.act
      if (resolved === null || resolved === undefined) return `${word}${LABEL_SEPARATOR}未配置`
      if (resolved.kind === 'off') return `${word}${LABEL_SEPARATOR}此项目已停用`
      if (resolved.kind !== 'route') return `${word}${LABEL_SEPARATOR}未配置`
      return `${word}${LABEL_SEPARATOR}${routeName(catalog, resolved.route)}`
    }

    /**
     * The text of the placeholder option: whatever the session is on when that
     * is neither configured track — a model the user picked in the native
     * selector. It is shown, never offered.
     */
    function customLabel(selection, catalog) {
      const route = mirrorRoute(selection)
      if (route === null) return `自定义${LABEL_SEPARATOR}未选择`
      return `自定义${LABEL_SEPARATOR}${routeName(catalog, route)}`
    }

    /** `provider/model (effort) · scope` — the ids that actually cross the wire. */
    function routeDetail(resolved) {
      if (resolved?.kind !== 'route') return null
      const route = resolved.route
      const effort = route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`
      const scope = resolved.scope === 'project' ? `项目覆盖：${resolved.projectKey}` : '全局配置'
      return `${route.provider}/${route.model}${effort} · ${scope}`
    }

    /** Hover text for an option: its label, then where the route comes from. */
    function routeTitle(track, resolved, catalog) {
      const label = routeLabel(track, resolved, catalog)
      const detail = routeDetail(resolved)
      return detail === null ? label : `${label} — ${detail}`
    }

    /** Hover text for the placeholder option. */
    function customTitle(selection) {
      const route = mirrorRoute(selection)
      if (route === null) return `自定义 — 当前会话还没有选定模型`
      const effort = route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`
      return `自定义 — ${route.provider}/${route.model}${effort}`
    }
    // #endregion plan-act-view

    function Row({ label, children, hint }) {
      return React.createElement(
        'label',
        { style: { display: 'grid', gap: 4, fontSize: 13 } },
        React.createElement('span', { style: { color: muted } }, label),
        children,
        hint ? React.createElement('span', { style: { color: muted, fontSize: 11 } }, hint) : null,
      )
    }

    function RouteEditor({ title, catalog, route, onChange, disabled }) {
      const groups = catalog?.groups ?? []
      const models = useMemo(
        () => groups.find((group) => group.id === route.provider)?.models ?? [],
        [groups, route.provider],
      )
      const efforts = useMemo(() => {
        const found = models.find((model) => model.id === route.model)
        return found?.reasoning?.efforts ?? []
      }, [models, route.model])

      return React.createElement(
        'div',
        { style: { display: 'grid', gap: 8, padding: 12, border, borderRadius: radius } },
        React.createElement('strong', { style: { fontSize: 13 } }, title),
        React.createElement(
          Row,
          { label: 'Provider' },
          React.createElement(
            'select',
            {
              style: control,
              value: route.provider,
              disabled,
              onChange: (event) => {
                const provider = event.target.value
                const nextModels = groups.find((group) => group.id === provider)?.models ?? []
                onChange({
                  provider,
                  model: nextModels.some((model) => model.id === route.model)
                    ? route.model
                    : nextModels[0]?.id ?? '',
                  reasoningEffort: '',
                })
              },
            },
            React.createElement('option', { value: '' }, '（未选择）'),
            groups.map((group) =>
              React.createElement('option', { key: group.id, value: group.id }, group.name || group.id),
            ),
          ),
        ),
        React.createElement(
          Row,
          { label: 'Model' },
          React.createElement(
            'select',
            {
              style: control,
              value: route.model,
              disabled,
              onChange: (event) => onChange({ ...route, model: event.target.value, reasoningEffort: '' }),
            },
            React.createElement('option', { value: '' }, '（未选择）'),
            models.map((model) =>
              React.createElement('option', { key: model.id, value: model.id }, model.name || model.id),
            ),
          ),
        ),
        React.createElement(
          Row,
          { label: '思考复杂度', hint: efforts.length === 0 ? '该模型未声明思考等级' : undefined },
          React.createElement(
            'select',
            {
              style: control,
              value: route.reasoningEffort,
              disabled: disabled || efforts.length === 0,
              onChange: (event) => onChange({ ...route, reasoningEffort: event.target.value }),
            },
            React.createElement('option', { value: '' }, '跟随模型默认'),
            efforts.map((effort) =>
              React.createElement('option', { key: effort.id, value: effort.id }, effort.name || effort.id),
            ),
          ),
        ),
      )
    }

    function RouterSection(props) {
      const { form } = props
      const [snapshot, setSnapshot] = useState(() => form?.getSnapshot?.())
      const [catalog, setCatalog] = useState(null)
      const [catalogError, setCatalogError] = useState(null)
      const [draft, setDraft] = useState(() => draftOf(snapshot?.value))
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [newPath, setNewPath] = useState('')

      useEffect(() => {
        if (!form?.subscribe) return undefined
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])

      useEffect(() => {
        const next = draftOf(snapshot?.value)
        setDraft((current) => (samevalue(current, next) ? current : next))
      }, [snapshot?.value])

      useEffect(() => {
        let cancelled = false
        const remote = props.remote
        if (!remote?.session?.modelCatalog) {
          setCatalogError('当前宿主没有提供模型目录接口，只能手动填写。')
          return undefined
        }
        remote.session
          .modelCatalog()
          .then((response) => {
            if (cancelled) return
            if (!response?.ok) {
              setCatalogError(
                `${response?.error?.code ?? 'REMOTE'}: ${response?.error?.message ?? '模型目录不可用'}`,
              )
              return
            }
            setCatalog(response.value)
          })
          .catch((error) => {
            if (!cancelled) setCatalogError(error?.message ?? String(error))
          })
        return () => {
          cancelled = true
        }
      }, [props.remote])

      const routes = useMemo(() => {
        const found = [routeError(draft.plan, 'Plan 路由'), routeError(draft.act, 'Act 路由')]
        // A project set to `override` replaces the global pair wholesale, so an
        // incomplete override would block every request in that project. The
        // Host cannot catch this: it validates shape, not cross-field intent.
        for (const [key, entry] of Object.entries(draft.projects ?? {})) {
          if (entry?.mode !== 'override') continue
          found.push(routeError(entry.plan, `项目「${key}」的 Plan 路由`))
          found.push(routeError(entry.act, `项目「${key}」的 Act 路由`))
        }
        return found.filter(Boolean)
      }, [draft.plan, draft.act, draft.projects])

      const blocked = draft.enabled && routes.length > 0

      const save = useCallback(async () => {
        if (!form?.mutate) return
        if (blocked) {
          setMessage(routes.join('；'))
          return
        }
        setBusy(true)
        setMessage(null)
        const value = {
          enabled: draft.enabled,
          plan: toPayload(draft.plan),
          act: toPayload(draft.act),
          projects: Object.fromEntries(
            Object.entries(draft.projects).map(([key, entry]) => [
              key,
              {
                mode: entry.mode,
                plan: toPayload(entry.plan),
                act: toPayload(entry.act),
              },
            ]),
          ),
        }
        const ok = await form.mutate(
          [{ op: 'set', path: [], value }],
          snapshot?.revision,
        )
        setBusy(false)
        setMessage(
          ok
            ? '已保存。下拉框里的两项立即按新配置显示；自动切换在下一个事件生效。'
            : '保存失败（可能是配置已被改动）。已重新载入最新值，请再试一次。',
        )
      }, [blocked, draft, form, routes, snapshot?.revision])

      if (!form) {
        return React.createElement('div', { style: { padding: 16 } }, '配置入口不可用。')
      }
      if (snapshot?.status === 'loading' || snapshot?.status === undefined) {
        return React.createElement('div', { style: { padding: 16, color: muted } }, '正在读取配置…')
      }
      if (snapshot?.status === 'unavailable') {
        // The Host does not serve this namespace: the Loader row is missing or
        // inactive, so writing would go nowhere. Say which, not just "failed".
        return React.createElement(
          'div',
          { style: { padding: 16, color: danger, display: 'grid', gap: 6 } },
          React.createElement('strong', null, `宿主没有提供配置项「${ENTRY}」`),
          React.createElement(
            'span',
            { style: { fontSize: 12, color: muted } },
            '本插件的 Loader 行未启用或未加载；重启应用后若仍如此，请检查 profile 里的插件安装。',
          ),
        )
      }
      if (snapshot?.status === 'error') {
        return React.createElement(
          'div',
          { style: { padding: 16, color: danger } },
          `读取配置失败：${snapshot.error?.message ?? '未知错误'}`,
        )
      }

      const projectEntries = Object.entries(draft.projects)

      return React.createElement(
        'section',
        { style: { display: 'grid', gap: 16, padding: 16, maxWidth: 720, fontSize: 14 } },
        React.createElement(
          'header',
          { style: { display: 'grid', gap: 4 } },
          React.createElement('h2', { style: { margin: 0, fontSize: 18 } }, '双轨 · Plan / Act 模型'),
          React.createElement(
            'p',
            { style: { margin: 0, color: muted, fontSize: 12 } },
            '这两组路由是「模式下拉框」的两项。输入框旁的下拉框始终可用，手动选择随时生效；',
            '下面的开关只控制自动切换：进入 Plan 模式时自动选 Plan，批准计划后强制选 Act。',
          ),
        ),
        React.createElement(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('input', {
            type: 'checkbox',
            checked: draft.enabled,
            onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
          }),
          React.createElement('span', null, '启用自动切换（下拉框手选不受影响）'),
        ),
        blocked
          ? React.createElement('div', { style: { color: danger, fontSize: 12 } }, routes.join('；'))
          : null,
        catalogError
          ? React.createElement('div', { style: { color: danger, fontSize: 12 } }, catalogError)
          : null,
        React.createElement(RouteEditor, {
          title: 'Plan 模式',
          catalog,
          route: draft.plan,
          disabled: false,
          onChange: (route) => setDraft({ ...draft, plan: route }),
        }),
        React.createElement(RouteEditor, {
          title: 'Act 模式',
          catalog,
          route: draft.act,
          disabled: false,
          onChange: (route) => setDraft({ ...draft, act: route }),
        }),
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 8 } },
          React.createElement('strong', { style: { fontSize: 13 } }, '项目覆盖'),
          React.createElement(
            'p',
            { style: { margin: 0, color: muted, fontSize: 12 } },
            '按工作区根目录覆盖；未列出的项目继承全局配置。留空的 provider/model 视为不完整。',
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement('input', {
              style: { ...control, flex: 1 },
              placeholder: '工作区绝对路径，例如 D:\\work\\repo',
              value: newPath,
              onChange: (event) => setNewPath(event.target.value),
            }),
            React.createElement(
              'button',
              {
                style: control,
                type: 'button',
                onClick: () => {
                  const key = newPath.trim()
                  if (key === '' || draft.projects[key] !== undefined) return
                  setDraft({
                    ...draft,
                    projects: {
                      ...draft.projects,
                      [key]: { mode: 'inherit', plan: { ...draft.plan }, act: { ...draft.act } },
                    },
                  })
                },
              },
              '添加',
            ),
          ),
          projectEntries.length === 0
            ? React.createElement('span', { style: { color: muted, fontSize: 12 } }, '暂无项目覆盖')
            : projectEntries.map(([key, entry]) =>
                React.createElement(
                  'div',
                  {
                    key,
                    style: { display: 'grid', gap: 8, padding: 12, border, borderRadius: radius },
                  },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    React.createElement('code', { style: { flex: 1, fontSize: 12, wordBreak: 'break-all' } }, key),
                    React.createElement(
                      'select',
                      {
                        style: control,
                        value: entry.mode,
                        onChange: (event) =>
                          setDraft({
                            ...draft,
                            projects: {
                              ...draft.projects,
                              [key]: { ...entry, mode: event.target.value },
                            },
                          }),
                      },
                      React.createElement('option', { value: 'inherit' }, '继承全局'),
                      React.createElement('option', { value: 'override' }, '项目覆盖'),
                      React.createElement('option', { value: 'off' }, '此项目禁用'),
                    ),
                    React.createElement(
                      'button',
                      {
                        style: control,
                        type: 'button',
                        onClick: () => {
                          const next = { ...draft.projects }
                          delete next[key]
                          setDraft({ ...draft, projects: next })
                        },
                      },
                      '移除',
                    ),
                  ),
                  entry.mode === 'override'
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(RouteEditor, {
                          title: 'Plan 模式（本项目）',
                          catalog,
                          route: entry.plan,
                          onChange: (route) =>
                            setDraft({
                              ...draft,
                              projects: { ...draft.projects, [key]: { ...entry, plan: route } },
                            }),
                        }),
                        React.createElement(RouteEditor, {
                          title: 'Act 模式（本项目）',
                          catalog,
                          route: entry.act,
                          onChange: (route) =>
                            setDraft({
                              ...draft,
                              projects: { ...draft.projects, [key]: { ...entry, act: route } },
                            }),
                        }),
                      )
                    : null,
                ),
              ),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...control, cursor: 'pointer' },
              disabled: busy,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          snapshot?.writable === false
            ? React.createElement('span', { style: { color: danger, fontSize: 12 } }, '当前配置只读')
            : null,
        ),
        message
          ? React.createElement(
              'div',
              { style: { fontSize: 12, color: message.startsWith('已保存') ? muted : danger } },
              message,
            )
          : null,
      )
    }

    const CHIP_ID = 'plan-act-route'
    const CHIP_ORDER = 100
    const CHIP_STYLE_ID = 'dsh-plan-act-models/chip.css'

    /**
     * The chip's own stylesheet.
     *
     * Injected from the factory (not from this file's top level) because a
     * classic script's top-level side effects run at *arrival*, while the client
     * module system only tolerates effects at *materialization* — it claims the
     * `<style>` tags a factory added (`claimStyles`) for HMR bookkeeping.
     *
     * Every declaration rides a `--dsw-*` host token and keeps a literal
     * fallback, so a Host that ever renames a token degrades to a plain chip
     * instead of an invisible one. The mode word carries the colour (Plan blue,
     * Act green) and the model name stays in the quieter text tone, which is
     * what makes the two entries readable at a glance.
     */
    const CHIP_CSS = `
.pam-chip{position:relative;display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0;max-width:min(240px,42cqw);white-space:nowrap;color:var(--dsw-alias-label-primary,currentColor)}
.pam-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:0;height:28px;min-width:0;max-width:100%;margin:0;padding:0 8px 0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.45));border-radius:999px;background:var(--dsw-specific-selector,var(--dsw-alias-bg-layer-1,transparent));color:inherit;font:inherit;font-size:13px;font-weight:500;line-height:20px;text-align:left;cursor:pointer;outline:none}
.pam-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12)))}
.pam-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(127,127,127,0.5))}
.pam-trigger:disabled{opacity:.45;cursor:default}
.pam-trigger[data-open="true"]{border-color:var(--dsw-alias-border-l4,var(--dsw-alias-border-l3,rgba(127,127,127,0.5)))}
.pam-trigger[data-tone="custom"]{border-style:dashed;color:var(--dsw-alias-label-secondary,currentColor)}
.pam-dot{flex:none;width:6px;height:6px;margin-right:5px;border-radius:50%;background:currentColor}
.pam-mode{flex:none;font-weight:600}
.pam-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,currentColor)}
.pam-chevron{flex:none;margin-left:4px;color:var(--dsw-alias-label-caption,currentColor);transition:transform .12s ease}
.pam-trigger[data-open="true"] .pam-chevron{transform:rotate(180deg)}
.pam-trigger[data-tone="plan"] .pam-mode,.pam-option[data-tone="plan"] .pam-mode{color:var(--dsw-alias-state-business-primary,#247bbf)}
.pam-trigger[data-tone="plan"] .pam-dot{background:var(--dsw-alias-state-business-primary,#247bbf)}
.pam-trigger[data-tone="act"] .pam-mode,.pam-option[data-tone="act"] .pam-mode{color:var(--dsw-alias-state-success-primary,#22a05b)}
.pam-trigger[data-tone="act"] .pam-dot{background:var(--dsw-alias-state-success-primary,#22a05b)}
.pam-trigger[data-tone="custom"] .pam-mode,.pam-option[data-tone="custom"] .pam-mode{color:var(--dsw-alias-label-tertiary,currentColor)}
.pam-trigger[data-tone="custom"] .pam-dot{opacity:.5}
.pam-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;display:flex;flex-direction:column;gap:2px;width:min(280px,calc(100vw - 32px));max-height:min(320px,60vh);overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.45));border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#1b1b1c));box-shadow:0 12px 32px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.12);color:var(--dsw-alias-label-primary,currentColor)}
.pam-option{display:flex;align-items:center;gap:0;width:100%;min-height:34px;margin:0;padding:6px 8px;border:none;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;white-space:nowrap;cursor:pointer}
.pam-option:hover:not(:disabled),.pam-option[data-active="true"]:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12))}
.pam-option:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3,rgba(127,127,127,0.5))}
.pam-option:disabled{cursor:default}
.pam-option:disabled:not([data-tone="custom"]){opacity:.45}
.pam-check{flex:none;display:grid;place-items:center;width:14px;height:14px;margin-right:6px;color:var(--dsw-alias-label-secondary,currentColor)}
.pam-option[data-tone="plan"] .pam-check{color:var(--dsw-alias-state-business-primary,#247bbf)}
.pam-option[data-tone="act"] .pam-check{color:var(--dsw-alias-state-success-primary,#22a05b)}
.pam-check--hidden{visibility:hidden}
.pam-failure{font-size:11px;color:var(--dsw-alias-state-error-primary,#d14343);max-width:220px;overflow:hidden;text-overflow:ellipsis}
@container (width<=460px){.pam-model{max-width:110px}}
`

    let chipStylesInstalled = false

    /**
     * Add the chip stylesheet once per page.
     *
     * Idempotent across HMR re-materialization: the tag carries
     * `data-plugin-css`, which is both the client module system's bookkeeping
     * key and the query this function uses to detect an earlier install.
     * A missing `document` (tests, SSR) is simply a no-op.
     */
    function ensureChipStyles() {
      if (chipStylesInstalled) return
      if (typeof document === 'undefined') return
      const head = document.head
      if (head === undefined || head === null || typeof head.appendChild !== 'function') return
      const selector = `style[data-plugin-css=${JSON.stringify(CHIP_STYLE_ID)}]`
      if (typeof document.querySelector === 'function' && document.querySelector(selector) !== null) {
        chipStylesInstalled = true
        return
      }
      if (typeof document.createElement !== 'function') return
      const tag = document.createElement('style')
      if (tag.dataset !== undefined && tag.dataset !== null) {
        tag.dataset.plugin = 'dsh-plan-act-models'
        tag.dataset.pluginCss = CHIP_STYLE_ID
      }
      tag.textContent = CHIP_CSS
      head.appendChild(tag)
      chipStylesInstalled = true
    }

    /**
     * Split `模式：模型` into the coloured mode word and the rest.
     *
     * The two halves are separate spans so the mode word can carry the accent
     * colour while the model name stays quiet and ellipsizes; back-to-back they
     * still spell the exact label the Host-side tests assert.
     * @param props.text - a `routeLabel`/`customLabel` result.
     */
    function LabelParts(props) {
      const text = props.text
      const at = text.indexOf(LABEL_SEPARATOR)
      const mode = at < 0 ? text : text.slice(0, at)
      const rest = at < 0 ? '' : text.slice(at)
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('span', { key: 'mode', className: 'pam-mode' }, mode),
        rest === '' ? null : React.createElement('span', { key: 'model', className: 'pam-model' }, rest),
      )
    }

    /** The 12px chevron the native selector uses, so the two read as one row. */
    function ChipChevron() {
      return React.createElement(
        'svg',
        {
          className: 'pam-chevron',
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
        },
        React.createElement('path', {
          d: 'M3 4.5L6 7.5L9 4.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function ChipCheck() {
      return React.createElement(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          d: 'M3.5 8.5L6.5 11.5L12.5 4.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * The mode dropdown beside the native model selector.
     *
     * Choosing an entry calls the Host's own `session.selectModel`, exactly what
     * the native selector does, so the two controls can never disagree and the
     * choice survives a restart through the `model/selection` projection.
     *
     * The displayed track is derived from the *committed* selection rather than
     * from plan mode, which is what makes the control honest: after a hand-pick
     * that matches neither configured route it shows `自定义：<model>` instead of
     * claiming a track the session is not on.
     *
     * The control is a button plus a hand-rolled listbox rather than a native
     * `<select>`: the platform popup cannot be themed, which is what made the
     * earlier version look like a stray OS widget inside the composer. It stays
     * dependency-free — `react` only — so keep keyboard handling complete
     * (open, move, commit, dismiss) whenever this is touched.
     */
    function RouteSelect(props) {
      const { form, loadCatalog, select, canSelect } = props
      const [snapshot, setSnapshot] = useState(() => form?.getSnapshot?.())
      const [catalog, setCatalog] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const [open, setOpen] = useState(false)
      // Index into `options` (not a track name): the placeholder is a row too, and
      // the keyboard has to be able to walk past it without selecting it.
      const [active, setActive] = useState(null)
      const rootRef = useRef(null)

      const plan = typeof props.useProjection === 'function' ? props.useProjection('plan') : undefined
      const selection =
        typeof props.useProjection === 'function'
          ? props.useProjection('modelSelection')
          : undefined
      const row =
        typeof props.useSessions === 'function'
          ? props.useSessions((state) =>
              props.sessionId === undefined ? undefined : state?.byId?.[props.sessionId],
            )
          : undefined

      useEffect(() => {
        if (!form?.subscribe) return undefined
        return form.subscribe(() => setSnapshot(form.getSnapshot()))
      }, [form])

      // A menu that stays open while the pointer is somewhere else is a trap:
      // close on any pointer press outside the chip, like the native selector.
      useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined
        }
        const away = (event) => {
          const root = rootRef.current
          if (root !== null && typeof root.contains === 'function' && root.contains(event?.target)) return
          setOpen(false)
          setActive(null)
        }
        document.addEventListener('pointerdown', away)
        return () => document.removeEventListener('pointerdown', away)
      }, [open])

      useEffect(() => {
        let cancelled = false
        const task = typeof loadCatalog === 'function' ? loadCatalog() : null
        Promise.resolve(task).then((value) => {
          if (!cancelled && value !== null) setCatalog(value)
        })
        return () => {
          cancelled = true
        }
      }, [loadCatalog])

      // Subagent sessions are never switched by the Host half, so a control
      // there would describe a decision nobody makes.
      if (props.sessionId === undefined) return null
      if (row?.origin === 'subagent' || row?.parentId !== undefined) return null
      // Nothing to say while the settings mirror has not resolved yet; the
      // composer must not flicker a wrong route into place.
      if (snapshot?.status !== 'ready') return null

      const value = snapshot.value ?? {}
      const enabled = value.enabled === true
      const mode = plan?.active === true ? 'plan' : 'act'
      const cwd = row?.cwd ?? ''
      const committed = selection?.next ?? selection?.lastUsed ?? null
      const track = mirrorTrackOf(committed, value, cwd, mode)

      const targets = {
        plan: mirrorResolve(value, cwd, 'plan'),
        act: mirrorResolve(value, cwd, 'act'),
      }
      // An entry is offered only when it names a route the Host can switch to; an
      // incomplete one or a disabled project is shown but not selectable, so the
      // option still explains itself instead of vanishing.
      const offerable = (name) => targets[name].kind === 'route' && canSelect === true
      const label = track === null ? customLabel(committed, catalog) : routeLabel(track, targets[track], catalog)
      // Say why the control is inert instead of letting a pick fail. `canSelect`
      // is false only when the Host has no `session.selectModel` at all.
      const reason =
        canSelect !== true ? ' · 宿主不支持切换模型' : enabled ? '' : ' · 自动切换已关闭'
      const title = `${track === null ? customTitle(committed) : routeTitle(track, targets[track], catalog)}${reason}`

      function choose(name) {
        if (name === track) return undefined
        const target = targets[name]
        if (target?.kind !== 'route' || canSelect !== true) return undefined
        const route = target.route
        setBusy(true)
        setFailure(null)
        return Promise.resolve(
          select({
            sessionId: props.sessionId,
            provider: route.provider,
            model: route.model,
            ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
          }),
        )
          .then((response) => {
            if (response?.ok === false) {
              const code = response?.error?.code ?? 'REMOTE'
              setFailure(`${code}: ${response?.error?.message ?? '切换失败'}`)
            }
          })
          .catch((error) => setFailure(error?.message ?? String(error)))
          .then(() => setBusy(false))
      }

      const options = [track === null ? 'custom' : null, 'plan', 'act'].filter((item) => item !== null)
      const selected = track === null ? 'custom' : track
      // A row that cannot be picked still renders and still explains itself; the
      // menu never silently drops an entry the user configured.
      const pickable = (name) => name !== 'custom' && offerable(name) && busy === false
      const firstPickable = options.find(pickable)
      const far = (offset) => (offset < 0 ? options.length - 1 : 0)

      function closeMenu() {
        setOpen(false)
        setActive(null)
      }

      function openMenu(offset) {
        // Opening stays possible even when nothing can be committed: the menu is
        // the only place that explains *why* every entry is inert.
        if (busy) return
        // Land the keyboard cursor on the current entry when that entry is a
        // real choice; a placeholder or a disabled track starts at an edge.
        const fromCurrent = options.indexOf(selected)
        const start =
          fromCurrent >= 0 && pickable(selected)
            ? fromCurrent
            : firstPickable === undefined
              ? far(offset)
              : options.indexOf(firstPickable)
        setActive(start)
        setOpen(true)
      }

      function stepActive(delta) {
        if (options.length === 0) return
        const from = active === null ? (delta < 0 ? 0 : -1) : active
        for (let hop = 1; hop <= options.length; hop += 1) {
          const next = (((from + delta * hop) % options.length) + options.length) % options.length
          if (pickable(options[next])) {
            setActive(next)
            return
          }
        }
      }

      function commit(name) {
        closeMenu()
        choose(name)
      }

      function onTriggerKeyDown(event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (open) stepActive(event.key === 'ArrowDown' ? 1 : -1)
          else openMenu(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          if (open) {
            const name = active === null ? undefined : options[active]
            if (name !== undefined && pickable(name)) commit(name)
            else closeMenu()
          } else {
            openMenu(1)
          }
          return
        }
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          closeMenu()
        }
      }

      function onMenuKeyDown(event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          stepActive(event.key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const order = event.key === 'Home' ? options.map((_, index) => index) : options.map((_, index) => options.length - 1 - index)
          const hit = order.find((index) => pickable(options[index]))
          if (hit !== undefined) setActive(hit)
          return
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          const name = active === null ? undefined : options[active]
          if (name !== undefined) commit(name)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeMenu()
          if (typeof document !== 'undefined') {
            const button = rootRef.current?.querySelector?.('.pam-trigger')
            button?.focus?.()
          }
          return
        }
        if (event.key === 'Tab') closeMenu()
      }

      const menuId = `pam-menu-${props.sessionId ?? 'session'}`

      return React.createElement(
        'span',
        {
          ref: rootRef,
          className: 'pam-chip',
          style: { display: 'inline-flex' },
          title: failure === null ? title : `${title}\n${failure}`,
        },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'pam-trigger',
            'data-tone': selected,
            'data-open': open ? 'true' : 'false',
            'aria-label': label,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': open ? menuId : undefined,
            'aria-disabled': canSelect === true ? undefined : 'true',
            disabled: busy,
            onClick: () => {
              if (open) closeMenu()
              else openMenu(1)
            },
            onKeyDown: onTriggerKeyDown,
          },
          React.createElement('span', { key: 'dot', className: 'pam-dot', 'aria-hidden': 'true' }),
          React.createElement(LabelParts, { key: 'label', text: label }),
          React.createElement(ChipChevron, { key: 'chevron' }),
        ),
        open
          ? React.createElement(
              'div',
              {
                className: 'pam-menu',
                id: menuId,
                role: 'listbox',
                'aria-label': 'Plan / Act 模型',
                tabIndex: -1,
                onKeyDown: onMenuKeyDown,
                style: { opacity: 1 },
              },
              options.map((name, index) => {
                const pick = name === 'custom' ? customLabel(committed, catalog) : routeLabel(name, targets[name], catalog)
                const hint = name === 'custom' ? customTitle(committed) : routeTitle(name, targets[name], catalog)
                const isPickable = name !== 'custom' && offerable(name)
                return React.createElement(
                  'button',
                  {
                    key: name,
                    type: 'button',
                    className: 'pam-option',
                    role: 'option',
                    'data-tone': name,
                    'data-active': active === index ? 'true' : 'false',
                    'aria-selected': name === selected ? 'true' : 'false',
                    'aria-disabled': isPickable ? undefined : 'true',
                    tabIndex: -1,
                    title: hint,
                    disabled: name === 'custom' || busy || !offerable(name),
                    onClick: () => {
                      if (name === 'custom') return
                      commit(name)
                    },
                  },
                  React.createElement(
                    'span',
                    { key: 'check', className: name === selected ? 'pam-check' : 'pam-check pam-check--hidden' },
                    React.createElement(ChipCheck),
                  ),
                  React.createElement(LabelParts, { key: 'label', text: pick }),
                )
              }),
            )
          : null,
        failure === null
          ? null
          : React.createElement('span', { className: 'pam-failure' }, failure),
      )
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.session'],
      apply(ctx) {
        // Factory-time, not module-time: the client module system claims the
        // stylesheets added while a factory runs, and treats top-level effects
        // as arriving too early.
        ensureChipStyles()
        const form = ctx.configForms.get(ENTRY)

        // One shared catalog read for the dropdown. Started lazily on first
        // render so `apply` stays free of I/O, and cached so sessions reuse it.
        let catalogTask
        function loadCatalog() {
          if (catalogTask === undefined) {
            const remote = ctx.remote
            catalogTask =
              remote?.session?.modelCatalog === undefined
                ? Promise.resolve(null)
                : remote.session
                    .modelCatalog()
                    .then((response) => (response?.ok ? response.value : null))
                    .catch(() => null)
          }
          return catalogTask
        }

        /**
         * Commit a route the way the native selector does.
         *
         * This is the Host's public `session.selectModel`, not an event of our
         * own: it validates the route, updates the `modelSelection` projection
         * every client reads, and writes the choice into the session log — the
         * same three effects a pick in the native selector has.
         */
        function select(request) {
          const remote = ctx.remote
          if (remote?.session?.selectModel === undefined) {
            return { ok: false, error: { code: 'NO_REMOTE', message: '宿主没有提供 selectModel' } }
          }
          return remote.session.selectModel(request)
        }

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: CHIP_ID,
              order: CHIP_ORDER,
              inject: () => ({
                form,
                loadCatalog,
                select,
                canSelect: typeof ctx.remote?.session?.selectModel === 'function',
              }),
            },
            RouteSelect,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: ENTRY,
              order: 60,
              label: () => '双轨 · Plan / Act 模型',
              inject: () => ({ form, remote: ctx.remote }),
            },
            RouterSection,
          ),
        )
      },
    }
  },
})
