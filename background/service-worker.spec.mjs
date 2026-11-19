import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

let instance = 0;
const SIGNUP_URL = 'https://signin.aws.amazon.com/signup?request_type=builderId';

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function createWorkerHarness(t, { seed = {}, windows: initialWindows = [], holdBatchRead = false, failHistoryInitially = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 13) });
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});

  const store = structuredClone(seed);
  const windows = new Map();
  const tabs = new Map();
  const listeners = {};
  const broadcasts = [];
  const created = [];
  const fetchCalls = [];
  const failingCloses = new Set();
  const gates = { batchRead: holdBatchRead ? deferred() : null, history: null, close: null, create: null, fetch: null };
  let failHistory = failHistoryInitially;
  let windowId = 100;
  let tabId = 1000;

  const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
  const emit = (name, ...args) => {
    for (const fn of listeners[name] || []) fn(...args);
  };
  const addWindow = (id, url, openerTabId) => {
    const tab = { id: ++tabId, windowId: id, url, active: true, status: 'complete', openerTabId };
    const window = { id, incognito: true, focused: true, tabs: [tab] };
    windows.set(id, window);
    tabs.set(tab.id, tab);
    return window;
  };
  for (const window of initialWindows) addWindow(window.id, window.url);

  const chrome = {
    storage: { local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = structuredClone(Object.fromEntries(names.map((key) => [key, store[key]])));
        if (names.includes('batchJob') && gates.batchRead) await gates.batchRead.promise;
        return result;
      },
      async set(values) {
        const snapshot = structuredClone(values);
        if (Object.hasOwn(snapshot, 'registrationHistory')) {
          if (gates.history) await gates.history.promise;
          if (failHistory) throw new Error('历史存储失败');
        }
        Object.assign(store, snapshot);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      }
    } },
    runtime: {
      onMessage: event('message'),
      onInstalled: event('installed'),
      async sendMessage(message) { broadcasts.push(structuredClone(message)); }
    },
    alarms: { create() {}, async clear() { return true; }, onAlarm: event('alarm') },
    windows: {
      onRemoved: event('removed'),
      async create(options) {
        assert.equal(options.url, SIGNUP_URL);
        assert.equal(options.incognito, true);
        const window = addWindow(++windowId, options.url);
        created.push(window.id);
        if (gates.create) await gates.create.promise;
        return structuredClone(window);
      },
      async get(id) {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`);
        return structuredClone(windows.get(id));
      },
      async remove(id) {
        if (gates.close) await gates.close.promise;
        if (failingCloses.has(id)) throw new Error('窗口关闭失败');
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`);
        for (const tab of windows.get(id).tabs) tabs.delete(tab.id);
        windows.delete(id);
        emit('removed', id);
      },
      async create(options) {
        const window = addWindow(++windowId, options.url);
        created.push(window.id);
        return structuredClone(window);
      }
    },
    tabs: {
      onUpdated: event('updated'),
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        return structuredClone(tabs.get(id));
      },
      async query({ windowId: id }) {
        return structuredClone([...tabs.values()].filter((tab) => tab.windowId === id));
      },
      async update(id, changes) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
        const tab = tabs.get(id);
        if (changes.url) {
          tab.pendingUrl = changes.url;
          for (const listener of listeners.updated || []) {
            listener(id, { status: 'loading', url: changes.url }, structuredClone(tab));
          }
        }
        Object.assign(tab, changes);
        if (changes.url) {
          for (const listener of listeners.updated || []) {
            listener(id, { status: 'complete', url: changes.url }, structuredClone(tabs.get(id)));
          }
        }
        return structuredClone(tabs.get(id));
      },
      async sendMessage() {}
    }
  };

  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    if (gates.fetch) await gates.fetch.promise;
    return { status: 200, text: async () => '<div class="code">654321</div>' };
  };

  const flush = () => nextTurn();
  const tick = async (ms) => {
    await flush();
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      t.mock.timers.tick(Math.min(500, ms - elapsed));
      await flush();
    }
    await flush();
  };
  const send = (message, sender = {}) => new Promise((resolve, reject) => {
    try {
      listeners.message[0](structuredClone(message), structuredClone(sender), (response) => resolve(structuredClone(response)));
    } catch (error) { reject(error); }
  });
  const release = (name) => {
    const gate = gates[name];
    gates[name] = null;
    gate?.release();
  };
  const currentSender = () => {
    const id = [...created].reverse().find((id) => windows.has(id));
    assert.ok(id, '当前任务应有注册窗口');
    return { tab: structuredClone(windows.get(id).tabs[0]) };
  };

  const harness = {
    send, tick, store, windows, created, broadcasts, fetchCalls, failingCloses, currentSender,
    async state() { return (await send({ type: 'GET_STATE' })).state; },
    start(loopCount = 1, extra = {}) {
      return send({ type: 'START_BATCH_REGISTRATION', loopCount, emailMode: 'gmail', gmailAddress: 'example@gmail.com', ...extra });
    },
    finish(success = true, sender = currentSender()) {
      return send(success
        ? { type: 'QUOTA_PAGE_RESULT', success: true, quotaValue: '8' }
        : { type: 'REPORT_ERROR', error: '测试注册失败' }, sender);
    },
    async addPage(url, openerTabId) {
      const window = addWindow(++windowId, url, openerTabId);
      const tab = window.tabs[0];
      for (const listener of listeners.updated || []) {
        listener(tab.id, { status: 'loading', url }, structuredClone(tab));
        listener(tab.id, { status: 'complete', url }, structuredClone(tab));
      }
      await flush();
      return structuredClone(tab);
    },
    dispatch(message, sender) {
      listeners.message[0](structuredClone(message), structuredClone(sender), () => {});
    },
    setTabUrl(id, url) {
      const tab = tabs.get(id);
      tab.url = url;
      tab.pendingUrl = undefined;
    },
    tabUrl(id) {
      return tabs.get(id)?.url;
    },
    async attachConsole() {
      const sender = currentSender();
      const consoleWindow = addWindow(++windowId, 'https://console.aws.amazon.com/console/home', sender.tab.id);
      const tab = consoleWindow.tabs[0];
      send({ type: 'PAGE_DETECTED', pageType: 'console' }, { tab }).catch(() => {});
      for (const listener of listeners.updated || []) {
        listener(tab.id, { status: 'loading', url: tab.url }, structuredClone(tab));
      }
      for (const listener of listeners.updated || []) {
        listener(tab.id, { status: 'complete', url: tab.url }, structuredClone(tab));
      }
      await flush();
      return { tab: structuredClone(tab) };
    },
    async sendQuotaResult(success, error = null, sender = currentSender()) {
      return send({
        type: 'QUOTA_PAGE_RESULT',
        success,
        quotaValue: success ? '8' : null,
        error
      }, sender);
    },
    hold(name) { gates[name] = deferred(); },
    release,
    failHistory(value) { failHistory = value; },
    async dispose() {
      failHistory = false;
      failingCloses.clear();
      for (const name of Object.keys(gates)) release(name);
      const stopping = send({ type: 'STOP_REGISTRATION' });
      await tick(10000);
      await stopping;
      globalThis.chrome = oldChrome;
      globalThis.fetch = oldFetch;
    }
  };
  t.after(() => harness.dispose());
  await import(`${new URL('./service-worker.js', import.meta.url)}?spec=${++instance}`);
  await flush();
  return harness;
}

