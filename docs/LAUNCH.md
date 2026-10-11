# Launch kit

Popularity comes from people seeing the project and finding it useful. Everything below is ready
to copy; the posting itself has to come from your own accounts.

## 1. Repository settings (5 minutes, on github.com)

**Chroma-node → ⚙ About (top right of the repo page):**
- Description: `Self-hosted deploy platform with a 3D engine (124k procedural 3D/4D models), a realtime database, sandboxed functions and live analytics — one Node.js package.`
- Website: your demo URL once hosted (see step 2)
- Topics: `threejs` `webgl` `webgpu` `3d` `4d` `procedural-generation` `shaders` `glsl` `wgsl` `deployment` `self-hosted` `paas` `realtime-database` `analytics` `nodejs` `sqlite` `javascript`

**Pyre → ⚙ About:**
- Description: `A typed GPU language with Python syntax that compiles to GLSL, WGSL and JavaScript — plus Pyre Torch, PyTorch-style autograd on the CPU.`
- Topics: `programming-language` `compiler` `shaders` `glsl` `wgsl` `webgpu` `webgl` `gpu` `autograd` `deep-learning` `pytorch` `tensor` `javascript`
- Website: `https://tharunmaks.github.io/Pyre/` after the next step

**Settings → Pages (Pyre):** Source *Deploy from a branch*, branch `claude/website-polish-3d-cmjt9f`
(or `main`), folder `/docs`. The Pyre playground then works for anyone, no install.

**Settings → General → Social preview:** upload `docs/social-preview.png` (Chroma) so links shared on
X, LinkedIn, Discord and Slack show a 3D image instead of a grey card.

**Settings → General → Features:** enable *Discussions* (a place for show-and-tell).

**Optional:** rename the default branch to `main` (Settings → Branches) — people expect it.

## 2. A live demo link

The biggest driver of stars is a link people can click. Host Chroma on any small VPS:

```sh
docker compose up -d     # then put Caddy or nginx with TLS in front
```

Deploy the `fullstack` template as a public demo project and link it in the README.

## 3. Ready-to-post drafts

### Show HN

**Title:** Show HN: Chroma – self-hosted deploys, a realtime DB and 124k procedural 3D/4D models in one Node app

> I built Chroma because shipping a small 3D web app meant juggling a host, a database, functions
> and analytics from different vendors. Chroma is one Node 22 process with SQLite:
>
> - deploys with preview URLs and instant rollback; every deployed file runs in a sandboxed origin
> - a realtime JSON database with per-collection rules and SSE subscriptions
> - server functions in JavaScript (each request in a permission-restricted child process) or in Pyre
> - analytics without cookies or stored IPs, streaming live into the dashboard
> - Helix, a Three.js layer with a library of 124,130 procedurally generated models — including
>   10,000 4D Lissajous curves and all six regular 4-polytopes rotating through the fourth dimension
> - Pyre, a small typed GPU language with Python syntax that compiles to GLSL, WGSL and JS, plus a
>   PyTorch-style autograd library that runs on the CPU
>
> It's MIT licensed, has ~80 tests (including sandbox-escape attempts), and I'd love feedback,
> especially on the security model: https://github.com/Tharunmaks/Chroma-node

### Reddit — r/threejs, r/proceduralgeneration, r/generative

**Title:** I made a browser library of 124,130 procedural 3D and 4D shapes (torus knots, supershapes, 4-polytopes…) — open source

> Every model has a stable id and parameters, so you can open any of them in a studio, tweak it,
> export it as .glb/.obj, or write your own surface in a tiny shader language. The 4D ones (all six
> regular 4-polytopes, duoprisms, Clifford torus knots, 4D Lissajous curves) rotate through the w
> axis live. Built on Three.js. [GIF] Repo: https://github.com/Tharunmaks/Chroma-node

### Reddit — r/javascript, r/webdev, r/selfhosted

**Title:** Chroma: a self-hosted Vercel-style platform with a built-in realtime DB, sandboxed functions and cookie-free analytics (Node + SQLite, MIT)

> One `npm install`, one process, no external services. Deploy with `chroma deploy`, get preview
> URLs and rollback, a JSON database with rules and live subscriptions, `api/*.js` functions that
> run in a locked-down child process per request, and live analytics in the dashboard.
> Feedback welcome: https://github.com/Tharunmaks/Chroma-node

### Reddit — r/ProgrammingLanguages, r/GraphicsProgramming (for Pyre)

**Title:** Pyre: a typed shader/compute language with Python syntax → GLSL, WGSL and JS (output verified pixel-for-pixel on real GPUs)

> Type inference, int→float promotion, swizzles, compute kernels, a stdlib with integer hashing so
> noise is bit-identical on GPU and CPU, and friendly errors with suggestions. The test harness
> renders every example on real WebGL2 and WebGPU and diffs against the CPU backend.
> Playground: https://tharunmaks.github.io/Pyre/ · Repo: https://github.com/Tharunmaks/Pyre

### X / Bluesky / LinkedIn thread

1. I built Chroma: deploys + realtime database + sandboxed functions + live analytics + a 3D engine, in one Node.js app. Open source. 🧵 [hero.gif]
2. The 3D engine ships with 124,130 procedural models. 27,690 of them are four-dimensional and rotate through the w axis. [4d-polytope.gif]
3. Shaders are written in Pyre, a tiny GPU language with Python syntax that compiles to GLSL, WGSL and JS.
4. Pyre also has a PyTorch-style autograd library that runs on any CPU — there's a notebook in the browser.
5. Everything is self-hosted: one process, SQLite, no cookies in analytics. MIT. github.com/Tharunmaks/Chroma-node

### dev.to / Hashnode article ideas
- "Rendering 4D polytopes in the browser: rotating in six planes and projecting to 3D"
- "Sandboxing user JavaScript in Node 22 with the permission model and a string-only bridge"
- "Cookie-free analytics with daily-rotating HMAC visitor ids"
- "Writing a PyTorch-style autograd engine in 900 lines of JavaScript"

## 4. Keep momentum

- Post a short GIF of one new model family or feature each week.
- Label a few issues `good first issue` (new model families are perfect ones).
- Reply to every issue and PR quickly in the first weeks.
- Submit to curated lists: awesome-threejs, awesome-webgpu, awesome-selfhosted, awesome-procedural-generation.

Please don't buy stars or use vote rings — GitHub and HN detect them and they can get a project delisted.
