/**
 * Service Worker - 后台服务
 * 管理注册状态和流程控制，批量任务逐个串行执行
 */

import { GmailAliasClient } from '../lib/mail-api.js';
import { generateDomainEmail, fetchDomainVerificationCode, fetchReadyAccountMail, verificationLookupEmail } from '../lib/domain-mail.js';
import { generatePassword, generateName, generateEmailPrefix } from '../lib/utils.js';
import { BUILDER_SIGNUP_URL, EC2_QUOTA_URL, EC2_LAUNCH_URL, isConsoleUrl, planAfterDomainBlock, markDomainBlocked } from '../lib/signup-page.js';

// 邮箱配置。域名模式在每次注册时随机选域名并生成邮箱名。
let gmailBaseAddress = '';
let registrationConfig = {
  mode: 'gmail',
  domains: [],
  mailServerUrl: '',
  mailApiToken: '',
  gmailForwardEnabled: false,
  gmailForwardAddress: '',
  gmailForwardServerUrl: '',
  gmailForwardApiToken: ''
};

// ============== 全局状态 ==============

// 主状态
let globalState = {
  status: 'idle', // idle, running, completed, error
  step: '',
  error: null,
  totalTarget: 0,      // 目标注册数
  totalRegistered: 0,  // 已成功注册数
  totalFailed: 0,      // 失败数
  lastSuccess: null    // 最后一个成功的记录
};

// 执行占用持续到结果保存、关联窗口关闭和批次清理完成。
let activeSession = null;
let activeRun = null;
let sessionIdCounter = 0;

// 任务队列
let taskQueue = [];
let stopReason = '';
let stateWrites = Promise.resolve();

// 注册历史记录
let registrationHistory = [];
async function restoreHistory() {
  const stored = await chrome.storage.local.get(['registrationHistory']);
  if (Array.isArray(stored.registrationHistory)) {
    const records = stored.registrationHistory;
    registrationHistory = records.map(({ token, ...record }) => record);
    if (records.some((record) => Object.prototype.hasOwnProperty.call(record, 'token'))) {
      await chrome.storage.local.set({ registrationHistory });
    }
    console.log('[Service Worker] 恢复历史记录:', registrationHistory.length, '条');
  }
}
let historyReady = restoreHistory();

const BATCH_ALARM = 'registration-batch-watch';
const SIGNUP_TIMEOUT_MS = 600000;
const READY_MAIL_MAX_CHECKS = 1;
const READY_MAIL_NOTE = '未收到Ready邮件';
const CONSOLE_LOAD_FALLBACK_MS = 30000;
const CONSOLE_COUNTDOWN_TICK_MS = 1000;
const QUOTA_PAGE_TIMEOUT_MS = 60000;
const DEV_TEST_PREFIX = 'aws-ec2-dev-test-';
let batchJob = null;

// 串行任务仍可能收到异步消息；注册状态的落盘也必须有序。
function writeState(operation) {
  const pending = stateWrites.then(operation);
  stateWrites = pending.catch(() => {});
  return pending.catch((error) => {
    error.persistenceError = true;
    throw error;
  });
}

function createRun() {
  let resolveDone;
  const run = {
    stopRequested: false,
    stateLoaded: false,
    error: null,
    done: new Promise((resolve) => { resolveDone = resolve; }),
    resolveDone: () => resolveDone()
  };
  activeRun = run;
  return run;
}

async function executeRun(run, operation) {
  try {
    await operation();
  } catch (error) {
    run.error = error;
    updateGlobalState({ status: 'error', error: error.message, step: `任务暂停，收尾未完成：${error.message}` });
  } finally {
    if (activeRun === run && !run.error && !batchJob && !activeSession && !run.resetRequested) activeRun = null;
    run.resolveDone();
  }
}

function sessionIsActive(session) {
  if (!session || activeSession !== session || session.signupResult || session.closing) return false;
  if (session.devTest) return true;
  return Boolean(activeRun === session.run && !session.run.stopRequested);
}

function checkSessionStopped(session) {
  if (activeRun !== session.run || session.run.stopRequested) throw new Error('注册已中断');
}

function rememberBatchConfig() {
  return {
    mode: registrationConfig.mode,
    domains: registrationConfig.domains,
    mailServerUrl: registrationConfig.mailServerUrl,
    mailApiToken: registrationConfig.mailApiToken,
    gmailAddress: gmailBaseAddress,
    gmailForwardEnabled: registrationConfig.gmailForwardEnabled,
    gmailForwardAddress: registrationConfig.gmailForwardAddress,
    gmailForwardServerUrl: registrationConfig.gmailForwardServerUrl,
    gmailForwardApiToken: registrationConfig.gmailForwardApiToken
  };
}

async function persistBatchJob() {
  await writeState(async () => {
    if (!batchJob?.active) await chrome.storage.local.remove('batchJob');
    else await chrome.storage.local.set({ batchJob });
  });
}

function watchBatch() {
  chrome.alarms.create(BATCH_ALARM, { periodInMinutes: 1 });
}

async function rememberSessionWindow(session) {
  await writeState(async () => {
    if (activeSession !== session || !batchJob?.active || batchJob.inFlight?.id !== session.id) return;
    Object.assign(batchJob.inFlight, {
      email: session.email, password: session.password,
      firstName: session.firstName, lastName: session.lastName,
      windowId: session.windowId || null, consoleWindowId: session.consoleWindowId || null,
      windowIds: [...session.windowIds]
    });
    await chrome.storage.local.set({ batchJob });
  });
}

async function windowHasConsole(windowId) {
  if (!windowId) return false;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.some((tab) => isConsoleUrl(tab.url || tab.pendingUrl || ''));
  } catch {
    return false;
  }
}

async function findWindowTab(windowId) {
  if (!windowId) return null;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.find((tab) => tab.active) || tabs[0] || null;
  } catch {
    return null;
  }
}

async function navigateToQuotaPage(session) {
  if (!sessionIsActive(session) || session.quotaNavigationStarted) return;
  // Set this before awaiting tab lookup so parallel triggers cannot navigate twice.
  session.quotaNavigationStarted = true;
  const tab = await findWindowTab(session.consoleWindowId || session.windowId);
  if (!sessionIsActive(session)) return;
  if (!tab?.id) {
    session.quotaNavigationStarted = false;
    finishSession(session, { success: false, error: '进入控制台后找不到浏览器标签页' });
    return;
  }
  session.quotaTabId = tab.id;
  session.quotaNavigationStartedAt = Date.now();
  updateSession(session.id, { step: '打开 EC2 Quotas 页面...' });
  try {
    const quotaNavigation = chrome.tabs.update(tab.id, { url: EC2_QUOTA_URL });
    // Ready-mail lookup is informational only and is deliberately decoupled
    // from navigation and registration success/failure.
    session.readyMailChecks = 1;
    session.readyMailCheckPromise = sessionHasReadyMail(session)
      .then((received) => { if (sessionIsActive(session)) session.readyMailReceived = Boolean(received); })
      .catch((error) => {
        console.warn(`[Session ${session.id}] Ready 邮件检查失败:`, error.message);
        session.readyMailReceived = false;
      });
    await quotaNavigation;
    setTimeout(() => {
      if (sessionIsActive(session) && session.quotaNavigationStarted && !session.quotaPageResult) {
        finishQuotaPage(session, {
          success: false,
          error: 'EC2 Quotas 页面加载或检查超时'
        });
      }
    }, QUOTA_PAGE_TIMEOUT_MS);
  } catch (error) {
    finishSession(session, { success: false, error: `无法打开 EC2 Quotas 页面: ${error.message}` });
  }
}