function legacyJob(extra = {}) {
  return {
    active: true, loopCount: 3, remaining: 2, concurrency: 1,
    mode: 'gmail', gmailAddress: 'example@gmail.com', domains: [],
    totalRegistered: 0, totalFailed: 0, inFlight: null, ...extra
  };
}

for (const loopCount of [0, -1, 101, 1.5, '3', null]) {
  test(`拒绝非法注册数量 ${JSON.stringify(loopCount)}`, async (t) => {
    const h = await createWorkerHarness(t);
    const response = await h.start(loopCount);
    assert.equal(response.success, false);
    assert.equal(h.created.length, 0);
  });
}

test('旧启动消息带并发参数时也只能有一个活动注册任务', async (t) => {
  const h = await createWorkerHarness(t);
  assert.equal((await h.start(3, { concurrency: 3 })).success, true);
  await h.tick(7000);
  assert.equal(h.created.length, 1);
  assert.equal((await h.state()).sessions.length, 1);
  assert.equal(Object.hasOwn(h.store.batchJob, 'concurrency'), false);
});

test('三个成功失败混合任务按顺序完成且各计数一次', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(3);
  await h.tick(1000);
  for (const [index, success] of [true, false, true].entries()) {
    assert.equal(h.created.length, index + 1);
    await h.finish(success);
    await h.tick(index < 2 ? 4000 : 1000);
  }
  const state = await h.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.totalRegistered, 2);
  assert.equal(state.totalFailed, 1);
  assert.equal(state.history.length, 3);
  assert.equal(h.windows.size, 0);
});

