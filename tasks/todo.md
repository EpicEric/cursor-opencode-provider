# PR 37 adversarial review

- [x] Inspect the provider PR and related uncommitted OCP diff.
- [x] Reproduce restart, standalone continuation, prompt-literal, todo-result,
  and JSONC failures before fixing them.
- [x] Implement fixes in the repository that owns each contract.
- [x] Strengthen architecture checks for multiline imports and package metadata.
- [x] Complete final build, strict compiler, test, package, and diff checks.

## Review

Regression evidence: `test/context-epoch.test.ts:158`,
`test/continuation-session.test.ts:509`, `test/context.test.ts:236`;
OCP `test/prompt-tool-names.test.ts:33`, `test/vocabulary.test.ts:463`.
Architecture checks: `test/architecture.test.ts:43`.

Validation completed: provider 1,293 tests and OCP 629 tests passed; strict
compiler checks, provider package inventory, and OCP's 11-package packing and
dependency-pin checks passed.

No live stock-host acceptance run was performed during this review. No commit
or publication is authorized.
