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

```ts
// config/aurora.ts
export default {
  pages: {
    root: new URL('../resources/pages', import.meta.url).pathname,
  },
  root: {
    tag: 'main',
    class: 'min-h-screen',
  },
  shared: async (ctx) => ({
    auth: { user: ctx.auth?.user ?? null },
    flash: ctx.session?.flashMessages?.all?.() ?? {},
    errors: ctx.session?.flashMessages?.get?.('errors') ?? {},
  }),
}
```

Controllers stay thin, like Adonis/Inertia controllers:

```ts
export default class DashboardController {
  async show({ aurora }) {
    return aurora.render('dashboard/show', {
      stats: await loadStats(),
    })
  }
}
```

## Dev live-reload (HMR)

Pages are dynamic-imported per request; aurora dev-busts the page module by mtime, but a page's **transitive** imports (components/layouts/services) stay cached until you restart. Enable graph-aware SSR HMR — the AdonisJS way — with [`hot-hook`](https://github.com/Julien-R44/hot-hook):

```bash
pnpm add -D hot-hook @hot-hook/runner
```

```jsonc
// package.json
{
  "scripts": {
    "dev": "hot-runner --node-args=--import=tsx --node-args=--import=hot-hook/register bin/server.ts"
  },
  "hotHook": { "boundaries": ["./resources/pages/*.js"] }
}
```

Editing a page or any component it imports now hot-reloads the SSR with no restart. **Point `boundaries` at page entries only** (`./resources/pages/*.js`, not `**/*.js`) — hot-hook requires boundary files to be dynamically imported, so a statically-imported component matched by the glob forces a full reload. aurora itself needs no change.

## Entry points

- `@c9up/aurora` — main API: reactive primitives (`signal`/`effect`/`html`/`component`/`hydrate`) plus the client toolkit — `WebStorage`/`persistedSignal`, reactive browser signals (`prefersDark`/`online`/`windowSize`/…), SPA navigation (`navigate`/`queryParam`), `cookie`/`clipboard`/`share`, the `HttpClient` fetch wrapper, `createRpcClient()` (JSON-RPC 2.0), `command()` (async action + reactive loading/data/error), `form()` (reactive form controller; optional rune validation + rosetta i18n), `urlFor()` (isomorphic named-route URLs, paired with Ream's `router.namedManifest()`), and `cn()` (zero-dependency Tailwind v4 class merge — `clsx` + `tailwind-merge` reimplemented)
- `@c9up/aurora/provider` — Ream IoC provider
- `@c9up/aurora/services/main` — container service accessor
- `@c9up/aurora/relay` — realtime adapter
- `@c9up/aurora/ssr` — server-side rendering
- `@c9up/aurora/hydrate` — client hydration
- `@c9up/aurora/server` — server-only helpers and types (`AuroraManager`,
  `Pages`, `renderPage`, `serveAssets`, `SharedProps`, `SharedPropsResolver`)

## Adonis / Inertia parity

Implemented in Aurora:

- provider + IoC service;
- `ctx.aurora.render(name, props, options)`;
- named page rendering from routes/controllers;
- shared props per request via `shared`;
- root tag/class customization;
- named-route manifest for `urlFor()`;
- asset/version marker in page data;
- SSR + hydration payload.

Still intentionally tracked as remaining work:

- `@adonisjs/vite`-equivalent frontend integration: asset bundling, dev manifest and browser-asset HMR (SSR page-module HMR is available today via hot-hook — see [Dev live-reload](#dev-live-reload-hmr));
- full Inertia navigation semantics: preserve state, history encryption, version
  mismatch handling and client-side visit lifecycle;
- generated page-name types.

## Security notes

- `renderPage()` isolates SSR cookies and route manifests per request. Pages can
  read `cookieState()` and `urlFor()` across async boundaries without leaking
  another concurrent request's state.
- `renderPage()` and `AuroraManager.render()` support Adonis/Inertia-style
  shared props via `shared`, plus root element customization via `rootTag`,
  `rootClass` or `config.aurora.root`.
- `HttpClient` does not send managed bearer/default `Authorization` headers to
  cross-origin absolute URLs by default. Set `allowCrossOriginAuth: true` only
  when the external origin is intentional and trusted, or pass an explicit
  per-request `Authorization` header.
- `wireLiveEvents()` accepts an `authorize(ctx, body)` hook. Use it to bind live
  event POSTs to the same auth/CSRF/owner policy as the page that mounted the
  live session.
- `redirect()`, `replace()` and `navigate()` reject `javascript:`, `vbscript:`
  and `data:` URLs.
- `auroraRoute()` is the legacy low-level route helper. Prefer the provider /
  `ctx.aurora.render()` pipeline for Adonis-style applications.

## License

MIT