test('结果保存及两个关联窗口关闭之前不能清除在途记录或执行下一任务', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(2);
  await h.tick(1000);
  const consoleSender = await h.attachConsole();
  await h.tick(11000);
  const consoleTab = [...h.windows.values()].flatMap((window) => window.tabs)
    .find((tab) => tab.windowId === consoleSender.tab.windowId);
  h.hold('history');
  h.hold('close');
  await h.finish(true, { tab: consoleTab });
  await h.tick(1000);
  assert.ok(h.store.batchJob.inFlight);
  assert.equal(h.created.length, 1);
  h.release('history');
  await h.tick(0);
  assert.equal(h.store.batchJob.inFlight.stage, 'settled');
  assert.equal(h.windows.size, 2);
  assert.equal(h.created.length, 1);
  h.release('close');
  await h.tick(2000);
  assert.equal(h.created.length, 2);
  assert.equal(h.windows.size, 1);
});

test('自动 EC2 流程在配额检查失败后仍进入启动页并保留注册成功结果', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(1, { autoBootEnabled: true });
  await h.tick(1000);
  const signupTab = h.currentSender().tab;
  const quotaTab = await h.addPage('https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A', signupTab.id);
  await h.send({
    type: 'QUOTA_PAGE_RESULT',
    success: false,
    quotaValue: null,
    error: '配额页面数据加载失败'
  }, { tab: quotaTab });
  const launchTab = h.windows.get(quotaTab.windowId).tabs[0];
  await new Promise((resolve) => setImmediate(resolve));
  h.setTabUrl(launchTab.id, 'https://console.aws.amazon.com/ec2/home?region=us-east-2#LaunchInstances:');
  await h.tick(1000);

  assert.match(launchTab.url, /LaunchInstances/);
  h.dispatch({
    type: 'AUTO_BOOT_PREFILL_RESULT',
    success: true,
    note: '实例数 1，预填完成'
  }, { tab: launchTab });
  h.dispatch({
    type: 'QUOTA_PAGE_RESULT',
    success: false,
    error: '配额页面数据加载失败'
  }, { tab: quotaTab });
  await h.tick(1000);
  const state = await h.state();
  assert.equal(launchTab.url.includes('LaunchInstances'), true);
  assert.equal(state.history[0]?.success, true);
});

test('开发测试入口拒绝非 EC2 Quotas 页面并且不点击启动', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(1);
  await h.tick(1000);
  const tab = await h.addPage('https://console.aws.amazon.com/ec2/home?region=us-east-2', h.currentSender().tab.id);
  const response = await h.send({ type: 'DEV_START_EC2_AUTO_BOOT_TEST', tabId: tab.id }, { tab });
  assert.equal(response.success, false);
  assert.match(response.error, /Quotas/);
});

