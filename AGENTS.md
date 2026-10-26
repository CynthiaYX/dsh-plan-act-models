# Notes for automated contributors

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before writing a commit. In short:

- Subject: `type(scope): summary` on one line, **at most 36 characters total**
  — the type, scope, and separator all count. `feat: ` leaves 30 characters,
  `feat(view): ` leaves 24, `refactor(routing): ` leaves 17. Drop the scope
  before shortening the summary.
- One blank line, then a body of **at most 3 lines of 50 characters**. If the
  subject already says it, omit the body entirely; a bare subject is complete.
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
