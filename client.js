window.__ModuleLoader__.load({
  id: 'dsh-plan-act-models',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React

    const ENTRY = 'plan-act-models'
    const FALLBACK = 'rgba(127, 127, 127, 0.45)'
    const muted = 'var(--dsw-alias-text-secondary, #8b8b8b)'
    const danger = 'var(--dsw-alias-text-danger, #d14343)'
    const accent = 'var(--dsw-alias-state-business-primary, #247bbf)'
    const border = `1px solid var(--dsw-alias-border, ${FALLBACK})`
    const radius = 'var(--dsw-alias-border-radius, 6px)'

    const control = {
      background: 'var(--dsw-alias-bg-secondary, transparent)',
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
     * The chip text: `模式：模型`.
     * @param mode - `plan` | `act`
     * @param resolved - {@link mirrorResolve} result
     * @param catalog - model catalog, or null while it is still loading
     * @param enabled - whether the plugin is switched on
     */
    function routeLabel(mode, resolved, catalog, enabled) {
      const word = MODE_WORDS[mode] ?? MODE_WORDS.act
      if (enabled !== true) return `${word}${LABEL_SEPARATOR}已关闭`
      if (resolved === null || resolved === undefined) return `${word}${LABEL_SEPARATOR}未配置`
      if (resolved.kind === 'off') return `${word}${LABEL_SEPARATOR}此项目已停用`
      if (resolved.kind !== 'route') return `${word}${LABEL_SEPARATOR}未配置`
      return `${word}${LABEL_SEPARATOR}${routeName(catalog, resolved.route)}`
    }

    /**
     * Hover text: the same label, then the exact provider/model/effort and where
     * the route comes from — the ids are what actually crosses the wire.
     */
    function routeTitle(mode, resolved, enabled, catalog) {
      const label = routeLabel(mode, resolved, catalog, enabled)
      if (enabled !== true || resolved?.kind !== 'route') return label
      const route = resolved.route
      const effort = route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`
      const scope = resolved.scope === 'project' ? `项目覆盖：${resolved.projectKey}` : '全局配置'
      return `${label} — ${route.provider}/${route.model}${effort} · ${scope}`
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
            ? '已保存。新会话立即生效；已存在的会话在下一次真正的 Plan/Act 切换时生效。'
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
            'Plan 模式使用一组模型与思考复杂度；离开 Plan 之后（含批准 exit_plan_mode 后的第一条请求）使用另一组。',
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
          React.createElement('span', null, '启用自动切换'),
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

    // The composer's own tokens, so the chip sits in the toolbar like the native
    // selector beside it: same height, same type scale, and it disappears in the
    // compact layout the selector collapses into (`data-model-compact`).
    const chipMuted = 'var(--dsw-alias-label-secondary, currentColor)'
    const chipStrong = 'var(--dsw-alias-label-primary, currentColor)'
    const chipDim = 'var(--dsw-alias-label-dimmed, currentColor)'

    /** The mode word carries the one bit of colour: Plan reads as the active mode. */
    function activated(mode, enabled, kind) {
      if (enabled !== true || kind !== 'route') return chipDim
      return mode === 'plan' ? accent : chipStrong
    }

    /**
     * Read-only chip beside the native model selector: `模式：模型`.
     *
     * The mode is the *committed* plan state (`active === true`), the same value
     * the Host reads when it routes, so the chip cannot disagree with the route
     * the next request uses. The model is whatever the project override table
     * resolves for this session's workspace root.
     */
    function RouteChip(props) {
      const { form, loadCatalog } = props
      const [snapshot, setSnapshot] = useState(() => form?.getSnapshot?.())
      const [catalog, setCatalog] = useState(null)

      const plan = typeof props.useProjection === 'function' ? props.useProjection('plan') : undefined
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

      // Subagent sessions are never routed by the Host half, so a chip there
      // would describe a decision nobody makes.
      if (props.sessionId === undefined) return null
      if (row?.origin === 'subagent' || row?.parentId !== undefined) return null
      // Nothing to say while the settings mirror has not resolved yet; the
      // composer must not flicker a wrong route into place.
      if (snapshot?.status !== 'ready') return null

      const value = snapshot.value ?? {}
      const enabled = value.enabled === true
      const mode = plan?.active === true ? 'plan' : 'act'
      const resolved = mirrorResolve(value, row?.cwd ?? '', mode)
      const label = routeLabel(mode, resolved, catalog, enabled)
      const head = `${MODE_WORDS[mode] ?? MODE_WORDS.act}${LABEL_SEPARATOR}`
      const tail = label.startsWith(head) ? label.slice(head.length) : label

      return React.createElement(
        'span',
        {
          style: {
            // Same compact-layout escape hatch the native selector uses: the row
            // sets this to `none` when it collapses, hiding our text with it.
            display: 'var(--dsh-composer-model-text-display, inline-flex)',
            alignItems: 'center',
            gap: 4,
            flex: 'none',
            height: 28,
            minWidth: 0,
            maxWidth: 'min(360px, 45cqw)',
            padding: '0 4px',
            fontSize: 13,
            fontWeight: 400,
            lineHeight: '20px',
            color: chipMuted,
            whiteSpace: 'nowrap',
          },
          title: routeTitle(mode, resolved, enabled, catalog),
          'aria-label': label,
        },
        React.createElement(
          'span',
          { style: { flex: 'none', fontWeight: 500, color: activated(mode, enabled, resolved.kind) } },
          head,
        ),
        React.createElement(
          'span',
          { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          tail,
        ),
      )
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.session'],
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY)

        // One shared catalog read for the chip. Started lazily on first render
        // so `apply` stays free of I/O, and cached so every session reuses it.
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

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: CHIP_ID,
              order: CHIP_ORDER,
              inject: () => ({ form, loadCatalog }),
            },
            RouteChip,
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