function startAutoBootPage(session) {
  if (!sessionIsActive(session) || session.autoBootNavigationStarted) return;
  session.autoBootNavigationStarted = true;
  session.autoBootPrefillResult = null;
  if (!session.quotaTabId) {
    session.autoBootPrefillResult = { success: false, error: '找不到 EC2 Quotas 标签页' };
    finalizeQuotaSession(session);
    return;
  }
  updateSession(session.id, { step: '打开 EC2 启动配置页...' });
  chrome.tabs.update(session.quotaTabId, {
    url: EC2_LAUNCH_URL
  }).catch((error) => {
    session.autoBootPrefillResult = {
      success: false,
      error: `无法打开 EC2 启动配置页: ${error.message}`
    };
    finalizeQuotaSession(session);
  });
}

function createDevTestSession(windowId, tabId, step) {
  return {
    id: `${DEV_TEST_PREFIX}${Date.now()}`,
    devTest: true,
    autoBootEnabled: false,
    signupResult: null,
    status: 'running',
    step,
    windowId,
    consoleWindowId: windowId,
    quotaTabId: tabId,
    tabId,
    tabIds: new Set([tabId]),
    windowIds: new Set([windowId]),
    closedWindowIds: new Set(),
    quotaNavigationStarted: false,
    quotaPageResult: null,
    autoBootPrefillResult: null,
    autoBootPrefillReceived: false
  };
}

function devTestBlockedByRegistration() {
  return Boolean(activeRun || (activeSession && !activeSession.devTest));
}

// The test session is bound to whichever tab the user is on, so a logged-in
// window survives extension reloads and worker restarts without a new login.
async function startDevAutoBootTest(tabId) {
  let senderTab;
  try {
    senderTab = await chrome.tabs.get(tabId);
  } catch {}
  const url = senderTab?.url || '';
  const onQuotaPage = /\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(url);
  const onLaunchPage = /\/ec2\/home/i.test(url) && /LaunchInstances:/i.test(url);
  if (!senderTab?.id || (!onQuotaPage && !onLaunchPage)) {
    return { success: false, error: '请先在已登录的 EC2 Quotas 页面点击 starttest' };
  }
  if (devTestBlockedByRegistration()) {
    return { success: false, error: '请先结束当前注册任务，再开始开发测试' };
  }

  const session = createDevTestSession(senderTab.windowId, senderTab.id, '开发测试：打开 EC2 启动配置页...');
  session.autoBootEnabled = true;
  session.quotaPageResult = { success: true, quotaValue: null };
  session.quotaNavigationStarted = true;
  session.quotaNavigationStartedAt = Date.now();
  activeSession = session;
  updateGlobalState({ status: 'running', step: session.step, error: null });
  startAutoBootPage(session);
  return { success: true, windowId: senderTab.windowId };
}

async function startDevTestWindow() {
  if (devTestBlockedByRegistration()) {
    return { success: false, error: '请先结束当前注册任务，再启动开发测试窗口' };
  }
  const window = await chrome.windows.create({
    url: 'https://signin.aws.amazon.com/',
    incognito: true,
    focused: true,
    width: 1100,
    height: 850
  });
  const tab = window?.tabs?.[0];
  if (!window?.id || !tab?.id) throw new Error('无法创建开发测试无痕窗口');
  const step = '开发测试：请手动登录并打开 EC2 Quotas 页面，然后点击 starttest';
  if (activeSession?.devTest) activeSession = null;
  updateGlobalState({ status: 'idle', step, error: null });
  return { success: true, windowId: window.id, tabId: tab.id };
}

// Keeps the window open so the AWS login can be reused by the next starttest.
async function stopDevTestWindow(tabId) {
  const session = activeSession?.devTest ? activeSession : null;
  const targetTabId = session?.quotaTabId || tabId;
  if (session) activeSession = null;
  if (targetTabId) {
    try {
      await chrome.tabs.update(targetTabId, { url: EC2_QUOTA_URL });
    } catch (error) {
      console.warn('[Service Worker] 开发测试：无法返回 EC2 Quotas 页面:', error.message);
    }
  }
  updateGlobalState({ status: 'idle', step: '开发测试已结束，可再次点击 starttest', error: null });
  return { success: true };
}

async function closeWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.remove(windowId);
  } catch (error) {
    try {
      await chrome.windows.get(windowId);
    } catch (lookupError) {
      if (/no window|not found|does not exist/i.test(lookupError.message)) return;
      throw error;
    }
    throw error;
  }
}

async function closeSessionWindows(session) {
  if (session) {
    session.closing = true;
    const closed = new Set();
    while (true) {
      const ids = [...new Set([
        ...session.windowIds, session.windowId, session.consoleWindowId
      ].filter(Boolean))].filter((id) => !closed.has(id));
      if (!ids.length) break;
      for (const id of ids) {
        await closeWindow(id);
        closed.add(id);
      }
    }
    session.windowId = null;
    session.consoleWindowId = null;
    session.tabId = null;
  }
}

async function clearBatchJob() {
  await writeState(async () => {
    await chrome.storage.local.remove('batchJob');
    await chrome.alarms.clear(BATCH_ALARM);
    batchJob = null;
  });
}

async function markAttemptStarted(session) {
  if (!batchJob?.active) return;
  batchJob.remaining = Math.max(0, batchJob.remaining - 1);
  batchJob.inFlight = {
    id: session.id,
    stage: 'running',
    email: session.email,
    password: session.password,
    firstName: session.firstName,
    lastName: session.lastName,
    startedAt: Date.now(),
    windowIds: []
  };
  await persistBatchJob();
}

async function markAttemptFinished(session) {
  await writeState(async () => {
    if (batchJob?.inFlight?.id !== session.id) return;
    await chrome.storage.local.set({ batchJob: { ...batchJob, inFlight: null } });
    batchJob.inFlight = null;
  });
}

function createHistoryRecord(attempt, success, error, note = null) {
  return {
    id: Date.now() + Math.random(),
    attemptId: attempt.id,
    time: new Date().toLocaleString(),
    email: attempt.email,
    password: attempt.password,
    firstName: attempt.firstName,
    lastName: attempt.lastName,
    success,
    error: success ? null : error,
    note: success ? (note || null) : null,
  };
}

async function finishBatch(run) {
  await clearBatchJob();
  updateGlobalState({
    status: run.stopRequested ? 'idle' : 'completed',
    step: run.stopRequested
      ? (stopReason || `已停止，成功 ${globalState.totalRegistered} 个`)
      : `完成！成功 ${globalState.totalRegistered}/${globalState.totalTarget} 个`
  });
}

function failStuckAttempt() {
  if (!batchJob?.inFlight || batchJob.inFlight.stage === 'settled') return;
  const session = activeSession;
  if (!session || session.id !== batchJob.inFlight.id || session.signupResult) return;
  if (session.quotaNavigationStarted && !session.quotaPageResult
    && Date.now() - session.quotaNavigationStartedAt >= QUOTA_PAGE_TIMEOUT_MS) {
    finishQuotaPage(session, { success: false, error: 'EC2 Quotas 页面加载或检查超时' });
  }
  if (Date.now() - batchJob.inFlight.startedAt >= SIGNUP_TIMEOUT_MS) {
    if (session.consoleReached) {
      if (!session.quotaPageResult) {
        finishQuotaPage(session, { success: false, error: 'EC2 Quotas 页面加载或检查超时' });
      }
      if (session.autoBootEnabled && !session.autoBootPrefillResult) {
        session.autoBootPrefillResult = { success: false, error: 'EC2 启动配置流程等待超时' };
      }
      finalizeQuotaSession(session);
    } else {
      finishSession(session, { success: false, error: '注册超时，未进入控制台' });
    }
  }
}

