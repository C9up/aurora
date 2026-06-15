# @c9up/aurora

> Reactive UI runtime for the Ream framework — tagged-template DOM, signal-based state, isomorphic SSR + hydration, zero build step.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/aurora
ream configure @c9up/aurora
```

## Usage

Register the provider in your app, then configure it under `config/aurora.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/aurora/provider'),
]
```

## Entry points

- `@c9up/aurora` — main API: reactive primitives (`signal`/`effect`/`html`/`component`/`hydrate`) plus the client toolkit — `WebStorage`/`persistedSignal`, reactive browser signals (`prefersDark`/`online`/`windowSize`/…), SPA navigation (`navigate`/`queryParam`), `cookie`/`clipboard`/`share`, and the `HttpClient` fetch wrapper
- `@c9up/aurora/provider` — Ream IoC provider
- `@c9up/aurora/services/main` — container service accessor
- `@c9up/aurora/relay` — realtime adapter
- `@c9up/aurora/ssr` — server-side rendering
- `@c9up/aurora/hydrate` — client hydration

## License

MIT
