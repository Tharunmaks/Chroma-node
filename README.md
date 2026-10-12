<div align="center">

# ◆ Chroma

**Deploy platform · Helix 3D engine · Pyre GPU language & Torch — in one Node.js package.**

[![CI](https://github.com/Tharunmaks/Chroma-node/actions/workflows/ci.yml/badge.svg)](https://github.com/Tharunmaks/Chroma-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cff.svg)](LICENSE)
![Node 22.5+](https://img.shields.io/badge/node-%E2%89%A522.5-3ddc97.svg)
![Models](https://img.shields.io/badge/3D%20%2B%204D%20models-124%2C130-ff7a1a.svg)
![Dependencies](https://img.shields.io/badge/runtime%20deps-2-38d6ff.svg)

<img src="docs/screenshots/hero.gif" alt="Chroma's landing page: an iridescent torus knot made with a Pyre shader, a DNA helix and orbiting crystals" width="800">

[**Live demo**](https://tharunmaks.github.io/Chroma-node/) · [**Quick start**](#quick-start) · [What's inside](#whats-inside) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Pyre language](https://github.com/Tharunmaks/Pyre)

**▶ Try it in your browser: [tharunmaks.github.io/Chroma-node](https://tharunmaks.github.io/Chroma-node/)** — the model library, Studio, Playground, Pyre Torch notebook and Helix engine all run with no install. Accounts, deploys, the database and analytics need your own server (one `npm install`).

</div>

* **Helix** renders a library of **124,130 procedural 3D and 4D models** (supershapes, torus knots,
  spherical harmonics, Lissajous and Spirograph knots, twisted tori, all six regular 4-polytopes,
  duoprisms, Clifford torus knots, 4D Lissajous curves…) with live Pyre materials, a model studio, glTF/OBJ export and saving.
* **[Pyre](https://github.com/Tharunmaks/Pyre)** is GPU code with Python syntax (GLSL/WGSL/JS) plus
  **Pyre Torch**, PyTorch-style tensors, autograd, `nn` and optimizers on the CPU.
* **The platform** deploys sites to your own server with previews and instant rollback, and gives
  every project a **realtime database**, **JS and Pyre server functions** and **live analytics**.

<p align="center"><img src="docs/screenshots/4d-polytope.gif" alt="The 120-cell, a regular 4D polytope with 600 vertices, rotating through the fourth dimension in the Helix studio" width="560"><br><sub>The 120-cell rotating through 4D — one of 27,690 four-dimensional models.</sub></p>

| Playground: edit Pyre, see it on 3D models | Kernels: CPU and WebGPU, verified equal |
| --- | --- |
| ![Playground](docs/screenshots/playground.jpg) | ![Kernels](docs/screenshots/kernels.jpg) |

## Quick start

```sh
git clone https://github.com/Tharunmaks/Chroma-node && cd Chroma-node
npm install
npm start                       # http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000/dashboard>, create an account, then **New project → Helix starter**.
You'll have a live 3D site (a Pyre lava planet + a Pyre Function) in about a second.

Or use the CLI:

```sh
npm i -g github:Tharunmaks/Chroma-node
chroma init my-site && cd my-site
chroma dev                      # live reload + Pyre compiled on the fly
chroma login                    # API token saved to ~/.chroma/config.json (mode 600)
chroma deploy                   # → /p/my-site/
chroma rollback my-site         # instant rollback
```

## What's inside

| Part | Where | What it does |
| --- | --- | --- |
| **Website** | `web/` | Landing page with a live 3D hero, Playground, Helix studio, Docs, Dashboard |
| **Platform server** | `server/` | Accounts, API tokens, projects, immutable deployments, Pyre build step, sandboxed hosting, Pyre Functions, audit log |
| **CLI** | `bin/chroma.js` | `init`, `dev`, `build`, `login`, `deploy`, `projects`, `deployments`, `promote`, `rollback`, `run`, `server`, `pyre` |
| **Helix engine** | `web/assets/js/helix/` | Three.js wrapper: Pyre materials, glTF loading, bloom, orbit controls, procedural models, render-when-visible |
| **Pyre** | dependency (`pyre-lang`) | Compiler to GLSL / WGSL / JS, from [Tharunmaks/Pyre](https://github.com/Tharunmaks/Pyre) |
| **Templates** | `templates/` | `helix-starter` (3D page + shader + function), `fullstack` (realtime guestbook + JS function + analytics + 4D model), `static` |

### Backend (built in, SQLite)

| Feature | What you get |
| --- | --- |
| Database | JSON collections per project, rules (`public` / `create` / `private`), queries, realtime SSE subscriptions, browser SDK |
| Server functions | `api/*.js` handlers (sandboxed child process per request) and `api/*.pyre` kernels |
| Analytics | Live visitors, views, unique visitors, referrers, devices, status codes, functions, custom events — no cookies or stored IPs |
| Models | Save edited or Pyre-written models to your account, share them in the community gallery |

### Pages

* **`/`** — 3D hero (Pyre iridescent torus knot, DNA helix, crystals, starfield, bloom), live shader
  showcase with compiled GLSL/WGSL, model viewer with glTF drag-and-drop, deploy terminal.
* **`/models`** — the 124,130-model library: search, family and 3D/4D filters, live thumbnails,
  preview with copy-paste code, community gallery.
* **`/studio`** — edit any model's parameters, write your own in Pyre (`surface(u, v)` or 4D
  `surface4`), materials (PBR or Pyre shaders), 4D rotation controls, save, export `.glb`/`.obj`/`.png`.
* **`/torch`** — a live Pyre Torch notebook (sandboxed worker): train classifiers with streaming
  loss charts and decision-boundary plots.
* **`/platform`** — deployments, database, functions and analytics explained.
* **`/playground`** — editor with Pyre highlighting, auto-indent and inline errors; live 3D preview on
  8 models or your `.glb`; auto-generated uniform controls; GLSL/WGSL/JS output; kernels run on the CPU
  (in a sandboxed worker) **and** on WebGPU with a correctness check and 3D visualisation; share links;
  one-click deploy.
* **`/engine`** — Helix studio: scenes, Pyre and PBR materials, bloom, instancing, your own models.
* **`/dashboard`** — sign up / in, projects with live previews, drag-and-drop folder deploys, build
  logs, promote/rollback, **live analytics**, **database browser & rules**, API tokens, password
  change, audit log.
* **`/docs`** — getting started, CLI, deployments, Pyre reference, Helix API, REST API, security,
  self-hosting.

## Security

Chroma hosts untrusted sites and runs untrusted GPU code next to your account, so security is
built in rather than bolted on — see [SECURITY.md](SECURITY.md). Highlights:

* scrypt password hashing, constant-time checks, account lockout, per-IP rate limits
* `HttpOnly; SameSite=Strict` session cookies, per-session CSRF tokens, Origin checks; only hashes of
  sessions and API tokens are stored
* strict CSP on every platform page (no inline script except the hashed import map, no eval)
* every deployed file is served with a CSP **sandbox** → user sites run in an opaque origin and can't
  touch the dashboard or API with your credentials
* upload validation (traversal, hidden files, size caps), content-addressed storage
* Pyre Functions in fresh worker threads with time, memory, loop and buffer limits; JS functions in a
  fresh permission-restricted child process with no code generation and a string-only bridge
* database rules per collection, parameterised SQL, analytics without cookies or stored IPs

## Why Chroma?

* **One `npm install`, no services.** Deploys, database, functions and analytics run in a single
  Node process with SQLite — no cloud accounts, no API keys, no vendor lock-in.
* **3D-native.** Shaders are a build step, models are a library, and the engine ships with the
  platform, so a deployed site can `import { Helix } from 'helix'` with nothing to bundle.
* **One language for GPU, CPU and ML.** Pyre compiles shaders to GLSL/WGSL, runs kernels on the
  server, and powers a PyTorch-style tensor library.
* **Secure by default** and covered by tests: sandboxed sites, sandboxed functions, strict CSP.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first
contributions: a new model family in `web/assets/js/helix/catalog.js`, a Pyre shader for
`web/assets/js/shaders.js`, a template in `templates/`, or a Pyre Torch layer.

## Development

```sh
npm test          # 43 tests: auth, CSRF, isolation, uploads, sandboxing, database rules, analytics,
                  # JS-function escape attempts, catalogue geometry, dev server, CSP
npm run dev       # restart on change
```

Requirements: Node.js 22.5+ (built-in SQLite). Runtime dependencies: `three` and `pyre-lang` (no framework).
Deploy with Docker: `docker compose up -d` (data in the `chroma-data` volume).

MIT licensed.
