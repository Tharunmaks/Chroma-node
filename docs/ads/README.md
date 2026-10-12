# Chroma — ad kit

Ready-to-use creatives and copy for launching Chroma. Everything here is built
from the real brand system (`web/assets/css/site.css`) so the ads match the
site. Regenerate the images any time with:

```sh
# needs playwright + chromium (already configured in CI)
node ../../scripts/export-static.mjs   # (optional) rebuild the live demo first
# then open docs/ads/creatives.html and screenshot each #id,
# or run the render script used to produce the PNGs below.
```

Link every ad to the **live demo** (enable it once — see
[`docs/LAUNCH.md`](../LAUNCH.md)):

> **https://tharunmaks.github.io/Chroma-node/**

…and the repo: **https://github.com/Tharunmaks/Chroma-node**

---

## Creative inventory

| File | Size | Where to use |
| --- | --- | --- |
| `chroma-1200x628-link.png` | 1200×628 | Open Graph / link preview, X & LinkedIn link ads, Reddit, blog headers |
| `chroma-1080x1080-square.png` | 1080×1080 | Instagram / Facebook feed, LinkedIn square |
| `chroma-1080x1920-story.png` | 1080×1920 | Instagram / TikTok / YouTube Stories & Reels, Snap |
| `chroma-1500x500-header.png` | 1500×500 | X/Twitter profile header |
| `chroma-300x250-rectangle.png` | 300×250 | Google Display medium rectangle |
| `chroma-728x90-leaderboard.png` | 728×90 | Google Display leaderboard |
| `chroma-160x600-skyscraper.png` | 160×600 | Google Display wide skyscraper |

The source for all of them is a single file: [`creatives.html`](creatives.html).
Edit the copy or colours there and re-render.

---

## Copy bank

Mix and match. Keep one clear claim + one CTA per placement.

### One-liners (headlines)
- Build, shade & ship 3D for the web.
- A 3D engine, a GPU language and a deploy platform — in one npm install.
- 124,130 3D & 4D models. Zero config. Open source.
- Write shaders in Python-style syntax. Run them on every GPU.
- Vercel-style deploys + a 3D engine + your own GPU language.
- Ship a 3D site in one command.

### Short body
> Chroma is an open-source Node.js package that bundles a 3D engine (Helix),
> a typed GPU language (Pyre) and a Vercel-style deploy platform. Browse
> 124,130 3D & 4D models, write shaders and kernels that compile to GLSL,
> WGSL and JS, and deploy with a database, server functions and live
> analytics built in. Zero dependencies.

### CTAs
Try the live demo · Star on GitHub · Open the playground · Deploy a 3D site · Get it free

---

## Platform-specific drafts

**X / Twitter**
> I built Chroma: a 3D engine + a GPU language (Pyre, Python-style → GLSL/WGSL/JS)
> + a Vercel-style deploy platform, in one zero-dependency npm package.
>
> 124,130 3D & 4D models. Live demo runs in your browser 👇
> https://tharunmaks.github.io/Chroma-node/
>
> Open source: github.com/Tharunmaks/Chroma-node
_(Attach `chroma-1200x628-link.png`.)_

**Reddit** (r/webdev, r/threejs, r/javascript, r/gamedev, r/programming — read each sub's self-promo rules first)
> **Title:** I built a 3D engine, a GPU language and a deploy platform in one npm package (open source, live demo)
> **Body:** Chroma bundles Helix (a Three.js-based engine with a 124,130-model
> library), Pyre (a typed, Python-style GPU language that compiles to GLSL ES,
> WGSL and JS — shader output is verified pixel-for-pixel against real drivers),
> and a Vercel-style platform with content-addressed deploys, a realtime
> database, sandboxed server functions and live analytics. Zero dependencies,
> MIT. Everything in the demo runs in your browser. Feedback welcome.

**Hacker News (Show HN)**
> Show HN: Chroma – a 3D engine, a GPU language and a deploy platform in one npm package
_(First comment: what it is, why you built it, what's real vs. in progress, link to the demo. Draft in [`docs/LAUNCH.md`](../LAUNCH.md).)_

**LinkedIn**
> Shipped Chroma 🔥 — an open-source toolkit that folds a 3D engine, a GPU
> programming language and a deploy platform into a single Node.js package.
> 124,130 models, shaders that compile to GLSL/WGSL/JS, and a built-in database
> + live analytics. Live demo + source in the comments.
_(Attach the square or link image.)_

**Instagram / TikTok caption**
> Ship 3D for the web in one command. 124,130 models, your own GPU language,
> deploys + analytics built in. Free & open source → link in bio.
> #webdev #threejs #javascript #creativecoding #gpu #opensource #shaders

**Google Display** (responsive display ad)
> Headlines: "Ship 3D for the web" · "124,130 3D models, zero config" · "Open-source 3D platform"
> Long headline: "A 3D engine, a GPU language and a deploy platform in one npm install"
> Description: "Build, shade and ship 3D sites with a database and live analytics built in. Free & open source."
> Images: the 1200×628, 300×250, 728×90 and 160×600 above.

---

## Targeting (if you run paid)

- **Interests / keywords:** Three.js, WebGL, WebGPU, shaders, GLSL, creative
  coding, game dev, generative art, PyTorch, Vercel, Next.js, data viz.
- **Audiences:** front-end & creative developers, indie game devs, ML/graphics
  students, hackathon crowds, design-engineering teams.
- **Channels, cheapest first:**
  1. **Organic** — Show HN, the subreddits above, X/LinkedIn posts, a short
     Reel. Free and usually the best ROI for a dev tool.
  2. **Reddit Ads** — cheap CPMs, target the exact subs above.
  3. **X Ads / LinkedIn** — promote the best-performing organic post.
  4. **Google Display** — retarget site/demo visitors with the banner set.
- **Always link to the live demo**, not just the repo — letting people *try* it
  in-browser is the strongest hook, and the demo's "Get Chroma" ribbon sends
  them to GitHub.

---

> Note: I can't post from your accounts or run paid campaigns for you — these
> are the finished creatives and copy to paste in. The live demo (the "boost")
> deploys automatically via [`.github/workflows/pages.yml`](../../.github/workflows/pages.yml);
> enable it once under **Settings → Pages → Source: GitHub Actions**.