// ============== 工具函数 ==============

/**
 * 生成唯一会话 ID
 */
function generateSessionId() {
  return `session_${++sessionIdCounter}_${Date.now()}`;
}

/**
 * 等待标签页加载完成
 */
function waitForTabLoad(tabId, timeout = 30000, session = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkTab = async () => {
      if (session && session.run.stopRequested) {
        reject(new Error('注册已中断'));
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        console.log(`[waitForTabLoad] tabId=${tabId}, status=${tab.status}, url=${tab.url}`);

        if (tab.status === 'complete') {
          resolve(tab);
          return;
        }
      } catch (e) {
        console.error(`[waitForTabLoad] tabId=${tabId} 获取失败:`, e);
        reject(new Error('标签页已关闭或不存在'));
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error('等待页面加载超时'));
        return;
      }

      setTimeout(checkTab, 500);
    };

    checkTab();
  });
}

/**
 * 更新状态并通知 popup
 */
function broadcastState() {
  const state = getPublicState();
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    state
  }).catch(() => {
    // popup 可能未打开，忽略错误
  });
}

/**
 * 获取可以发送给 popup 的公开状态
 */
function getPublicState() {
  return {
    devTestStatus: activeSession?.devTest
      ? (activeSession.autoBootPrefillReceived ? 'settled' : 'running')
      : 'idle',
    devTestWindowId: activeSession?.devTest ? activeSession.windowId : null,
    status: globalState.status,
    step: globalState.step,
    error: globalState.error,
    totalTarget: globalState.totalTarget,
    totalRegistered: globalState.totalRegistered,
    totalFailed: globalState.totalFailed,
    lastSuccess: globalState.lastSuccess,
    sessions: activeSession ? [{
      id: activeSession.id,
      status: activeSession.status,
      step: activeSession.step,
      email: activeSession.email,
      error: activeSession.error
    }] : [],
    history: registrationHistory,
    domains: globalState.domains,
    blockedDomains: globalState.blockedDomains,
    domainNotice: globalState.domainNotice
  };
}

/**
 * 更新全局状态
 */
function updateGlobalState(updates) {
  globalState = { ...globalState, ...updates };
  broadcastState();
}

/**
 * 更新会话状态
 */
function updateSession(sessionId, updates) {
  const session = activeSession;
  if (session?.id === sessionId) {
    Object.assign(session, updates);
    broadcastState();
  }
}

function publishConsoleCountdown(session) {
  if (!session?.consoleReached || session.consoleLoadChecked || session.quotaNavigationStarted) return;
  const remaining = Math.max(0, CONSOLE_LOAD_FALLBACK_MS - (Date.now() - session.consoleReachedAt));
  const seconds = Math.ceil(remaining / 1000);
  updateSession(session.id, { step: `已进入控制台，等待 ${seconds} 秒后进入 EC2 Quotas...` });
}

function startConsoleStabilityWait(session, consoleWindowId, completedUrl) {
  if (activeSession !== session) return;
  if (consoleWindowId && consoleWindowId !== session.windowId) {
    session.consoleWindowId = consoleWindowId;
    session.windowIds.add(consoleWindowId);
    rememberSessionWindow(session).catch((error) => {
      if (activeSession === session) finishSession(session, { success: false, error: error.message });
    });
  }
  if (!sessionIsActive(session) || session.quotaNavigationStarted) return;
  const url = String(completedUrl || '');
  if (session.consoleReached && session.consoleStableUrl === url) return;

  session.consoleReached = true;
  session.consoleReachedAt = Date.now();
  session.consoleStableUrl = url;
  session.consoleLoadChecked = false;
  session.consoleWaitGeneration = (session.consoleWaitGeneration || 0) + 1;
  const generation = session.consoleWaitGeneration;
  session.readyMailChecks = 0;
  session.quotaNavigationScheduled = false;
  console.log(`[Session ${session.id}] Console 导航加载完成，URL=${url}；重新开始 10 秒稳定等待`);
  publishConsoleCountdown(session);
  scheduleQuotaNavigation(session, generation).catch((error) => {
    console.warn(`[Session ${session.id}] 延迟打开 EC2 Quotas 失败:`, error.message);
  });
}

// ============== 会话管理 ==============

/**
 * 创建新会话
 */
function createSession() {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    run: activeRun,
    status: 'pending', // pending, running, completed, error
    step: '等待中...',
    error: null,
    // 账号信息
    email: null,
    password: null,
    firstName: null,
    lastName: null,
    // 邮箱客户端
    mailClient: null,
    mailAccessKey: null,
    // 窗口信息
    windowId: null,
    tabId: null,
    windowIds: new Set(),
    tabIds: new Set(),
    closedWindowIds: new Set(),
    // 轮询控制
    pollAbort: false
  };
  activeSession = session;
  return session;
}

// ============== 注册流程 ==============

/**
 * 单个会话的注册流程
 */