test('starttest 直接接管已登录的 Quotas 标签页，stoptest 保留窗口并返回 Quotas，可重复测试', async (t) => {
  const h = await createWorkerHarness(t);
  const quotaUrl = 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A';
  const quotaTab = await h.addPage(quotaUrl);
  const idleInfo = await h.send({ type: 'GET_ACCOUNT_INFO' }, { tab: quotaTab });
  assert.equal(idleInfo.devTest, undefined);

  for (let round = 0; round < 2; round++) {
    const run = await h.send({ type: 'DEV_START_EC2_AUTO_BOOT_TEST', tabId: quotaTab.id });
    assert.equal(run.success, true);
    await h.tick(0);
    assert.match(h.tabUrl(quotaTab.id), /LaunchInstances/);
    const accountInfo = await h.send({ type: 'GET_ACCOUNT_INFO' }, { tab: quotaTab });
    assert.equal(accountInfo.devTest, true);
    await h.send({ type: 'AUTO_BOOT_PREFILL_RESULT', success: true, note: '已预填；未启动' }, { tab: quotaTab });
    await h.tick(0);
    assert.equal((await h.state()).devTestStatus, 'settled');
    assert.equal(h.windows.has(quotaTab.windowId), true);

    const stopped = await h.send({ type: 'DEV_STOP_EC2_AUTO_BOOT_TEST', tabId: quotaTab.id });
    assert.equal(stopped.success, true);
    await h.tick(0);
    assert.equal(h.windows.has(quotaTab.windowId), true);
    assert.equal(h.tabUrl(quotaTab.id), quotaUrl);
    assert.equal((await h.state()).devTestStatus, 'idle');
  }
});

test('同一会话只允许点击一次 Launch，未开始测试的页面不允许开机', async (t) => {
  const h = await createWorkerHarness(t);
  const quotaTab = await h.addPage('https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A');
  assert.equal((await h.send({ type: 'AUTO_BOOT_CLAIM' }, { tab: quotaTab })).allowed, false);
  await h.send({ type: 'DEV_START_EC2_AUTO_BOOT_TEST', tabId: quotaTab.id });
  await h.tick(0);
  assert.equal((await h.send({ type: 'AUTO_BOOT_CLAIM' }, { tab: quotaTab })).allowed, true);
  assert.equal((await h.send({ type: 'AUTO_BOOT_CLAIM' }, { tab: quotaTab })).allowed, false);
});

test('startInstance 打开无痕窗口但不绑定会话，直到在该窗口点击 starttest', async (t) => {
  const h = await createWorkerHarness(t);
  const started = await h.send({ type: 'DEV_START_EC2_AUTO_BOOT_WINDOW' });
  assert.equal(started.success, true);
  assert.equal(h.windows.has(started.windowId), true);
  assert.equal((await h.state()).devTestStatus, 'idle');
});

test('停止响应等待当前窗口收尾并阻止再次启动', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(2);
  await h.tick(1000);
  h.hold('close');
  let acknowledged = false;
  const stopping = h.send({ type: 'STOP_REGISTRATION' }).then((response) => { acknowledged = true; return response; });
  await h.tick(2000);
  assert.equal(acknowledged, false);
  assert.equal((await h.start()).success, false);
  h.release('close');
  await h.tick(1000);
  assert.equal((await stopping).success, true);
  assert.equal(h.created.length, 1);
  assert.equal(h.windows.size, 0);
  assert.equal((await h.state()).status, 'idle');
  assert.equal(h.store.batchJob, undefined);
});

test('重置等待晚返回的窗口创建完成并清理后才允许新批次', async (t) => {
  const h = await createWorkerHarness(t);
  h.hold('create');
  await h.start(2);
  await h.tick(0);
  let acknowledged = false;
  const resetting = h.send({ type: 'RESET' }).then((response) => { acknowledged = true; return response; });
  await h.tick(0);
  assert.equal(acknowledged, false);
  assert.equal((await h.start()).success, false);
  h.release('create');
  await h.tick(2000);
  assert.equal((await resetting).success, true);
  assert.equal(h.windows.size, 0);
  assert.equal((await h.start()).success, true);
  await h.tick(1000);
  assert.equal(h.created.length, 2);
  assert.equal((await h.state()).totalTarget, 1);
});

test('历史保存失败阻止下一任务且重置能重试已确认的成功结果', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(2);
  await h.tick(1000);
  h.failHistory(true);
  await h.finish();
  await h.tick(5000);
  assert.equal(h.created.length, 1);
  assert.equal((await h.state()).status, 'error');
  assert.equal((await h.start()).success, false);
  h.failHistory(false);
  assert.equal((await h.send({ type: 'RESET' })).success, true);
  assert.equal(h.store.registrationHistory.length, 1);
  assert.equal(h.store.registrationHistory[0].success, true);
  assert.equal(h.windows.size, 0);
});

