// Pyre programs used across the Chroma site. Every one of these is compiled
// in the browser by the real Pyre compiler (and checked by the test suite).

export const SHADERS = {
  iridescent: {
    name: 'Iridescent',
    model: 'torusKnot',
    source: `# Thin-film iridescence: colour shifts with the viewing angle.
uniform time: float

@fragment
fn main(normal: vec3, position: vec3) -> vec4:
    let facing = abs(normal.z)                      # 1 = facing the camera
    let flow = fbm(position.xy * 1.6 + time * 0.15)
    let film = facing * 1.4 + flow * 0.9 + time * 0.08
    let col = palette(film, vec3(0.6, 0.55, 0.68), vec3(0.32, 0.3, 0.32), vec3(1.0), vec3(0.0, 0.12, 0.28))
    let light = max(dot(normal, normalize(vec3(0.5, 0.7, 0.6))), 0.0)
    let spec = pow(light, 24.0)
    let rim = pow(1.0 - facing, 3.0)
    let base = col * (0.25 + 0.7 * light) + spec * 0.45
    return vec4(base + rim * vec3(0.9, 0.35, 0.8) * 0.7, 1.0)
`,
  },
  lava: {
    name: 'Lava',
    model: 'sphere',
    source: `# Molten rock: flowing noise with a glowing crust.
uniform time: float

@fragment
fn main(normal: vec3, position: vec3) -> vec4:
    let flow = fbm(position.xy * 2.5 + vec2(0.0, -time * 0.4))
    let heat = smoothstep(0.35, 0.75, flow)
    let crust = vec3(0.08, 0.02, 0.02)
    let lava = mix(vec3(1.0, 0.25, 0.0), vec3(1.0, 0.85, 0.3), heat)
    let light = max(dot(normal, normalize(vec3(0.4, 0.8, 0.6))), 0.0)
    let rim = pow(1.0 - abs(normal.z), 2.5)
    let col = mix(crust * (0.3 + light), lava, heat) + rim * vec3(1.0, 0.4, 0.1) * 0.6
    return vec4(col, 1.0)
`,
  },
  hologram: {
    name: 'Hologram',
    model: 'helix',
    source: `# Sci-fi hologram: scanlines, flicker and a bright fresnel edge.
uniform time: float

@fragment
fn main(normal: vec3, position: vec3) -> vec4:
    let rim = pow(1.0 - abs(normal.z), 2.0)
    let scan = 0.5 + 0.5 * sin(position.y * 60.0 - time * 6.0)
    let band = smoothstep(0.92, 1.0, fract(position.y * 0.6 - time * 0.35))
    let flicker = 0.92 + 0.08 * sin(time * 37.0)
    let col = vec3(0.25, 0.85, 1.0) * (0.25 + 0.6 * scan + 1.6 * rim) + band * vec3(0.6, 1.0, 1.0)
    return vec4(col * flicker, 1.0)
`,
  },
  toon: {
    name: 'Toon',
    model: 'torus',
    source: `# Cel shading: lighting snapped into bands, plus an ink outline.
uniform time: float
const BANDS = 4.0

@fragment
fn main(normal: vec3) -> vec4:
    let l = normalize(vec3(cos(time * 0.6), 0.8, sin(time * 0.6) + 0.6))
    let d = max(dot(normal, l), 0.0)
    let stepped = floor(d * BANDS) / BANDS
    let base = mix(vec3(0.36, 0.2, 0.75), vec3(1.0, 0.55, 0.3), stepped)
    let outline = step(0.32, abs(normal.z))
    return vec4(base * outline, 1.0)
`,
  },
  plasma: {
    name: 'Plasma',
    model: 'plane',
    source: `# Plasma: layered sine waves run through a cosine palette.
uniform time: float

@fragment
fn main(uv: vec2) -> vec4:
    let p = (uv - 0.5) * 6.0
    var v = sin(p.x + time)
    v += sin((p.y + time) * 0.5)
    v += sin((p.x + p.y + time) * 0.5)
    let c = p + vec2(sin(time / 3.0), cos(time / 2.0)) * 2.0
    v += sin(sqrt(dot(c, c) + 1.0) + time)
    let col = palette(v * 0.25, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67))
    return vec4(col, 1.0)
`,
  },
  raymarch: {
    name: 'Raymarcher',
    model: 'plane',
    source: `# Signed-distance raymarcher: a blobby torus and sphere with soft lighting.
uniform time: float

fn scene(p: vec3) -> float:
    let q = vec3(rotate(time * 0.7) * p.xz, p.y).xzy
    let torus = sdTorus(q, vec2(0.9, 0.28))
    let ball = sdSphere(p - vec3(sin(time) * 1.2, 0.0, 0.0), 0.45)
    return smin(torus, ball, 0.35)

fn normal_at(p: vec3) -> vec3:
    let e = 0.001
    return normalize(vec3(
        scene(p + vec3(e, 0.0, 0.0)) - scene(p - vec3(e, 0.0, 0.0)),
        scene(p + vec3(0.0, e, 0.0)) - scene(p - vec3(0.0, e, 0.0)),
        scene(p + vec3(0.0, 0.0, e)) - scene(p - vec3(0.0, 0.0, e))))

@fragment
fn main(uv: vec2) -> vec4:
    let ro = vec3(0.0, 0.6, 3.2)
    let rd = normalize(vec3((uv - 0.5) * 2.0, -1.6) - vec3(0.0, 0.18, 0.0))
    var t = 0.0
    var hit = false
    for i in range(96):
        let d = scene(ro + rd * t)
        if d < 0.001:
            hit = true
            break
        t += d
        if t > 8.0:
            break
    var col = mix(vec3(0.02, 0.02, 0.05), vec3(0.10, 0.05, 0.20), uv.y)
    if hit:
        let p = ro + rd * t
        let n = normal_at(p)
        let light = normalize(vec3(0.6, 0.8, 0.4))
        let diff = max(dot(n, light), 0.0)
        let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0)
        let base = palette(p.y * 0.4 + time * 0.1, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.95, 0.35, 0.05))
        col = base * (0.15 + diff) + rim * vec3(1.0, 0.45, 0.1)
    return vec4(pow(col, vec3(0.4545)), 1.0)
`,
  },
  mandelbrot: {
    name: 'Mandelbrot',
    model: 'plane',
    source: `# Mandelbrot set with smooth colouring and a slow zoom.
uniform time: float
const MAX_ITER = 200

@fragment
fn main(uv: vec2) -> vec4:
    let zoom = 1.5 / (1.0 + 0.15 * time)
    let c = (uv - 0.5) * 2.0 * zoom + vec2(-0.7436, 0.1318)
    var z = vec2(0.0)
    var n = 0
    while n < MAX_ITER and dot(z, z) < 256.0:
        z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c
        n += 1
    if n == MAX_ITER:
        return vec4(0.0, 0.0, 0.0, 1.0)
    let smooth_n = float(n) - log2(log2(dot(z, z))) + 4.0
    let col = 0.5 + 0.5 * cos(3.0 + smooth_n * 0.15 + vec3(0.0, 0.6, 1.0))
    return vec4(col, 1.0)
`,
  },
  tinted: {
    name: 'Custom colour',
    model: 'icosahedron',
    source: `# Uniforms become live controls in the playground.
uniform time: float
uniform tint: vec3
uniform glow: float

@fragment
fn main(normal: vec3, position: vec3) -> vec4:
    let light = max(dot(normal, normalize(vec3(0.3, 0.8, 0.6))), 0.0)
    let rim = pow(1.0 - abs(normal.z), 2.0) * glow
    let pulse = 0.5 + 0.5 * sin(time * 2.0 + position.y * 4.0)
    return vec4(tint * (0.2 + light) + rim * pulse * tint, 1.0)
`,
    uniforms: { tint: [0.55, 0.4, 1.0], glow: 1.5 },
  },
};