async function runSessionRegistration(session) {
  session.status = 'running';
  await markAttemptStarted(session);
  try {
    session.pollAbort = false;
    checkSessionStopped(session);
    updateSession(session.id, { step: '初始化...' });

    // 步骤 1: 生成账号信息（先生成，用于邮箱前缀）
    updateSession(session.id, { step: '生成账号信息...' });
    const { firstName, lastName } = generateName();
    const password = generatePassword(12);
    session.firstName = firstName;
    session.lastName = lastName;
    session.password = password;

    // 步骤 2: 生成邮箱
    updateSession(session.id, { step: '生成邮箱...' });

    let email;
    if (registrationConfig.mode === 'domain') {
      if (!registrationConfig.domains.length) {
        throw new Error('未配置域名');
      }
      if (!registrationConfig.mailServerUrl || !registrationConfig.mailApiToken) {
        throw new Error('未配置收信服务器或 API Token');
      }
      email = generateDomainEmail(registrationConfig.domains);
      session.manualVerification = false;
      session.mailServerUrl = registrationConfig.mailServerUrl;
      session.mailApiToken = registrationConfig.mailApiToken;
      session.mailLookupEmail = email;
    } else {
      if (!gmailBaseAddress) {
        throw new Error('未配置 Gmail 地址，请在插件设置中配置');
      }
      session.mailClient = new GmailAliasClient({ baseEmail: gmailBaseAddress });
      const nameSuffix = `${firstName.toLowerCase()}${lastName.toLowerCase()}`.slice(0, 8);
      email = await session.mailClient.createInbox({
        prefix: nameSuffix,
        mode: 'auto'
      });
      checkSessionStopped(session);
      if (registrationConfig.gmailForwardEnabled) {
        if (!registrationConfig.gmailForwardAddress || !registrationConfig.gmailForwardServerUrl || !registrationConfig.gmailForwardApiToken) {
          throw new Error('未配置转发收信');
        }
        session.manualVerification = false;
        session.mailServerUrl = registrationConfig.gmailForwardServerUrl;
        session.mailApiToken = registrationConfig.gmailForwardApiToken;
        session.mailLookupEmail = registrationConfig.gmailForwardAddress;
      } else {
        session.manualVerification = true;
      }
    }
    session.email = email;
    updateSession(session.id, { email });
    await rememberSessionWindow(session);
    checkSessionStopped(session);

    console.log(`[Session ${session.id}] 账号信息:`, { email, firstName, lastName });

    // 步骤 3: 打开官方 Builder ID 注册页
    updateSession(session.id, { step: '打开注册页面...' });

    try {
      console.log(`[Session ${session.id}] 准备创建无痕窗口，URL:`, BUILDER_SIGNUP_URL);

      const window = await chrome.windows.create({
        url: BUILDER_SIGNUP_URL,
        incognito: true,
        focused: true,
        width: 600,
        height: 800
      });

      console.log(`[Session ${session.id}] chrome.windows.create 返回值:`, window);
      console.log(`[Session ${session.id}] window 类型:`, typeof window);
      console.log(`[Session ${session.id}] window.id:`, window?.id);
      console.log(`[Session ${session.id}] window.tabs:`, window?.tabs);

      // 检查窗口和标签页
      if (!window) {
        throw new Error('chrome.windows.create 返回 null/undefined，可能缺少权限或无痕模式未启用');
      }

      if (!window.id) {
        throw new Error(`窗口对象缺少 id 属性，返回值: ${JSON.stringify(window)}`);
      }

      // 先登记窗口，即使停止或标签页检查失败也能够收尾。
      session.windowId = window.id;
      session.windowIds.add(window.id);
      await rememberSessionWindow(session);
      checkSessionStopped(session);

      if (!window.tabs || window.tabs.length === 0) {
        throw new Error(`窗口缺少标签页，windowId=${window.id}`);
      }

      session.tabId = window.tabs[0].id;
      session.tabIds.add(session.tabId);
      console.log(`[Session ${session.id}] 无痕窗口创建成功: windowId=${window.id}, tabId=${session.tabId}`);

      // 等待页面加载完成
      updateSession(session.id, { step: '等待页面加载...' });
      try {
        await waitForTabLoad(session.tabId, 30000, session);
        console.log(`[Session ${session.id}] 页面已加载`);
      } catch (e) {
        console.warn(`[Session ${session.id}] 等待页面加载:`, e.message);
        // 即使超时也继续，content script 会处理
      }
      checkSessionStopped(session);

      // 额外等待一小段时间让 content script 初始化
      await new Promise(resolve => setTimeout(resolve, 1000));
      checkSessionStopped(session);

    } catch (error) {
      if (error.persistenceError) throw error;
      console.error(`[Session ${session.id}] 创建无痕窗口错误:`, error);

      // 根据错误类型给出详细提示
      let errorMsg = '创建无痕窗口失败';

      if (error.message && error.message.includes('cannot be created')) {
        errorMsg = '无法创建无痕窗口，请在扩展设置中启用"在无痕模式下允许"';
      } else if (error.message && (error.message.includes('null/undefined') || error.message.includes('缺少权限'))) {
        errorMsg = '创建窗口失败：请检查扩展权限，重新加载扩展后重试';
      } else if (error.message) {
        errorMsg = error.message;
      }

      throw new Error(errorMsg);
    }

    session.status = 'running';
    updateSession(session.id, { step: '自动填表中...' });

    const signupResult = await waitForSignupResult(session);
    finishSession(session, signupResult);

  } catch (error) {
    if (error.persistenceError) throw error;
    console.error(`[Session ${session.id}] 注册失败:`, error);
    finishSession(session, { success: false, error: error.message });
  }

  const result = session.signupResult;
  session.status = result.success ? 'completed' : 'error';
  updateSession(session.id, {
    step: result.success ? (session.note ? `注册成功，${session.note}` : '注册成功') : '失败: ' + session.error
  });
  // 保存失败或关闭失败由批次报告并保留现场，不改写账号结果。
  await saveToHistory(session, result.success);
  await closeSessionWindows(session);
  await markAttemptFinished(session);
  session.mailClient = null;
  return result.success;
}

/**
 * 结束一次注册等待。进入控制台后还要等到 Ready 邮件，超时则成功并注明未收到。
 */
function finishSession(session, result) {
  if (activeSession !== session || !session || session.signupResult) return;
  session.signupResult = result;
  session.pollAbort = true;
  if (result.note) session.note = result.note;
  if (!result.success) {
    session.error = result.error || '注册未完成';
    updateSession(session.id, { step: '失败: ' + session.error });
  }
  if (session.devTest) {
    if (result.error) session.error = result.error;
    queueMicrotask(() => finishDevTestSession(session).catch((error) => {
      updateGlobalState({ status: 'error', error: error.message, step: '开发测试收尾失败' });
    }));
  }
}

async function finishDevTestSession(session) {
  if (!session?.devTest || activeSession !== session) return;
  if (session.autoBootPrefillReceived) {
    updateGlobalState({
      status: 'running',
      step: session.autoBootPrefillResult.success
        ? `开发测试完成：${session.autoBootPrefillResult.note || 'EC2 实例已启动'}；点击 stoptest 返回 Quotas`
        : `开发测试开机未完成：${session.autoBootPrefillResult.error || '请检查页面'}；点击 stoptest 返回 Quotas`,
      error: session.autoBootPrefillResult.success ? null : session.autoBootPrefillResult.error
    });
    return;
  }
  const result = session.signupResult;
  const note = session.note || result?.note || result?.error || 'EC2 预填测试结束';
  session.status = result?.success ? 'completed' : 'error';
  activeSession = null;
  updateGlobalState({
    status: result?.success ? 'completed' : 'error',
    step: note,
    error: result?.success ? null : note
  });
}

function canCheckReadyMail(session) {
  const email = verificationLookupEmail(session?.email, session?.mailLookupEmail);
  return Boolean(session?.mailServerUrl && session?.mailApiToken && email);
}

async function sessionHasReadyMail(session) {
  if (!canCheckReadyMail(session)) return false;
  const result = await fetchReadyAccountMail({
    serverUrl: session.mailServerUrl,
    token: session.mailApiToken,
    email: verificationLookupEmail(session.email, session.mailLookupEmail)
  });
  return Boolean(result.ready);
}

function markConsoleReached(session, consoleWindowId) {
  startConsoleStabilityWait(session, consoleWindowId, '');
}

async function scheduleQuotaNavigation(session, expectedGeneration = session?.consoleWaitGeneration) {
  if (!sessionIsActive(session) || session.quotaNavigationStarted
    || session.quotaNavigationScheduled) return;
  session.quotaNavigationScheduled = true;
  while (sessionIsActive(session) && !session.quotaNavigationStarted
    && expectedGeneration === session.consoleWaitGeneration) {
    const remaining = CONSOLE_LOAD_FALLBACK_MS - (Date.now() - session.consoleReachedAt);
    if (remaining <= 0) break;
    publishConsoleCountdown(session);
    await new Promise((resolve) => setTimeout(resolve, Math.min(CONSOLE_COUNTDOWN_TICK_MS, remaining)));
  }
  if (!sessionIsActive(session) || session.quotaNavigationStarted
    || expectedGeneration !== session.consoleWaitGeneration) return;
  session.consoleLoadChecked = true;
  updateSession(session.id, { step: `控制台页面已稳定 ${CONSOLE_LOAD_FALLBACK_MS / 1000} 秒，进入 EC2 Quotas...` });
  await navigateToQuotaPage(session);
}