test('关联窗口关闭失败保留已结算任务并阻止下一任务', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(2);
  await h.tick(1000);
  h.failingCloses.add(h.currentSender().tab.windowId);
  await h.finish();
  await h.tick(5000);
  assert.equal(h.created.length, 1);
  assert.equal((await h.state()).status, 'error');
  assert.equal(h.store.batchJob.inFlight.stage, 'settled');
  assert.equal((await h.start()).success, false);
  h.failingCloses.clear();
  assert.equal((await h.send({ type: 'RESET' })).success, true);
  assert.equal(h.store.registrationHistory.length, 1);
  assert.equal(h.windows.size, 0);
});

test('旧并发批次仅清理已记录窗口并结束剩余队列', async (t) => {
  const h = await createWorkerHarness(t, {
    seed: { batchJob: legacyJob({ concurrency: 3, inFlight: {
      email: 'old@example.com', password: 'old-password', windowId: 71, consoleWindowId: 72
    } }) },
    windows: [{ id: 71, url: SIGNUP_URL }, { id: 72, url: 'https://console.aws.amazon.com/console/home' }, { id: 99, url: 'https://example.com/' }]
  });
  await h.tick(7000);
  assert.equal(h.created.length, 0);
  assert.deepEqual([...h.windows.keys()], [99]);
  assert.equal(h.store.batchJob, undefined);
  const history = (await h.state()).history;
  assert.equal(history.length, 1);
  assert.equal(history[0].success, false);
  assert.equal(Object.hasOwn(history[0], 'token'), false);
});

test('恢复已结算任务只补窗口收尾而不重复记账', async (t) => {
  const record = { id: 1, attemptId: 'saved-attempt', email: 'saved@example.com', password: 'saved-password', success: true, note: '原结果' };
  const h = await createWorkerHarness(t, {
    seed: { registrationHistory: [record], batchJob: legacyJob({
      remaining: 0, totalRegistered: 1, inFlight: { id: 'saved-attempt', stage: 'settled', ...record, windowId: 71, consoleWindowId: 72 }
    }) },
    windows: [{ id: 71, url: SIGNUP_URL }, { id: 72, url: 'https://console.aws.amazon.com/console/home' }]
  });
  await h.tick(1000);
  const state = await h.state();
  assert.deepEqual(state.history, [record]);
  assert.equal(state.totalRegistered, 1);
  assert.equal(state.totalFailed, 0);
  assert.equal(h.windows.size, 0);
  assert.equal(h.store.batchJob, undefined);
});

test('恢复读取存储期间拒绝新批次启动', async (t) => {
  const h = await createWorkerHarness(t, { seed: { batchJob: legacyJob() }, holdBatchRead: true });
  assert.equal((await h.start()).success, false);
  h.release('batchRead');
  await h.tick(1000);
  assert.equal(h.created.length, 1);
});

test('恢复读取存储期间停止不会重新启动旧队列', async (t) => {
  const h = await createWorkerHarness(t, { seed: { batchJob: legacyJob() }, holdBatchRead: true });
  const stopping = h.send({ type: 'STOP_REGISTRATION' });
  h.release('batchRead');
  await h.tick(3000);
  assert.equal((await stopping).success, true);
  assert.equal(h.created.length, 0);
  assert.equal(h.store.batchJob, undefined);
});

test('恢复读取存储期间重置必须等待旧批次完成收尾', async (t) => {
  const h = await createWorkerHarness(t, {
    seed: { batchJob: legacyJob({ inFlight: { email: 'old@example.com', windowId: 71 } }) },
    windows: [{ id: 71, url: SIGNUP_URL }], holdBatchRead: true
  });
  let acknowledged = false;
  const resetting = h.send({ type: 'RESET' }).then((response) => { acknowledged = true; return response; });
  await h.tick(0);
  assert.equal(acknowledged, false);
  assert.equal((await h.start()).success, false);
  h.release('batchRead');
  await h.tick(1000);
  assert.equal((await resetting).success, true);
  assert.equal(h.windows.size, 0);
  assert.equal(h.created.length, 0);
  assert.equal(h.store.batchJob, undefined);
});

