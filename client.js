window.__ModuleLoader__.load({
  id: 'dsh-plan-act-models',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React

    const ENTRY = 'plan-act-models'
    const FALLBACK = 'rgba(127, 127, 127, 0.45)'
    const muted = 'var(--dsw-alias-text-secondary, #8b8b8b)'
    const danger = 'var(--dsw-alias-text-danger, #d14343)'
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

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.session'],
      apply(ctx) {
        const form = ctx.configForms.get(ENTRY)
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