function finishQuotaPage(session, result) {
  if (!session || session.signupResult || session.quotaPageResult) return;
  session.quotaPageResult = result;
  if (result.success) session.quotaValue = result.quotaValue || null;
  if (session.autoBootEnabled) {
    if (!session.autoBootNavigationStarted) startAutoBootPage(session);
    if (!session.autoBootPrefillResult) return;
  }
  finalizeQuotaSession(session);
}

function finalizeQuotaSession(session) {
  if (!session || session.signupResult || !session.quotaPageResult) return;
  if (session.autoBootEnabled && !session.autoBootPrefillReceived) return;
  const ready = session.readyMailReceived ? '收到Ready邮件' : READY_MAIL_NOTE;
  const quota = session.quotaValue ? `${session.quotaValue}v` : '';
  const quotaResult = session.quotaPageResult.success
    ? (quota ? `${quota}，配额检查成功` : '配额检查成功')
    : `配额检查失败：${session.quotaPageResult.error || '页面未能完成检查'}`;
  const bootResult = session.autoBootEnabled
    ? (session.autoBootPrefillResult.success
      ? session.autoBootPrefillResult.note || 'EC2 实例已启动'
      : `EC2 开机未完成：${session.autoBootPrefillResult.error || '未知错误'}`)
    : '';
  finishSession(session, { success: true, note: [quotaResult, ready, bootResult].filter(Boolean).join('；') });
}