test('历史迁移失败不能丢弃未读取的批次且重置能重试迁移和收尾', async (t) => {
  const job = legacyJob({ inFlight: { email: 'pending@example.com', windowId: 71 } });
  const record = { id: 7, email: 'saved@example.com', success: true, metadata: '保留' };
  const h = await createWorkerHarness(t, {
    seed: { batchJob: job, registrationHistory: [{ ...record, token: 'legacy-token' }] },
    windows: [{ id: 71, url: SIGNUP_URL }], failHistoryInitially: true
  });
  assert.equal((await h.send({ type: 'RESET' })).success, false);
  assert.deepEqual(h.store.batchJob, job);
  assert.equal(h.windows.has(71), true);
  h.failHistory(false);
  const resetting = h.send({ type: 'RESET' });
  await h.tick(1000);
  assert.equal((await resetting).success, true);
  assert.equal(h.store.batchJob, undefined);
  assert.equal(h.windows.size, 0);
  assert.ok(h.store.registrationHistory.some((item) => item.id === 7 && item.metadata === '保留'));
  assert.ok(h.store.registrationHistory.every((item) => !Object.hasOwn(item, 'token')));
});

test('旧历史仅移除 token 并回存且保留账号、自定义字段与收信配置', async (t) => {
  const record = { id: 7, email: 'old@example.com', password: 'saved', success: true, metadata: { source: 'user' } };
  const h = await createWorkerHarness(t, { seed: {
    registrationHistory: [{ ...record, token: { accessToken: 'legacy-aws-token' } }],
    mailApiToken: 'mail-token', gmailForwardApiToken: 'forward-token'
  } });
  assert.deepEqual((await h.state()).history, [record]);
  assert.deepEqual((await h.send({ type: 'EXPORT_HISTORY' })).history, [record]);
  assert.deepEqual(h.store.registrationHistory, [record]);
  assert.equal(h.store.mailApiToken, 'mail-token');
  assert.equal(h.store.gmailForwardApiToken, 'forward-token');
});

test('域名邮箱仍将收信 Token 和本任务邮箱传给邮件服务', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(1, { emailMode: 'domain', domains: ['example.test'], mailServerUrl: 'https://mail.example', mailApiToken: 'mail-token' });
  await h.tick(1000);
  const sender = h.currentSender();
  const account = await h.send({ type: 'GET_ACCOUNT_INFO' }, sender);
  const result = await h.send({ type: 'GET_VERIFICATION_CODE' }, sender);
  assert.deepEqual(result, { success: true, code: '654321' });
  const url = new URL(h.fetchCalls[0]);
  assert.equal(url.pathname, '/Mail');
  assert.equal(url.searchParams.get('token'), 'mail-token');
  assert.equal(url.searchParams.get('mail'), account.email);
});

test('已停止任务的收信响应不能再返回可用验证码或影响新批次', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start(1, { emailMode: 'domain', domains: ['example.test'], mailServerUrl: 'https://mail.example', mailApiToken: 'mail-token' });
  await h.tick(1000);
  h.hold('fetch');
  const lookup = h.send({ type: 'GET_VERIFICATION_CODE' }, h.currentSender());
  await h.tick(0);
  const stopping = h.send({ type: 'STOP_REGISTRATION' });
  await h.tick(2000);
  await stopping;
  await h.start(2);
  await h.tick(1000);
  h.release('fetch');
  assert.equal((await lookup).success, false);
  assert.equal((await h.state()).totalTarget, 2);
  assert.equal((await h.state()).totalRegistered, 0);
});

test('废弃授权完成消息不会结束当前注册任务', async (t) => {
  const h = await createWorkerHarness(t);
  await h.start();
  await h.tick(1000);
  const response = await h.send({ type: 'AUTH_COMPLETED' }, h.currentSender());
  assert.ok(response.error);
  await h.tick(1000);
  assert.equal((await h.state()).status, 'running');
  assert.equal((await h.state()).history.length, 0);
});
