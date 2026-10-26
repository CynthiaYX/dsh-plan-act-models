# Notes for automated contributors

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before writing a commit. In short:

- Subject: `type(scope): summary`, at most 72 characters, no trailing period.
- One blank line, then a body of at most 12 lines explaining **why**. If the
  change is legible from the subject alone, omit the body.
- Never add attribution lines (`Generated with …`, `🤖`, AI co-author
  addresses). The message describes the change, not the tool that typed it.

`npm test` runs `test/commit.test.mjs`, which enforces these rules. The hook is
`git config core.hooksPath .githooks`; enable it once per clone.

Two constraints specific to this repository:

- `client.js` is a classic script served to the page and cannot import `lib/`.
  The routing decision table is mirrored inside the `#region plan-act-view`
  block, and `test/client-view.test.mjs` compares that mirror against the real
  `resolveTarget`. Change both sides or the suite fails.
- The package has no runtime dependencies and no build step. Keep it that way:
  prefer adding a test over adding a tool.
