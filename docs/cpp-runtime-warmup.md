# Scoped C++ caching and initial warmup

The standard C++ provider keeps performance features off. A host may create
one provider per account/project with `createCppRuntimeProvider` from
`web-ide/runtimes`:

```ts
const runtime = createCppRuntimeProvider({
  cpp: {
    scope: { projectId, accountId },
    objectCache: true,
    retainWorker: true,
    cacheCompilerModule: true,
    idleTimeoutMs: 30_000,
  },
})
```

Contribute this provider in the normal plugin configuration. Replace the provider
and mount on an account or project change, and await the old instance's close.
The engine's memory-only cache and immutable compiler code belong to that one
scope. Debug and intercepted Tests use their normal foreground paths. Every Run
links and executes a fresh program.

After admitting an assignment/workspace snapshot, the host may schedule exactly
one idle or low-priority `await handle.warmup?.()`. The host owns that initial
schedule. Web IDE does not schedule work on edits and does not retry failures.
Cancel a scheduled callback on navigation; `await handle.cancelWarmup?.()` drains
an in-flight compile. Workspace changes and unmount also cancel in-flight work.
Cancellation fences pending pure provider transforms immediately; a transform
that settles later cannot submit engine work. A foreground transition supersedes
the initial warmup even if that foreground job finishes before an idle callback.

Warmup captures the current workspace, execution resources and ordinary Run plan
transform without entering the foreground Run pipeline. It compiles translation
units only. It does not clear the terminal, flush stream interceptors, publish
run/compile host events, modify student files or dirty state, open a host device,
link, or execute student code. Compiler output is captured separately up to
65,536 characters. The returned `RuntimeWarmupResult` reports completion,
cancellation, skipping or failure, diagnostics, and provider cache/timing
statistics. A compiler failure also emits one preparation warning; foreground
Run remains available.

For diagnostics or acceptance checks, `handle.compilationStatistics?.()` and
`RuntimeSession.compilationStatistics?.()` return fresh owned snapshots after
foreground Run or warmup. They return `undefined` when C++ options are disabled,
the engine has not initialized, or the session is disposed. The payload is
backend-specific: this provider returns debugger-sh's public
`CppCacheStatistics` schema, including `latest.cache` translation-unit counters,
`latest.compilerModule` immutable code reuse, timings and retained byte counts.
Reading or mutating a returned snapshot does not change runtime state.

`buildRuntimeExecutionPlan(plan)` is a pure snapshot builder: it canonicalizes
text paths, owns file/artifact metadata, and protects binary inputs through owned
copies. Provider wrappers that transform source or add resources must apply the
same pure transform to `RuntimeSession.prepare(plan)` and
`RuntimeSession.warmup(plan)`. Keep terminal/UI callbacks out of that transform.
The builder does not call `prepare`, start a program, or flush an interceptor.

Foreground preparation joins an in-flight warmup only when every frozen file,
binary byte, artifact, alias, entrypoint, build profile and mode matches. A
mismatch cancels and drains background compilation before the next engine
mutation. Stop and disposal also fence pending initialization and preparation.
The engine's normal cache limits, explicit clearing and scoped disposal remain
the disable/rollback path; omit these provider options to restore the default.

Retention adds compiler identity byte copies and browser-managed compiled code;
cache budgets do not bound total browser memory. Chrome measurements and real
Safari validation belong to rollout evidence. Enabling the provider alone does
not implement assignment-open scheduling in a course host.
