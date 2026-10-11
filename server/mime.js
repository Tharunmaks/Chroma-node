// Content types for served files. Unknown types are sent as binary.
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', pdf: 'application/pdf',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain; charset=utf-8', hdr: 'application/octet-stream',
  pyre: 'text/plain; charset=utf-8', glsl: 'text/plain; charset=utf-8', wgsl: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

export function mimeType(file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

export const isHtml = (file) => /\.html?$/i.test(file);