export const KERNELS = {
  saxpy: {
    name: 'SAXPY (y = a·x + y)',
    source: `# SAXPY: y = a * x + y, one GPU thread per element.
uniform a: float
uniform n: int
buffer x: [float]
buffer y: [float]

@kernel(64)
fn saxpy(id: int):
    if id < n:
        y[id] = a * x[id] + y[id]
`,
  },
  primes: {
    name: 'Prime sieve',
    source: `# Mark primes with trial division (integer maths on the GPU).
buffer result: [int]

fn is_prime(n: int) -> bool:
    if n < 2:
        return false
    var d = 2
    while d * d <= n:
        if n % d == 0:
            return false
        d += 1
    return true

@kernel(64)
fn sieve(id: int):
    result[id] = 1 if is_prime(id) else 0
`,
  },
  particles: {
    name: 'Particle physics step',
    source: `# Particle step: gravity, drag and a bouncy floor.
uniform dt: float
uniform count: int
buffer px: [float]
buffer py: [float]
buffer vx: [float]
buffer vy: [float]

const GRAVITY = -9.81
const DRAG = 0.995

@kernel(128)
fn simulate(id: int):
    if id >= count:
        return
    vy[id] += GRAVITY * dt
    vx[id] *= DRAG
    vy[id] *= DRAG
    px[id] += vx[id] * dt
    py[id] += vy[id] * dt
    if py[id] < 0.0:
        py[id] = -py[id]
        vy[id] = -vy[id] * 0.8
`,
  },
};