function waitForSignupResult(session, timeout = SIGNUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      if (session.signupResult) {
        resolve(session.signupResult);
        return;
      }
      if (session.consoleReached && !session.signupResult) finalizeQuotaSession(session);
      if (session.signupResult) {
        resolve(session.signupResult);
        return;
      }
      if (session.run.stopRequested) {
        finishSession(session, session.consoleReached
          ? { success: false, error: `注册已中断，${session.readyMailReceived ? '收到Ready邮件' : READY_MAIL_NOTE}` }
          : { success: false, error: session.error || '已中断' });
        resolve(session.signupResult);
        return;
      }
      if (session.pollAbort) {
        resolve({ success: false, error: session.error || '已中断' });
        return;
      }
      if (Date.now() - start >= timeout) {
        if (!session.consoleReached) {
          finishSession(session, { success: false, error: '注册超时，未进入控制台' });
        } else {
          if (!session.quotaPageResult) {
            finishQuotaPage(session, {
              success: false,
              error: 'EC2 Quotas 页面加载或检查超时'
            });
          }
          if (!session.signupResult) {
            if (session.autoBootEnabled && !session.autoBootPrefillResult) {
              session.autoBootPrefillResult = {
                success: false,
                error: 'EC2 启动配置流程等待超时'
              };
            }
            finalizeQuotaSession(session);
          }
        }
        resolve(session.signupResult);
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

/**
 * 保存注册结果到历史
 */
async function saveToHistory(session, success) {
  if (session.historySaved) return;
  session.pendingRecord ||= createHistoryRecord(session, success, session.error, session.note);
  await writeState(async () => {
    const alreadySaved = registrationHistory.some((record) => record.attemptId === session.id);
    const history = alreadySaved ? registrationHistory : [session.pendingRecord, ...registrationHistory].slice(0, 100);
    const nextJob = {
      ...batchJob,
      totalRegistered: batchJob.totalRegistered + (!alreadySaved && success ? 1 : 0),
      totalFailed: batchJob.totalFailed + (!alreadySaved && !success ? 1 : 0),
      inFlight: { ...batchJob.inFlight, stage: 'settled', result: session.signupResult }
    };
    await chrome.storage.local.set({ registrationHistory: history, batchJob: nextJob });
    registrationHistory = history;
    batchJob.totalRegistered = nextJob.totalRegistered;
    batchJob.totalFailed = nextJob.totalFailed;
    batchJob.inFlight = { ...batchJob.inFlight, stage: 'settled', result: session.signupResult };
    session.historySaved = true;
    globalState.totalRegistered = nextJob.totalRegistered;
    globalState.totalFailed = nextJob.totalFailed;
    if (success) {
      globalState.lastSuccess = {
        email: session.email, password: session.password,
        firstName: session.firstName, lastName: session.lastName
      };
    }
  });
}

// ============== 批量注册控制 ==============

/**
 * 开始批量注册
 */
async function startBatchRegistration(loopCount, options = {}) {
  if (!Number.isInteger(loopCount) || loopCount < 1 || loopCount > 100) {
    return { success: false, error: '注册数量需为 1-100 的整数' };
  }
  if (activeRun) {
    return { success: false, error: '已有注册任务在运行' };
  }

  const emailMode = options.emailMode === 'domain' ? 'domain' : 'gmail';
  const blocked = new Set((Array.isArray(options.blockedDomains) ? options.blockedDomains : [])
    .map((item) => String(item).trim().toLowerCase()));
  const domains = (Array.isArray(options.domains) ? options.domains : [])
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item && !blocked.has(item));
  const mailServerUrl = options.mailServerUrl || '';
  const mailApiToken = options.mailApiToken || '';
  const gmailAddress = options.gmailAddress || '';
  const gmailForwardEnabled = Boolean(options.gmailForwardEnabled);
  const gmailForwardAddress = String(options.gmailForwardAddress || '').trim();
  const gmailForwardServerUrl = options.gmailForwardServerUrl || '';
  const gmailForwardApiToken = options.gmailForwardApiToken || '';

  if (emailMode === 'domain') {
    if (domains.length === 0) {
      return { success: false, error: '没有可用域名' };
    }
    if (!mailServerUrl || !mailApiToken) {
      return { success: false, error: '未配置收信服务器或 API Token' };
    }
  } else if (!gmailAddress) {
    return { success: false, error: '未配置 Gmail 地址' };
  } else if (gmailForwardEnabled && (!gmailForwardAddress || !gmailForwardServerUrl || !gmailForwardApiToken)) {
    return { success: false, error: '未配置转发收信' };
  }

  registrationConfig = {
    mode: emailMode,
    domains,
    mailServerUrl,
    mailApiToken,
    gmailForwardEnabled: emailMode === 'gmail' && gmailForwardEnabled,
    gmailForwardAddress,
    gmailForwardServerUrl,
    gmailForwardApiToken
  };
  gmailBaseAddress = gmailAddress;

  const run = createRun();
  stopReason = '';
  let respond;
  const started = new Promise((resolve) => { respond = resolve; });
  executeRun(run, async () => {
    await historyReady;
    run.stateLoaded = true;
    if (run.stopRequested) {
      respond({ success: false, error: '任务已取消' });
      return;
    }
    batchJob = {
      active: true,
      loopCount,
      autoBootEnabled: Boolean(options.autoBootEnabled),
      ...rememberBatchConfig(),
      remaining: loopCount,
      totalRegistered: 0,
      totalFailed: 0,
      inFlight: null
    };
    await persistBatchJob();
    watchBatch();
    globalState = {
      status: 'running', step: '开始串行注册...', error: null,
      totalTarget: loopCount, totalRegistered: 0, totalFailed: 0, lastSuccess: null
    };
    taskQueue = Array.from({ length: loopCount }, (_, index) => index);
    broadcastState();
    respond({ success: true, state: getPublicState() });
    await runBatch(run);
    await finishBatch(run);
  });
  run.done.then(() => respond({ success: false, error: run.error?.message || '任务已取消' }));
  return started;
}

/**
 * 从队列逐个执行任务，完整收尾后再取下一项
 */
async function runBatch(run) {
  while (!run.stopRequested && taskQueue.length > 0) {
    const taskIndex = taskQueue.shift();
    if (taskIndex === undefined) break;

    // 创建会话
    const session = createSession();

    const done = globalState.totalRegistered + globalState.totalFailed;
    updateGlobalState({
      step: `进度 ${done}/${globalState.totalTarget}，正在注册第 ${taskIndex + 1} 个...`
    });

    await runSessionRegistration(session);
    activeSession = null;

    // 更新全局进度
    const doneAfter = globalState.totalRegistered + globalState.totalFailed;
    updateGlobalState({
      step: `进度 ${doneAfter}/${globalState.totalTarget}`
    });

    // 任务间延迟
    if (!run.stopRequested && taskQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

/**
 * 停止注册
 */
async function blacklistSignupDomain(session) {
  if (!sessionIsActive(session)) return;
  const run = session.run;
  const pendingTasks = taskQueue.length;
  const plan = registrationConfig.mode === 'domain'
    ? planAfterDomainBlock({
      domains: registrationConfig.domains,
      email: session.email,
      pendingTasks
    })
    : { blocked: '', domains: registrationConfig.domains, continueBatch: pendingTasks > 0 };
  const message = registrationConfig.mode === 'domain'
    ? (plan.blocked
      ? `域名 ${plan.blocked} 已被 AWS 拉黑（ERR-837）`
      : '域名已被 AWS 拉黑（ERR-837）')
    : '邮箱已被 AWS 拉黑（ERR-837）';

  if (plan.blocked) {
    registrationConfig.domains = plan.domains;
    if (batchJob) batchJob.domains = plan.domains.slice();
    if (!plan.continueBatch && pendingTasks > 0) {
      run.stopRequested = true;
      taskQueue = [];
      stopReason = `域名 ${plan.blocked} 已被 AWS 拉黑，没有其他可用域名，任务已结束`;
      if (batchJob?.active) batchJob.remaining = 0;
      if (batchJob?.active) batchJob.stopping = true;
    }
  }

  finishSession(session, { success: false, error: message });
  if (!plan.blocked) return;

  const stored = await chrome.storage.local.get(['emailDomains', 'blockedDomains']);
  if (activeRun !== run) return;
  const saved = Array.isArray(stored.emailDomains) ? stored.emailDomains : [];
  const marked = markDomainBlocked({
    domains: saved,
    blockedDomains: stored.blockedDomains,
    domain: plan.blocked
  });
  await chrome.storage.local.set({
    emailDomains: marked.domains,
    blockedDomains: marked.blockedDomains
  });
  if (activeRun !== run) return;
  if (batchJob?.active) await persistBatchJob();

  globalState.domains = marked.domains;
  globalState.blockedDomains = marked.blockedDomains;
  globalState.domainNotice = `已标记 ${plan.blocked} [AWS已拉黑]`;
  if (stopReason) {
    updateGlobalState({ error: message, step: stopReason });
  } else if (plan.continueBatch) {
    updateGlobalState({ step: `已标记 ${plan.blocked} [AWS已拉黑]，继续下一次注册` });
  } else {
    updateGlobalState({ step: `已标记 ${plan.blocked} [AWS已拉黑]` });
  }
}

async function restoreInFlight(run) {
  const attempt = batchJob?.inFlight;
  if (!attempt) return;
  const session = createSession();
  session.run = run;
  session.id = attempt.id || generateSessionId();
  batchJob.inFlight.id = session.id;
  Object.assign(session, {
    email: attempt.email, password: attempt.password,
    firstName: attempt.firstName, lastName: attempt.lastName,
    windowId: attempt.windowId || null, consoleWindowId: attempt.consoleWindowId || null,
    historySaved: attempt.stage === 'settled'
  });
  session.windowIds = new Set([
    ...(attempt.windowIds || []), attempt.windowId, attempt.consoleWindowId
  ].filter(Boolean));
  let reachedConsole = false;
  for (const windowId of session.windowIds) {
    if (await windowHasConsole(windowId)) reachedConsole = true;
  }
  session.signupResult = session.historySaved
    ? (attempt.result || { success: Boolean(attempt.success) })
    : { success: false, error: reachedConsole ? '任务中断，未完成 EC2 Quotas 检查' : '注册超时或任务中断' };
  session.error = session.signupResult.error;
  session.note = session.signupResult.note;
  session.status = session.signupResult.success ? 'completed' : 'error';
}

async function retryCleanup(run) {
  if (run.cleanupPromise) return run.cleanupPromise;
  run.cleanupPromise = (async () => {
    try {
      // 初始化失败时先重读状态，不能盲目删除尚未读取的旧批次。
      if (!run.stateLoaded) {
        historyReady = restoreHistory();
        await historyReady;
        const stored = await chrome.storage.local.get('batchJob');
        batchJob = stored.batchJob?.active ? stored.batchJob : null;
        run.stateLoaded = true;
        if (batchJob) {
          delete batchJob.concurrency;
          batchJob.stopping = true;
          globalState.totalTarget = batchJob.loopCount;
          globalState.totalRegistered = batchJob.totalRegistered;
          globalState.totalFailed = batchJob.totalFailed;
        }
      }
      if (!activeSession && batchJob?.inFlight) await restoreInFlight(run);
      if (activeSession) {
        const session = activeSession;
        finishSession(session, { success: false, error: '注册已中断' });
        if (!session.historySaved && batchJob?.inFlight?.id === session.id) {
          await saveToHistory(session, session.signupResult.success);
        }
        await closeSessionWindows(session);
        await markAttemptFinished(session);
        activeSession = null;
      }
      await clearBatchJob();
      run.error = null;
      updateGlobalState({ status: 'idle', error: null, step: `已停止，成功 ${globalState.totalRegistered} 个` });
    } catch (error) {
      run.error = error;
      updateGlobalState({ status: 'error', error: error.message, step: `收尾失败：${error.message}` });
    } finally {
      run.cleanupPromise = null;
      if (!run.error && !run.resetRequested && activeRun === run) activeRun = null;
    }
  })();
  return run.cleanupPromise;
}

async function stopRegistration() {
  const run = activeRun;
  if (!run) return { success: true };
  run.stopRequested = true;
  taskQueue = [];
  updateGlobalState({ step: '正在停止并收尾...' });
  if (batchJob) {
    batchJob.stopping = true;
    try { await persistBatchJob(); } catch (error) { run.error = error; }
  }
  await run.done;
  if (run.error) await retryCleanup(run);
  return run.error ? { success: false, error: run.error.message } : { success: true };
}

/**
 * 完全重置状态
 */
async function resetState() {
  // 即使没有注册任务，重置本身也占用执行入口直到全部完成。
  const existingRun = activeRun;
  const run = existingRun || createRun();
  run.resetRequested = true;
  if (!existingRun) run.resolveDone();
  const result = await stopRegistration();
  if (!result.success) {
    run.resetRequested = false;
    return result;
  }

  globalState = {
    status: 'idle',
    step: '',
    error: null,
    totalTarget: 0,
    totalRegistered: 0,
    totalFailed: 0,
    lastSuccess: null
  };
  if (activeRun === run) activeRun = null;
  broadcastState();
  return { success: true };
}

// ============== 消息处理 ==============

function replyAsync(promise, sendResponse) {
  promise.then(sendResponse).catch((error) => sendResponse({ success: false, error: error.message }));
  return true;
}

/**
 * 根据 windowId 查找对应的会话（主要方式）
 * windowId 在整个认证流程中保持不变，比 tabId 更可靠
 */
function findSessionByWindowId(windowId) {
  return activeSession?.windowIds.has(windowId) && !activeSession.closedWindowIds.has(windowId) ? activeSession : null;
}

/**
 * 获取验证码（Gmail 别名模式 - 等待用户手动输入）
 */
async function getVerificationCode(session) {
  if (!sessionIsActive(session)) {
    return { success: false, error: '会话未初始化' };
  }

  if (session.verificationCode) {
    return { success: true, code: session.verificationCode };
  }

  if (session.manualVerification) {
    console.log(`[Session ${session.id}] Gmail 别名模式，等待用户手动输入验证码`);
    return {
      success: false,
      needManualInput: true,
      error: '请从 Gmail 收件箱获取验证码并手动填写'
    };
  }

  return pollDomainVerificationCode(session);
}

/**
 * 向域名收信接口查一次验证码。内容脚本会反复询问，这里限制实际请求间隔。
 */
async function pollDomainVerificationCode(session) {
  const now = Date.now();
  if (session.mailPollInFlight) {
    return { success: false, pending: true };
  }
  if (session.lastMailPollAt && now - session.lastMailPollAt < 3000) {
    return { success: false, pending: true };
  }

  session.lastMailPollAt = now;
  session.mailPollInFlight = true;
  updateSession(session.id, { step: '正在收取验证码...' });

  try {
    const result = await fetchDomainVerificationCode({
      serverUrl: session.mailServerUrl,
      token: session.mailApiToken,
      email: verificationLookupEmail(session.email, session.mailLookupEmail)
    });

    if (!sessionIsActive(session)) return { success: false, error: '任务已结束' };

    if (result.pending || !result.code) {
      return { success: false, pending: true };
    }

    session.verificationCode = result.code;
    console.log(`[Session ${session.id}] 已收到验证码`);
    return { success: true, code: result.code };
  } catch (error) {
    if (!sessionIsActive(session)) return { success: false, error: '任务已结束' };
    console.error(`[Session ${session.id}] 收信失败:`, error.message);
    if (error.fatal) {
      session.error = error.message;
      session.pollAbort = true;
      return { success: false, fatal: true, error: error.message };
    }
    return { success: false, pending: true, error: error.message };
  } finally {
    session.mailPollInFlight = false;
  }
}

/**
 * 处理来自 popup 和 content script 的消息
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 用 windowId 查找会话（跨域导航时 tabId 可能变化，windowId 不变）
  const senderWindowId = sender.tab?.windowId;
  const session = senderWindowId ? findSessionByWindowId(senderWindowId) : null;

  if (sender.tab) {
    console.log('[Service Worker] 收到消息:', message.type,
      'tabId:', sender.tab.id, 'windowId:', senderWindowId,
      'session:', session?.id || 'none');
  } else {
    console.log('[Service Worker] 收到消息:', message.type, '(popup)');
  }

  switch (message.type) {
    case 'DEV_START_EC2_AUTO_BOOT_WINDOW':
      return replyAsync(startDevTestWindow(), sendResponse);

    case 'DEV_START_EC2_AUTO_BOOT_TEST':
      return replyAsync(startDevAutoBootTest(message.tabId || sender.tab?.id), sendResponse);

    case 'DEV_STOP_EC2_AUTO_BOOT_TEST':
      return replyAsync(stopDevTestWindow(message.tabId), sendResponse);

    case 'GET_STATE':
      return replyAsync(historyReady.then(() => ({ state: getPublicState() })), sendResponse);

    case 'START_BATCH_REGISTRATION':
      return replyAsync(startBatchRegistration(message.loopCount, {
        emailMode: message.emailMode,
        autoBootEnabled: message.autoBootEnabled,
        gmailAddress: message.gmailAddress,
        gmailForwardEnabled: message.gmailForwardEnabled,
        gmailForwardAddress: message.gmailForwardAddress,
        gmailForwardServerUrl: message.gmailForwardServerUrl,
        gmailForwardApiToken: message.gmailForwardApiToken,
        domains: message.domains,
        blockedDomains: message.blockedDomains,
        mailServerUrl: message.mailServerUrl,
        mailApiToken: message.mailApiToken
      }), sendResponse);

    case 'STOP_REGISTRATION':
      return replyAsync(stopRegistration(), sendResponse);

    case 'GET_VERIFICATION_CODE':
      if (session) {
        return replyAsync(getVerificationCode(session), sendResponse);
      } else {
        console.warn('[Service Worker] GET_VERIFICATION_CODE: 找不到会话, windowId:', senderWindowId);
        sendResponse({ success: false, error: '找不到对应会话' });
      }
      break;

    case 'GET_ACCOUNT_INFO':
      if (sessionIsActive(session)) {
        console.log(`[Service Worker] GET_ACCOUNT_INFO: 会话 ${session.id}, email: ${session.email}`);
        sendResponse({
          email: session.email,
          devTest: Boolean(session.devTest),
          password: session.password,
          firstName: session.firstName,
          lastName: session.lastName,
          fullName: session.firstName && session.lastName
            ? `${session.firstName} ${session.lastName}`
            : null
        });
      } else {
        console.warn('[Service Worker] GET_ACCOUNT_INFO: 找不到会话',
          'senderWindowId:', senderWindowId);
        sendResponse({});
      }
      break;

    case 'RESET':
      return replyAsync(resetState(), sendResponse);

    case 'UPDATE_STEP':
      if (sessionIsActive(session)) {
        updateSession(session.id, { step: message.step });
      }
      sendResponse({ success: true });
      break;

    case 'REPORT_ERROR':
      if (sessionIsActive(session)) {
        finishSession(session, { success: false, error: message.error || '注册失败' });
      }
      sendResponse({ success: true });
      break;

    case 'DOMAIN_BLOCKED':
      if (session) {
        return replyAsync(blacklistSignupDomain(session).then(() => ({ success: true })), sendResponse);
      }
      sendResponse({ success: true });
      break;

    case 'PAYMENT_REQUIRED':
      if (sessionIsActive(session)) {
        return replyAsync((async () => {
          const senderUrl = sender.tab?.url || sender.tab?.pendingUrl || '';
          const quotaWindowId = session.consoleWindowId || session.windowId;
          const currentTab = await findWindowTab(quotaWindowId);
          const onQuotaFlow = session.quotaNavigationStarted
            || /\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(senderUrl)
            || /\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(currentTab?.url || '');
          if (sessionIsActive(session) && !onQuotaFlow) finishSession(session, { success: false, error: message.error || '要求添加付款资料' });
          return { success: true };
        })(), sendResponse);
      }
      sendResponse({ success: true });
      break;

    case 'REGISTRATION_COMPLETED':
      sendResponse({ success: true });
      break;

    case 'QUOTA_PAGE_RESULT':
      if (sessionIsActive(session)) {
        session.quotaValue = message.quotaValue || null;
        finishQuotaPage(session, {
          success: Boolean(message.success),
          quotaValue: message.quotaValue || null,
          error: message.error || null
        });
      }
      sendResponse({ success: true });
      break;

    case 'AUTO_BOOT_CLAIM': {
      // Launching costs money, so each session may click Launch at most once.
      const allowed = Boolean(sessionIsActive(session) && session.autoBootEnabled && !session.autoBootClaimed);
      if (allowed) session.autoBootClaimed = true;
      sendResponse({ allowed });
      break;
    }

    case 'AUTO_BOOT_PREFILL_RESULT':
      if (sessionIsActive(session) && session.autoBootEnabled) {
        session.autoBootPrefillResult = {
          success: Boolean(message.success),
          note: message.note || null,
          error: message.error || null
        };
        session.autoBootPrefillReceived = true;
        updateSession(session.id, {
          step: message.success
            ? `注册成功，${message.note || 'EC2 实例已启动'}`
            : `注册成功，EC2 开机未完成：${message.error || '必要控件未找到'}`
        });
        if (session.quotaPageResult) finalizeQuotaSession(session);
      }
      sendResponse({ success: true });
      break;

    case 'CLEAR_HISTORY':
      return replyAsync((async () => {
        await historyReady;
        await writeState(async () => {
          await chrome.storage.local.remove('registrationHistory');
          registrationHistory = [];
        });
        broadcastState();
        return { success: true };
      })(), sendResponse);

    case 'EXPORT_HISTORY':
      return replyAsync(historyReady.then(() => ({ history: registrationHistory })), sendResponse);

    default:
      sendResponse({ error: '未知消息类型' });
  }
});

// 监听标签页更新（处理窗口内导航时 tabId 更新）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  const isConsole = isConsoleUrl(url);
  const isIncompleteSignup = /^https:\/\/signup\.aws\.amazon\.com\/billing\/signup\/incomplete/i.test(url);
  let session = tab.windowId ? findSessionByWindowId(tab.windowId) : null;
  if (session?.devTest) {
    session.tabIds.add(tabId);
    return;
  }
  if (!session && isConsole && activeSession?.tabIds.has(tab.openerTabId)) {
    session = activeSession;
    session.windowIds.add(tab.windowId);
    session.consoleWindowId = tab.windowId;
    rememberSessionWindow(session).catch((error) => {
      if (activeSession === session) finishSession(session, { success: false, error: error.message });
    });
  }
  if (!session) return;
  session.tabIds.add(tabId);
  if (!isConsole && !isIncompleteSignup) return;
  if (!sessionIsActive(session)) return;

  if (session) {
    if (isIncompleteSignup) {
      finishSession(session, {
        success: false,
        error: `失败，注册未完成（AWS 跳转到 billing/signup/incomplete），${session.readyMailReceived ? '收到Ready邮件' : READY_MAIL_NOTE}`
      });
      return;
    }
    // URL changes are emitted before the Console document has necessarily
    // finished loading. Start the stability countdown only on completed load.
    if (isConsole && !session.quotaNavigationStarted && !session.quotaPageResult) {
      if (changeInfo.status === 'loading') {
        session.consoleLoadPending = true;
        session.consoleStableUrl = null;
        session.consoleWaitGeneration = (session.consoleWaitGeneration || 0) + 1;
        session.quotaNavigationScheduled = false;
        if (session.consoleReached) {
          session.consoleReachedAt = Date.now();
          session.consoleLoadChecked = false;
          publishConsoleCountdown(session);
        }
      } else if (changeInfo.status === 'complete') {
        startConsoleStabilityWait(session, tab.windowId, url);
      }
    }
    if (isConsole) {
      console.log(`[Session ${session.id}] 检测到 Console 标签页 URL: ${url}；导航状态=${session.quotaNavigationStarted ? 'quota' : 'pre-quota'}`);
    }
    if (session.quotaNavigationStarted && tabId === session.quotaTabId && changeInfo.status === 'complete') {
      if (!/\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(url)) {
        finishQuotaPage(session, { success: false, error: '进入控制台后跳转到了非 EC2 Quotas 页面' });
      }
    }
    return;
  }
});

// 监听窗口关闭
chrome.windows.onRemoved.addListener((windowId) => {
  const session = activeSession?.windowIds.has(windowId) ? activeSession : null;
  if (session) {
    console.log(`[Service Worker] 会话 ${session.id} 的窗口已关闭`);
    const closedConsole = session.consoleWindowId === windowId;
    session.closedWindowIds.add(windowId);
    if (session.consoleWindowId === windowId) session.consoleWindowId = null;
    if (session.windowId === windowId) {
      session.windowId = null;
      session.tabId = null;
    }
    const hasOpenWindow = [...session.windowIds].some((id) => !session.closedWindowIds.has(id));
    if (!session.closing && !session.signupResult && (!hasOpenWindow || closedConsole)) {
      finishSession(session, { success: false, error: session.consoleReached ? '控制台窗口已关闭，未打开 EC2 Quotas 页面' : '注册窗口已关闭' });
    }
  }
});

// Service Worker 激活时恢复未完成的批次
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Service Worker] 扩展已安装/更新');
});

function resumeBatchIfNeeded() {
  if (activeRun) return activeRun.done;
  const run = createRun();
  stopReason = '';
  executeRun(run, async () => {
    await historyReady;
    const stored = await chrome.storage.local.get('batchJob');
    run.stateLoaded = true;
    const job = stored.batchJob;
    if (!job?.active) return;

    batchJob = job;
    // 旧并发批次只有一个在途槽位，结束队列而不重建未知的并行任务。
    const wasParallel = Number(batchJob.concurrency) > 1;
    delete batchJob.concurrency;
    if (wasParallel || batchJob.stopping || run.stopRequested) {
      run.stopRequested = true;
      batchJob.stopping = true;
      stopReason = wasParallel ? '旧并发批次已结束，请重新开始串行注册' : '';
    }
    globalState = {
      status: 'running', step: '恢复任务并收尾...', error: null,
      totalTarget: batchJob.loopCount,
      totalRegistered: batchJob.totalRegistered,
      totalFailed: batchJob.totalFailed,
      lastSuccess: globalState.lastSuccess
    };
    if (batchJob.inFlight) {
      await restoreInFlight(run);
      const session = activeSession;
      if (!session.historySaved) await saveToHistory(session, false);
      await closeSessionWindows(session);
      await markAttemptFinished(session);
      activeSession = null;
    }

    if (run.stopRequested || batchJob.remaining <= 0) {
      await finishBatch(run);
      return;
    }

    registrationConfig = {
      mode: batchJob.mode === 'domain' ? 'domain' : 'gmail',
      domains: batchJob.domains || [],
      mailServerUrl: batchJob.mailServerUrl || '',
      mailApiToken: batchJob.mailApiToken || '',
      gmailForwardEnabled: Boolean(batchJob.gmailForwardEnabled),
      gmailForwardAddress: batchJob.gmailForwardAddress || '',
      gmailForwardServerUrl: batchJob.gmailForwardServerUrl || '',
      gmailForwardApiToken: batchJob.gmailForwardApiToken || ''
    };
    gmailBaseAddress = batchJob.gmailAddress || '';
    taskQueue = Array.from({ length: batchJob.remaining }, (_, index) => batchJob.loopCount - batchJob.remaining + index);
    watchBatch();
    broadcastState();
    await runBatch(run);
    await finishBatch(run);
  });
  return run.done;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BATCH_ALARM) return;
  if (activeRun) failStuckAttempt();
  else resumeBatchIfNeeded();
});

resumeBatchIfNeeded();
