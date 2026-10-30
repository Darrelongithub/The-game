// Real Chromium + real server; synthetic players only, keys disabled by the
// fixture. Run after `npm run build` with CHROMIUM_PATH set to a local browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const executablePath = process.env.CHROMIUM_PATH;
if (!executablePath || !existsSync(executablePath)) {
  throw new Error('Set CHROMIUM_PATH to an installed Chromium/Chrome executable. Run npm run build first.');
}
if (!existsSync(join(root, 'apps/web/out/index.html'))) throw new Error('Run npm run build before the browser test.');

const fixture = spawn(process.execPath, ['--import', 'tsx', join(here, 'browser-fixture.mjs')], {
  cwd: root, env: { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let fixtureOutput = '';
fixture.stderr.on('data', (chunk) => { fixtureOutput += chunk.toString(); });
const port = await new Promise((resolvePort, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Browser fixture did not start: ${fixtureOutput}`)), 15_000);
  fixture.stdout.on('data', (chunk) => {
    fixtureOutput += chunk.toString();
    const match = fixtureOutput.match(/BROWSER_FIXTURE_PORT=(\d+)/);
    if (match) { clearTimeout(timeout); resolvePort(Number(match[1])); }
  });
  fixture.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Browser fixture exited ${code}: ${fixtureOutput}`)); });
});
const base = `http://127.0.0.1:${port}`;
let browser;
const errors = [];
const watch = (page, label) => page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
const waitForRound = (page, index) => page.locator('main header > span').filter({ hasText: new RegExp(`round ${index}\\b`, 'i') }).waitFor({ timeout: 20_000 });
const isVisible = async (locator) => locator.isVisible().catch(() => false);

