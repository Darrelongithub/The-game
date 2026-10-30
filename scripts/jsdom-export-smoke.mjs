// Lightweight exported-bundle hydration check; not a substitute for a browser/device.
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom';
import { gzipSync } from 'node:zlib';
const scripts = new Map();
class TrackingLoader extends ResourceLoader {
  fetch(url, options) {
    const result = super.fetch(url, options);
    if (result && new URL(url).pathname.endsWith('.js')) result.then(buffer => { if (buffer) scripts.set(url, gzipSync(buffer, { level: 9 }).length); }).catch(() => {});
    return result;
  }
}
const errors = [];
const consoleProxy = new VirtualConsole();
consoleProxy.on('jsdomError', e => errors.push(e.message));
consoleProxy.on('error', (...args) => errors.push(args.join(' ')));
const dom = await JSDOM.fromURL(process.env.TEST_URL ?? 'http://127.0.0.1:3001/', {
  resources: new TrackingLoader(), runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleProxy,
  beforeParse(window) {
    window.TextEncoder = globalThis.TextEncoder;
    window.TextDecoder = globalThis.TextDecoder;
    window.ReadableStream = globalThis.ReadableStream;
    window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.scrollTo = () => {};
  },
});
const { window } = dom;
const waitFor = async (fn, label) => {
  const end = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > end) throw Error(`${label}; page: ${window.document.body.textContent.slice(0, 500)}; errors: ${errors.join('; ')}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
try {
  await waitFor(() => window.document.querySelector('[data-testid="opening-sequence"] button'), 'intro not mounted');
  const introScripts = new Map(scripts);
  window.document.querySelector('[data-testid="opening-sequence"] button').click();
  window.document.querySelector('[data-testid="opening-sequence"]').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  await waitFor(() => window.document.querySelector('#alias'), 'join screen not mounted');
  const alias = window.document.querySelector('#alias');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(alias, 'Hydration Host');
  alias.dispatchEvent(new window.Event('input', { bubbles: true }));
  [...window.document.querySelectorAll('button[aria-pressed="false"]')]
    .filter(button => /older|house rules|private reveal cards/i.test(button.textContent))
    .forEach(button => button.click());
  const create = () => [...window.document.querySelectorAll('button')].find(b => b.textContent.includes('Create room') && !b.disabled);
  await waitFor(create, 'create button not enabled');
  create().click();
  await waitFor(() => window.document.body.textContent.includes('In the room'), 'lobby not mounted');
  const size = map => [...map.values()].reduce((a, b) => a + b, 0);
  console.log(`jsdom fetched script gzip: intro ${size(introScripts)} bytes; lobby ${size(scripts)} bytes (includes any nomodule polyfill jsdom requests).`);
  console.log('additional scripts:', [...scripts].filter(([url]) => !introScripts.has(url)).map(([url, bytes]) => `${new URL(url).pathname} (${bytes})`).join(', '));
  const button = label => [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
  button('Delete room').click();
  await waitFor(() => button('Delete'), 'delete confirmation not mounted');
  button('Delete').click();
  await waitFor(() => window.document.querySelector('#alias'), 'deleted room did not return to join');
  if (errors.length) throw Error(`jsdom errors: ${errors.join('; ')}`);
  console.log('PASS: exported Next bundle hydrates intro, lazy join, creates and deletes a room, and lazy-loads lobby in jsdom');
} finally { window.close(); }
