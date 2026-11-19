import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

async function createPage(t, { text = 'Enter your email', url = 'https://signin.aws.amazon.com/signup', confirm = false, allow = false, slowAccount = false, cookie = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.UTC(2026, 10, 13) });
  const messages = [];
  const fills = [];
  const clicks = [];
  const listeners = {};
  let releaseAccount;
  const accountReady = slowAccount ? new Promise((resolve) => { releaseAccount = resolve; }) : Promise.resolve();

  class Element {
    constructor(name) {
      this.name = name;
      this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.offsetParent = {};
      this.disabled = false;
      this.innerHTML = '';
      this.innerText = '';
      this.textContent = '';
    }
    appendChild() {}
    focus() {}
    dispatchEvent() { return true; }
    click() { clicks.push(this.name); }
  }
  class Input extends Element {
    get value() { return this._value || ''; }
    set value(value) { this._value = value; fills.push({ name: this.name, value }); }
  }
  class Event {
    constructor(type) { this.type = type; }
  }
  const email = new Input('email');
  const code = new Input('code');
  const submit = new Element('submit');
  submit.innerText = submit.textContent = 'Continue with email';
  const confirmButton = new Element('confirm');
  const allowButton = new Element('allow');
  const cookieButton = new Element('cookie');
  const toast = new Map();
  const document = {
    readyState: 'complete',
    head: new Element('head'),
    body: new Element('body'),
    createElement: (name) => new Element(name),
    getElementById(id) {
      if (!id.startsWith('aws-reg-toast')) return null;
      if (!toast.has(id)) toast.set(id, new Element(id));
      return toast.get(id);
    },
    querySelector(selector) {
      if (cookie && selector === 'button[data-id="awsccc-cb-btn-accept"]') return cookieButton;
      if (confirm && selector.includes('cli_verification_btn')) return confirmButton;
      if (allow && selector.includes('cli_login_button')) return allowButton;
      if (['#email-address', 'input[type="email"]'].includes(selector)) return email;
      if (['input[name="code"]', 'input[name="otp"]', 'input[placeholder="6-digit"]'].includes(selector)) return code;
      if (['button[type="submit"]', 'button[data-testid="continue-email-button"]', 'button[data-testid="test-primary-button"]'].includes(selector)) return submit;
      return null;
    },
    querySelectorAll(selector) { return selector.includes('button') ? [submit] : []; }
  };
  document.body.innerText = text;
  const window = {
    location: new URL(url), HTMLInputElement: Input,
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const chrome = { runtime: {
    onMessage: { addListener() {} },
    async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === 'GET_ACCOUNT_INFO') {
        await accountReady;
        return { email: 'example+test@gmail.com', password: 'Test-password-1', fullName: 'Example User' };
      }
      if (message.type === 'GET_STATE') return { state: { status: 'running', totalTarget: 3, totalRegistered: 0 } };
      if (message.type === 'GET_VERIFICATION_CODE') return { success: true, code: '654321' };
      return { success: true };
    }
  } };
  const tick = async (ms) => {
    await nextTurn();
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(Math.min(100, ms - elapsed));
      await nextTurn();
    }
  };
  t.after(async () => {
    releaseAccount?.();
    listeners.beforeunload?.();
    await tick(1000);
  });
  runInNewContext(await readFile(new URL('./content.js', import.meta.url), 'utf8'), {
    window, document, chrome, Event, InputEvent: Event, URL, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} }
  }, { filename: 'content.js' });
  return { tick, messages, fills, clicks, email, releaseAccount: () => releaseAccount?.() };
}

test('慢账号响应不会导致同一页面重复提交', async (t) => {
  const page = await createPage(t, { slowAccount: true });
  await page.tick(2000);
  page.releaseAccount();
  await page.tick(2000);
  assert.equal(page.email.value, 'example+test@gmail.com');
  assert.deepEqual(page.clicks, ['submit']);
  assert.equal(page.fills.length, 1);
});

for (const fixture of [
  { name: '设备确认按钮', confirm: true, text: 'Verify your code' },
  { name: '设备确认文案', text: 'Confirm and continue' },
  { name: '允许访问按钮', allow: true, text: 'Verify your code' },
  { name: '允许访问文案', text: 'Allow access' },
  { name: '授权完成文案', text: 'Authorization complete' }
]) {
  test(`${fixture.name}优先于验证码表单并终止任务`, async (t) => {
    const page = await createPage(t, { ...fixture, cookie: true, url: 'https://view.awsapps.com/verification' });
    await page.tick(2000);
    const errors = page.messages.filter((message) => message.type === 'REPORT_ERROR');
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /设备配对/);
    assert.deepEqual(page.clicks, []);
    assert.deepEqual(page.fills, []);
  });
}