async function answer(page, label, index) {
  if (await isVisible(page.getByText(/they're talking/i))) return 'spectating';
  if (await isVisible(page.getByTestId('idle-cover'))) return 'spotlight-idle';
  const isVerdict = await isVisible(page.getByTestId('verdict-debate')) || await isVisible(page.getByTestId('verdict-pickgrid'));
  if (isVerdict) await page.getByTestId('verdict-pickgrid').waitFor({ timeout: 10_000 });
  const lock = page.getByRole('button', { name: 'Lock in answer' });
  if (await isVisible(lock)) {
    assert.ok(await lock.isDisabled(), `${label} must select before locking in`);
    await page.locator('main button[aria-pressed]').first().click();
    await lock.click();
    return isVerdict ? 'verdict' : 'pick';
  }
  if (await isVisible(page.locator('#shout'))) {
    await page.locator('#shout').fill('spark');
    await page.getByRole('button', { name: 'Shout it' }).click();
    return 'shout';
  }
  if (await isVisible(page.getByRole('button', { name: 'TAP!' }))) {
    for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'TAP!' }).click();
    return 'minigame'; // auto-submits after five seconds
  }
  if (await isVisible(page.getByRole('button', { name: 'Submit rating' }))) {
    const selects = page.locator('main select');
    for (let i = 0; i < 2; i++) if (!(await selects.nth(i).inputValue())) await selects.nth(i).selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Submit rating' }).click();
    return 'rating';
  }
  if (await isVisible(page.getByRole('button', { name: 'Submit closeness' }))) {
    const select = page.locator('main select');
    if (!(await select.inputValue())) await select.selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Closeness 4 of 7' }).click();
    await page.getByRole('button', { name: 'Submit closeness' }).click();
    return 'ios';
  }
  if (await isVisible(page.locator('#answer'))) {
    const isSpotlight = await page.locator('#answer').getAttribute('maxlength') === '80';
    await page.locator('#answer').fill(`Synthetic answer from ${label} for round ${index}.`);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    return isSpotlight ? 'spotlight' : 'text';
  }
  if (await isVisible(page.getByRole('button', { name: "We're back" }))) {
    await page.getByRole('button', { name: "We're back" }).click(); return 'pair dare';
  }
  if (await isVisible(page.getByRole('button', { name: 'Done', exact: true }))) {
    await page.getByRole('button', { name: 'Done', exact: true }).click(); return 'dare';
  }
  throw new Error(`${label}: no usable input for round ${index}: ${(await page.locator('body').innerText()).slice(0, 500)}`);
}

try {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const makeContext = (reducedMotion) => browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion,
  });
  const [hostContext, guestContext] = await Promise.all([makeContext('no-preference'), makeContext('reduce')]);
  for (const context of [hostContext, guestContext]) await context.addInitScript(() => sessionStorage.setItem('reveal.intro-done', '1'));
  const [host, guest] = await Promise.all([hostContext.newPage(), guestContext.newPage()]);
  watch(host, 'host'); watch(guest, 'guest');

  await host.goto(base);
  assert.equal(await host.locator('.flame-shape').evaluate((el) => getComputedStyle(el).animationName), 'flame-flicker', 'the flame animates under normal motion');
  assert.equal(await host.locator('input[type="checkbox"]').count(), 0, 'entry has no consent checkboxes');
  assert.doesNotMatch(await host.locator('main').innerText(), /18\+|house rules|agree to play respectfully|private cards/i, 'the removed consent text is not on the entry screen');
  await host.locator('#alias').fill('Host');
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await host.getByRole('button', { name: 'Add bot' }).waitFor({ timeout: 10_000 });
  const text = await host.locator('body').innerText();
  const code = text.match(/ROOM CODE\s+([A-Z2-9]{4})/)?.[1];
  assert.ok(code, 'host sees a room code');
  assert.ok(await host.getByRole('button', { name: 'Copy invite link' }).isVisible());

  await guest.goto(`${base}/?room=${code}`);
  const flameDuration = await guest.locator('.flame-shape').evaluate((el) => getComputedStyle(el).animationDuration);
  assert.ok(parseFloat(flameDuration) <= 0.001, 'reduced motion shortens the flame animation');
  assert.equal(await guest.locator('#code').inputValue(), code, 'invite prefills the room code');
  await guest.locator('#alias').fill('Guest');
  await guest.getByRole('button', { name: 'Join room', exact: true }).click();
  await guest.getByText('In the room').waitFor({ timeout: 10_000 });
  await host.getByText('Guest', { exact: true }).waitFor({ timeout: 10_000 });
  await guest.reload();
  await guest.getByText('In the room').waitFor({ timeout: 12_000 });
  assert.ok(await guest.getByText('Guest', { exact: true }).isVisible(), 'guest resumes after reload');
  for (let i = 0; i < 2; i++) {
    await host.getByRole('button', { name: 'Add bot' }).click();
    await host.waitForTimeout(100);
  }
  await host.getByRole('button', { name: /Start the night/ }).click();
  const seenKinds = new Set();
  let callbackSeen = false;
  for (let i = 1; i <= 21; i++) {
    await Promise.all([waitForRound(host, i), waitForRound(guest, i)]);
    for (const [page, name] of [[host, 'host'], [guest, 'guest']]) {
      const question = await page.locator('main h1').first().innerText();
      assert.ok(question.trim().length > 0, `${name} sees round ${i}'s question`);
      assert.doesNotMatch(question, /\{(?:P\d+|S)\}/, 'no unsubstituted placeholder reaches the UI');
      if (await isVisible(page.getByTestId('callback-note'))) {
        callbackSeen = true;
        assert.match(await page.getByTestId('callback-note').innerText(), /Earlier, someone said:/);
      }
    }
    if (i === 1) {
      assert.equal(await host.locator('.question-arrival').evaluate((el) => getComputedStyle(el).animationName), 'content-arrival', 'normal motion has a question entrance');
      const reducedDuration = await guest.locator('.question-arrival').evaluate((el) => getComputedStyle(el).animationDuration);
      assert.ok(parseFloat(reducedDuration) <= 0.001, 'reduced motion shortens the entrance');
    }
    if (i === 2) {
      await guest.reload();
      await waitForRound(guest, i);
    }
    const kinds = await Promise.all([answer(host, 'host', i), answer(guest, 'guest', i)]);
    for (const kind of kinds) seenKinds.add(kind);
    console.log(`round ${i}: ${kinds.join(' / ')}`);
    if (kinds.some((kind) => kind === 'spotlight' || kind === 'spotlight-idle')) {
      await Promise.all([host.getByTestId('caption-wall').waitFor({ timeout: 10_000 }), guest.getByTestId('caption-wall').waitFor({ timeout: 10_000 })]);
      for (const page of [host, guest]) assert.equal(await page.getByTestId('caption-item').count(), 3, 'each non-subject caption appears exactly once');
      assert.equal(await guest.getByTestId('caption-item').first().evaluate((el) => getComputedStyle(el).opacity), '1', 'reduced-motion captions are visible immediately');
    }
    if (kinds.includes('verdict')) {
      await Promise.all([host.getByTestId('ga-subject').waitFor({ timeout: 10_000 }), guest.getByTestId('ga-subject').waitFor({ timeout: 10_000 })]);
    }
  }
  await Promise.all([host.getByTestId('finale-screen').waitFor({ timeout: 20_000 }), guest.getByTestId('finale-screen').waitFor({ timeout: 20_000 })]);
  const finishStory = async (page, label) => {
    for (let tap = 0; tap < 100 && !(await isVisible(page.getByTestId('finale-end'))); tap++) {
      await page.getByTestId('finale-tap-layer').click({ force: true });
      await page.waitForTimeout(180);
    }
    assert.ok(await isVisible(page.getByTestId('finale-end')), `${label} can finish the finale story`);
  };
  await Promise.all([finishStory(host, 'host'), finishStory(guest, 'guest')]);
  assert.equal(await guest.getByTestId('secret-face').count(), 0, 'private cards start face-down');
  const openDeck = guest.getByRole('button', { name: 'Open your secret deck' });
  assert.ok(await isVisible(openDeck), 'synthetic fixture must exercise the private deck');
  await openDeck.click();
  const card = guest.getByTestId('hold-to-reveal');
  await card.waitFor();
  assert.equal(await guest.getByTestId('secret-face').count(), 0, 'face is not mounted before a hold');
  await card.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  await guest.getByTestId('secret-face').waitFor({ timeout: 3000 });
  await card.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  assert.equal(await guest.getByTestId('secret-face').count(), 0, 'release hides the private face');
  await guest.getByRole('button', { name: 'Close secret deck' }).click();
  await guest.getByRole('button', { name: 'Done', exact: true }).click();
  await guest.locator('#alias').waitFor({ timeout: 10_000 });
  for (const kind of ['pick', 'shout', 'minigame', 'rating', 'ios', 'text', 'dare', 'spotlight', 'verdict']) assert.ok(seenKinds.has(kind), `played ${kind}`);
  assert.ok(callbackSeen, 'a real earlier answer appears as a callback');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('BROWSER FLOW PASSED: two real mobile sessions, invite, reload, all 21 rounds, live reveals, complete finale, exit and reduced motion');
} catch (error) {
  if (browser) {
    for (const [i, context] of browser.contexts().entries()) {
      const page = context.pages()[0];
      if (page) await page.screenshot({ path: `/tmp/reveal-browser-failure-${i}.png` }).catch(() => {});
    }
  }
  console.error('BROWSER FLOW FAILED:', error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  fixture.kill('SIGTERM');
  if (fixture.exitCode === null && fixture.signalCode === null) await once(fixture, 'exit').catch(() => {});
}
