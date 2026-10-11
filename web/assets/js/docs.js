// Docs: highlight Pyre code blocks and track the current section in the nav.
import { $$, highlightPyre } from './common.js';

for (const el of $$('code.lang-pyre')) el.innerHTML = highlightPyre(el.textContent);

const links = new Map($$('.docs nav a').map((a) => [a.getAttribute('href').slice(1), a]));
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of links.values()) a.classList.remove('active');
    links.get(e.target.id)?.classList.add('active');
  }
}, { rootMargin: '-20% 0px -70% 0px' });
for (const id of links.keys()) {
  const el = document.getElementById(id);
  if (el) io.observe(el);
}
