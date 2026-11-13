/**
 * Service Worker - 后台服务
 * 管理注册状态和流程控制，支持多窗口并发注册
 */

import { GmailAliasClient } from '../lib/mail-api.js';
import { generateDomainEmail, fetchDomainVerificationCode, fetchReadyAccountMail, verificationLookupEmail } from '../lib/domain-mail.js';
import { generatePassword, generateName, generateEmailPrefix } from '../lib/utils.js';
import { BUILDER_SIGNUP_URL, EC2_QUOTA_URL, isConsoleUrl, planAfterDomainBlock, markDomainBlocked } from '../lib/signup-page.js';

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
  concurrency: 1,      // 并发数
  lastSuccess: null    // 最后一个成功的记录
};

// 并发会话
let sessions = new Map(); // sessionId -> session
let sessionIdCounter = 0;

// 任务队列
let taskQueue = [];
let isRunning = false;
let shouldStop = false;
let stopReason = '';

// 注册历史记录
let registrationHistory = [];
const historyReady = chrome.storage.local.get(['registrationHistory']).then((stored) => {
  if (stored.registrationHistory) {
    registrationHistory = stored.registrationHistory;
    console.log('[Service Worker] 恢复历史记录:', registrationHistory.length, '条');
  }
});

const BATCH_ALARM = 'registration-batch-watch';
const SIGNUP_TIMEOUT_MS = 600000;
const READY_MAIL_MAX_CHECKS = 1;
const READY_MAIL_NOTE = '未收到Ready邮件';
const CONSOLE_LOAD_FALLBACK_MS = 30000;
const CONSOLE_COUNTDOWN_TICK_MS = 1000;
let batchJob = null;
let resumingBatch = false;

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
  if (!batchJob?.active) {
    await chrome.storage.local.remove('batchJob');
    return;
  }
  await chrome.storage.local.set({ batchJob });
}

function watchBatch() {
  chrome.alarms.create(BATCH_ALARM, { periodInMinutes: 1 });
}

async function rememberSessionWindow(session) {
  if (!batchJob?.active || !batchJob.inFlight || !session) return;
  if (batchJob.inFlight.email !== session.email) return;
  batchJob.inFlight.windowId = session.windowId || null;
  batchJob.inFlight.consoleWindowId = session.consoleWindowId || null;
  await persistBatchJob();
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
  if (!session || session.signupResult || session.quotaNavigationStarted) return;
  // Set this before awaiting tab lookup so parallel triggers cannot navigate twice.
  session.quotaNavigationStarted = true;
  const tab = await findWindowTab(session.consoleWindowId || session.windowId);
  if (!tab?.id) {
    session.quotaNavigationStarted = false;
    finishSession(session, { success: false, error: '进入控制台后找不到浏览器标签页' });
    return;
  }
  session.quotaTabId = tab.id;
  updateSession(session.id, { step: '打开 EC2 Quotas 页面...' });
  try {
    const quotaNavigation = chrome.tabs.update(tab.id, { url: EC2_QUOTA_URL });
    // Ready-mail lookup is informational only and is deliberately decoupled
    // from navigation and registration success/failure.
    session.readyMailChecks = 1;
    session.readyMailCheckPromise = sessionHasReadyMail(session)
      .then((received) => { session.readyMailReceived = Boolean(received); })
      .catch((error) => {
        console.warn(`[Session ${session.id}] Ready 邮件检查失败:`, error.message);
        session.readyMailReceived = false;
      });
    await quotaNavigation;
  } catch (error) {
    finishSession(session, { success: false, error: `无法打开 EC2 Quotas 页面: ${error.message}` });
  }
}

async function closeWindow(windowId) {
  if (!windowId) return;
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // 窗口可能已经关闭
  }
}

async function closeSessionWindows(session) {
  const ids = [...new Set([session?.windowId, session?.consoleWindowId].filter(Boolean))];
  for (const id of ids) {
    await closeWindow(id);
  }
  if (session) {
    session.windowId = null;
    session.consoleWindowId = null;
    session.tabId = null;
  }
}

async function clearBatchJob() {
  batchJob = null;
  await chrome.storage.local.remove('batchJob');
  chrome.alarms.clear(BATCH_ALARM);
}

async function markAttemptStarted(session) {
  if (!batchJob?.active || !session.email) return;
  batchJob.remaining = Math.max(0, batchJob.remaining - 1);
  batchJob.inFlight = {
    email: session.email,
    password: session.password,
    firstName: session.firstName,
    lastName: session.lastName,
    startedAt: Date.now()
  };
  await persistBatchJob();
}

async function markAttemptFinished(success) {
  if (!batchJob?.active || !batchJob.inFlight) return;
  batchJob.inFlight = null;
  if (success) batchJob.totalRegistered += 1;
  else batchJob.totalFailed += 1;
  await persistBatchJob();
}

async function skipUnstartedAttempt() {
  if (!batchJob?.active || batchJob.inFlight) return;
  batchJob.remaining = Math.max(0, batchJob.remaining - 1);
  batchJob.totalFailed += 1;
  await persistBatchJob();
}

function recordSettledAttempt(attempt, success, error, note = null) {
  registrationHistory.unshift({
    id: Date.now() + Math.random(),
    time: new Date().toLocaleString(),
    email: attempt.email,
    password: attempt.password,
    firstName: attempt.firstName,
    lastName: attempt.lastName,
    success,
    error: success ? null : error,
    note: success ? (note || null) : null,
    token: null,
  });
  if (registrationHistory.length > 100) {
    registrationHistory = registrationHistory.slice(0, 100);
  }
}

function recordInterruptedAttempt(attempt, error) {
  recordSettledAttempt(attempt, false, error);
}

function launchWorkers(concurrency) {
  const workerCount = Math.max(1, concurrency);
  let workersDone = 0;
  const finishBatch = async () => {
    workersDone += 1;
    if (workersDone < workerCount) return;
    isRunning = false;
    const stopped = shouldStop;
    globalState.status = stopped ? 'idle' : 'completed';
    globalState.step = stopped
      ? (stopReason || `已停止，成功 ${globalState.totalRegistered} 个`)
      : `完成！成功 ${globalState.totalRegistered}/${globalState.totalTarget} 个`;
    await clearBatchJob();
    broadcastState();
  };

  for (let i = 0; i < workerCount; i++) {
    runWorker(i).finally(finishBatch);
  }
}

function failStuckAttempt() {
  if (!batchJob?.inFlight) return;
  if (Date.now() - batchJob.inFlight.startedAt < SIGNUP_TIMEOUT_MS) return;
  for (const session of sessions.values()) {
    if (session.email === batchJob.inFlight.email && !session.signupResult) {
      finishSession(session, session.consoleReached
        ? { success: false, error: '注册超时，未能进入 EC2 Quotas 页面' }
        : { success: false, error: '注册超时，未进入控制台' });
    }
  }
}

// 窗口创建锁，防止同时创建多个窗口
let windowCreationLock = Promise.resolve();

// API 调用锁，防止同时调用 AWS/Mail API
let apiCallLock = Promise.resolve();

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
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkTab = async () => {
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
    status: globalState.status,
    step: globalState.step,
    error: globalState.error,
    totalTarget: globalState.totalTarget,
    totalRegistered: globalState.totalRegistered,
    totalFailed: globalState.totalFailed,
    lastSuccess: globalState.lastSuccess,
    sessions: Array.from(sessions.values()).map(s => ({
      id: s.id,
      status: s.status,
      step: s.step,
      email: s.email,
      error: s.error
    })),
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
  const session = sessions.get(sessionId);
  if (session) {
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
  if (!session || session.signupResult || session.quotaNavigationStarted) return;
  if (consoleWindowId && consoleWindowId !== session.windowId) {
    session.consoleWindowId = consoleWindowId;
    rememberSessionWindow(session);
  }
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
    // 轮询控制
    pollAbort: false
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * 销毁会话
 */
async function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // 关闭窗口
  if (session.windowId) {
    try {
      await chrome.windows.remove(session.windowId);
    } catch (e) {
      // 窗口可能已关闭
    }
  }

  // Gmail 别名模式不需要删除邮箱
  session.mailClient = null;

  sessions.delete(sessionId);
}

/**
 * 关闭所有会话
 */
async function closeAllSessions() {
  const promises = Array.from(sessions.keys()).map(id => destroySession(id));
  await Promise.all(promises);
  sessions.clear();
}

// ============== 注册流程 ==============

/**
 * 带锁的 API 调用，防止并发请求导致限流
 */
async function withApiLock(fn) {
  await apiCallLock;
  let releaseLock;
  apiCallLock = new Promise(resolve => { releaseLock = resolve; });
  try {
    return await fn();
  } finally {
    // API 调用后延迟一小段时间再释放锁
    await new Promise(resolve => setTimeout(resolve, 500));
    releaseLock();
  }
}

/**
 * 单个会话的注册流程
 */
async function runSessionRegistration(session) {
  try {
    session.status = 'running';
    session.pollAbort = false;
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
    await markAttemptStarted(session);

    console.log(`[Session ${session.id}] 账号信息:`, { email, firstName, lastName });

    // 步骤 3: 打开官方 Builder ID 注册页
    updateSession(session.id, { step: '打开注册页面...' });

    // 等待获取窗口创建锁
    await windowCreationLock;
    let releaseLock;
    windowCreationLock = new Promise(resolve => { releaseLock = resolve; });

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

      if (!window.tabs || window.tabs.length === 0) {
        throw new Error(`窗口缺少标签页，windowId=${window.id}`);
      }

      session.windowId = window.id;
      session.tabId = window.tabs[0].id;
      await rememberSessionWindow(session);
      console.log(`[Session ${session.id}] 无痕窗口创建成功: windowId=${window.id}, tabId=${session.tabId}`);

      // 等待页面加载完成
      updateSession(session.id, { step: '等待页面加载...' });
      try {
        await waitForTabLoad(session.tabId, 30000);
        console.log(`[Session ${session.id}] 页面已加载`);
      } catch (e) {
        console.warn(`[Session ${session.id}] 等待页面加载:`, e.message);
        // 即使超时也继续，content script 会处理
      }

      // 额外等待一小段时间让 content script 初始化
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
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
    } finally {
      // 释放窗口创建锁
      releaseLock();
    }

    session.status = 'running';
    updateSession(session.id, { step: '自动填表中...' });

    const signupResult = await waitForSignupResult(session);

    if (signupResult.success) {
      session.status = 'completed';
      if (signupResult.note) session.note = signupResult.note;
      updateSession(session.id, {
        step: session.note ? `注册成功，${session.note}` : '注册成功'
      });
      await saveToHistory(session, true);
      globalState.totalRegistered++;
      globalState.lastSuccess = {
        email: session.email,
        password: session.password,
        firstName: session.firstName,
        lastName: session.lastName,
      };
      return true;
    }

    throw new Error(signupResult.error || session.error || '注册未完成');

  } catch (error) {
    console.error(`[Session ${session.id}] 注册失败:`, error);
    session.status = 'error';
    session.error = error.message;
    updateSession(session.id, { step: '失败: ' + error.message });

    await saveToHistory(session, false);
    if (!session.email) await skipUnstartedAttempt();
    globalState.totalFailed++;

    return false;
  } finally {
    await closeSessionWindows(session);
    session.mailClient = null;
  }
}

/**
 * 结束一次注册等待。进入控制台后还要等到 Ready 邮件，超时则成功并注明未收到。
 */
function finishSession(session, result) {
  if (!session || session.signupResult) return;
  session.signupResult = result;
  session.pollAbort = true;
  if (result.note) session.note = result.note;
  if (!result.success) {
    session.error = result.error || '注册未完成';
    updateSession(session.id, { step: '失败: ' + session.error });
  }
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
  if (!session || session.signupResult || session.quotaNavigationStarted
    || session.quotaNavigationScheduled) return;
  session.quotaNavigationScheduled = true;
  while (!session.signupResult && !session.quotaNavigationStarted
    && expectedGeneration === session.consoleWaitGeneration) {
    const remaining = CONSOLE_LOAD_FALLBACK_MS - (Date.now() - session.consoleReachedAt);
    if (remaining <= 0) break;
    publishConsoleCountdown(session);
    await new Promise((resolve) => setTimeout(resolve, Math.min(CONSOLE_COUNTDOWN_TICK_MS, remaining)));
  }
  if (session.signupResult || session.quotaNavigationStarted
    || expectedGeneration !== session.consoleWaitGeneration) return;
  session.consoleLoadChecked = true;
  updateSession(session.id, { step: `控制台页面已稳定 ${CONSOLE_LOAD_FALLBACK_MS / 1000} 秒，进入 EC2 Quotas...` });
  await navigateToQuotaPage(session);
}

function finishQuotaPage(session, result) {
  if (!session || session.signupResult) return;
  session.quotaPageResult = result;
  finalizeQuotaSession(session);
}

function finalizeQuotaSession(session) {
  if (!session || session.signupResult || !session.quotaPageResult) return;
  const result = session.quotaPageResult;
  if (session.autoBootEnabled && !session.autoBootPrefillResult) return;
  const ready = session.readyMailReceived ? '收到Ready邮件' : READY_MAIL_NOTE;
  if (result.success) {
    session.quotaValue = result.quotaValue || null;
    const quota = session.quotaValue ? `${session.quotaValue}v` : '';
    finishSession(session, { success: true, note: `${quota ? `${quota}，` : ''}${ready}` });
  } else {
    finishSession(session, { success: false, error: `${result.error || '未能进入 EC2 Quotas 页面'}，${ready}` });
  }
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
      if (shouldStop) {
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
        finishSession(session, session.consoleReached
          ? { success: false, error: session.quotaPageResult?.error || '进入 EC2 Quotas 页面超时' }
          : { success: false, error: '注册超时，未进入控制台' });
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
  session.historySaved = true;

  const record = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleString(),
    email: session.email,
    password: session.password,
    firstName: session.firstName,
    lastName: session.lastName,
    success: success,
    error: success ? null : session.error,
    note: success ? (session.note || null) : null,
  };

  registrationHistory.unshift(record);
  if (registrationHistory.length > 100) {
    registrationHistory = registrationHistory.slice(0, 100);
  }

  await markAttemptFinished(success);
  await chrome.storage.local.set({ registrationHistory });
}

// ============== 批量注册控制 ==============

/**
 * 开始批量注册
 */
async function startBatchRegistration(loopCount, concurrency, options = {}) {
  if (isRunning) {
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

  isRunning = true;
  shouldStop = false;
  stopReason = '';

  batchJob = {
    active: true,
    loopCount,
    concurrency,
    autoBootEnabled: Boolean(options.autoBootEnabled),
    ...rememberBatchConfig(),
    remaining: loopCount,
    totalRegistered: 0,
    totalFailed: 0,
    inFlight: null
  };
  await persistBatchJob();
  watchBatch();

  // 重置状态
  globalState = {
    status: 'running',
    step: '开始注册...',
    error: null,
    totalTarget: loopCount,
    totalRegistered: 0,
    totalFailed: 0,
    concurrency: concurrency,
    lastSuccess: null
  };

  sessions.clear();
  broadcastState();

  console.log(`[Service Worker] 开始批量注册: 目标=${loopCount}, 并发=${concurrency}, 邮箱=${emailMode}`);

  // 创建任务队列
  taskQueue = [];
  for (let i = 0; i < loopCount; i++) {
    taskQueue.push(i);
  }

  launchWorkers(concurrency);

  return { success: true, state: getPublicState() };
}

/**
 * 工作线程 - 从队列取任务执行
 */
async function runWorker(workerId) {
  console.log(`[Worker ${workerId}] 启动`);

  // 错开启动时间，避免同时创建窗口和调用 API
  // 第一个 worker 立即启动，后续 worker 等待更长时间
  if (workerId > 0) {
    await new Promise(resolve => setTimeout(resolve, workerId * 3000));
  }

  while (!shouldStop && taskQueue.length > 0) {
    const taskIndex = taskQueue.shift();
    if (taskIndex === undefined) break;

    console.log(`[Worker ${workerId}] 执行任务 #${taskIndex + 1}`);

    // 清理已完成的旧会话，只保留活跃的
    for (const [id, s] of sessions) {
      if (s.status === 'completed' || s.status === 'error') {
        sessions.delete(id);
      }
    }

    // 创建会话
    const session = createSession();

    const done = globalState.totalRegistered + globalState.totalFailed;
    updateGlobalState({
      step: `进度 ${done}/${globalState.totalTarget}，正在注册第 ${taskIndex + 1} 个...`
    });

    try {
      await runSessionRegistration(session);
    } catch (error) {
      console.error(`[Worker ${workerId}] 任务失败:`, error);
      if (!session.historySaved) {
        session.status = 'error';
        session.error = error.message || '注册失败';
        await saveToHistory(session, false);
        globalState.totalFailed++;
      }
    }

    // 更新全局进度
    const doneAfter = globalState.totalRegistered + globalState.totalFailed;
    updateGlobalState({
      step: `进度 ${doneAfter}/${globalState.totalTarget}`
    });

    // 任务间延迟
    if (!shouldStop && taskQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`[Worker ${workerId}] 结束`);
}

/**
 * 停止注册
 */
async function blacklistSignupDomain(session) {
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
      shouldStop = true;
      taskQueue = [];
      stopReason = `域名 ${plan.blocked} 已被 AWS 拉黑，没有其他可用域名，任务已结束`;
      if (batchJob?.active) batchJob.remaining = 0;
    }
  }

  finishSession(session, { success: false, error: message });
  if (plan.blocked) {
    for (const other of sessions.values()) {
      if (other === session || other.signupResult || !other.email) continue;
      const otherDomain = String(other.email).split('@')[1]?.trim().toLowerCase();
      if (otherDomain === plan.blocked) {
        finishSession(other, { success: false, error: message });
      }
    }
  }

  if (!plan.blocked) return;

  const stored = await chrome.storage.local.get(['emailDomains', 'blockedDomains']);
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

function stopRegistration() {
  console.log('[Service Worker] 停止注册');
  shouldStop = true;
  stopReason = '';
  taskQueue = [];
  clearBatchJob();

  // 中断所有会话的轮询
  for (const session of sessions.values()) {
    session.pollAbort = true;
  }

  updateGlobalState({ step: '正在停止...' });
}

/**
 * 完全重置状态
 */
async function resetState() {
  shouldStop = true;
  taskQueue = [];
  isRunning = false;

  await closeAllSessions();
  await clearBatchJob();

  globalState = {
    status: 'idle',
    step: '',
    error: null,
    totalTarget: 0,
    totalRegistered: 0,
    totalFailed: 0,
    concurrency: 1,
    lastSuccess: null
  };

  broadcastState();
}

// ============== 消息处理 ==============

/**
 * 根据 windowId 查找对应的会话（主要方式）
 * windowId 在整个认证流程中保持不变，比 tabId 更可靠
 */
function findSessionByWindowId(windowId) {
  for (const session of sessions.values()) {
    if (session.windowId === windowId || session.consoleWindowId === windowId) {
      return session;
    }
  }
  return null;
}

/**
 * 获取验证码（Gmail 别名模式 - 等待用户手动输入）
 */
async function getVerificationCode(session) {
  if (!session) {
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

    if (result.pending || !result.code) {
      return { success: false, pending: true };
    }

    session.verificationCode = result.code;
    console.log(`[Session ${session.id}] 已收到验证码`);
    return { success: true, code: result.code };
  } catch (error) {
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
    case 'GET_STATE':
      historyReady.then(() => sendResponse({ state: getPublicState() }));
      return true;

    case 'START_BATCH_REGISTRATION':
      startBatchRegistration(message.loopCount || 1, message.concurrency || 1, {
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
      })
        .then(sendResponse);
      return true;

    case 'STOP_REGISTRATION':
      stopRegistration();
      sendResponse({ success: true });
      break;

    case 'GET_VERIFICATION_CODE':
      if (session) {
        getVerificationCode(session).then(sendResponse);
        return true;
      } else {
        console.warn('[Service Worker] GET_VERIFICATION_CODE: 找不到会话, windowId:', senderWindowId);
        sendResponse({ success: false, error: '找不到对应会话' });
      }
      break;

    case 'GET_ACCOUNT_INFO':
      if (session) {
        console.log(`[Service Worker] GET_ACCOUNT_INFO: 会话 ${session.id}, email: ${session.email}`);
        sendResponse({
          email: session.email,
          password: session.password,
          firstName: session.firstName,
          lastName: session.lastName,
          fullName: session.firstName && session.lastName
            ? `${session.firstName} ${session.lastName}`
            : null
        });
      } else {
        // 列出现有会话帮助调试
        const existingSessions = Array.from(sessions.values()).map(s =>
          `${s.id}(windowId:${s.windowId})`
        ).join(', ');
        console.warn('[Service Worker] GET_ACCOUNT_INFO: 找不到会话',
          'senderWindowId:', senderWindowId,
          '现有会话:', existingSessions || '无');
        sendResponse({});
      }
      break;

    case 'RESET':
      resetState().then(() => sendResponse({ success: true }));
      return true;

    case 'UPDATE_STEP':
      if (session) {
        updateSession(session.id, { step: message.step });
      }
      sendResponse({ success: true });
      break;

    case 'REPORT_ERROR':
      if (session) {
        finishSession(session, { success: false, error: message.error || '注册失败' });
      }
      sendResponse({ success: true });
      break;

    case 'DOMAIN_BLOCKED':
      if (session) {
        blacklistSignupDomain(session).then(() => sendResponse({ success: true }));
        return true;
      }
      sendResponse({ success: true });
      break;

    case 'PAYMENT_REQUIRED':
      if (session) {
        (async () => {
          const senderUrl = sender.tab?.url || sender.tab?.pendingUrl || '';
          const quotaWindowId = session.consoleWindowId || session.windowId;
          const currentTab = await findWindowTab(quotaWindowId);
          const onQuotaFlow = session.quotaNavigationStarted
            || /\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(senderUrl)
            || /\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(currentTab?.url || '');
          if (!onQuotaFlow) finishSession(session, { success: false, error: message.error || '要求添加付款资料' });
          sendResponse({ success: true });
        })();
        return true;
      }
      sendResponse({ success: true });
      break;

    case 'REGISTRATION_COMPLETED':
      sendResponse({ success: true });
      break;

    case 'QUOTA_PAGE_RESULT':
      if (session) {
        session.quotaValue = message.quotaValue || null;
        if (session.autoBootEnabled && message.success) {
          session.quotaPageResult = { success: true, quotaValue: session.quotaValue };
          chrome.tabs.update(sender.tab.id, {
            url: 'https://console.aws.amazon.com/ec2/home?region=us-east-2#LaunchInstances:'
          }).catch((error) => {
            finishSession(session, { success: false, error: `无法打开 EC2 启动配置页: ${error.message}` });
          });
          sendResponse({ success: true });
          return true;
        }
        finishQuotaPage(session, {
          success: Boolean(message.success),
          quotaValue: message.quotaValue || null,
          error: message.error || null
        });
      }
      sendResponse({ success: true });
      break;

    case 'AUTO_BOOT_PREFILL_RESULT':
      if (session?.autoBootEnabled) {
        session.autoBootPrefillResult = {
          success: Boolean(message.success),
          note: message.note || null,
          error: message.error || null
        };
        updateSession(session.id, {
          step: message.success
            ? '注册成功，EC2 启动配置已预填（未启动）'
            : `注册成功，EC2 页面预填未完成：${message.error || '必要控件未找到'}`
        });
        finalizeQuotaSession(session);
      }
      sendResponse({ success: true });
      break;

    case 'AUTH_COMPLETED':
      if (session) {
        finishSession(session, { success: false, error: '出现设备配对页面，注册已停止' });
      }
      sendResponse({ success: true });
      break;

    case 'CLEAR_HISTORY':
      registrationHistory = [];
      chrome.storage.local.remove('registrationHistory');
      sendResponse({ success: true });
      break;

    case 'EXPORT_HISTORY':
      historyReady.then(() => sendResponse({ history: registrationHistory }));
      return true;

    default:
      sendResponse({ error: '未知消息类型' });
  }
});

// 监听标签页更新（处理窗口内导航时 tabId 更新）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  const session = tab.windowId ? findSessionByWindowId(tab.windowId) : null;
  if (session && session.tabId !== tabId) {
    console.log(`[Service Worker] 会话 ${session.id} 标签页更新: ${session.tabId} -> ${tabId}`);
    session.tabId = tabId;
  }
  const isConsole = isConsoleUrl(url);
  const isIncompleteSignup = /^https:\/\/signup\.aws\.amazon\.com\/billing\/signup\/incomplete/i.test(url);
  if (!isConsole && !isIncompleteSignup) return;

  const markConsole = (owner, consoleWindowId) => {
    markConsoleReached(owner, consoleWindowId);
  };

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
    if (session.quotaNavigationStarted && changeInfo.status === 'complete') {
      if (!/\/servicequotas\/home\/services\/ec2\/quotas\/L-1216C47A/i.test(url)) {
        finishQuotaPage(session, { success: false, error: '进入控制台后跳转到了非 EC2 Quotas 页面' });
      }
    }
    return;
  }
  if (!isConsole || !tab.openerTabId) return;
  chrome.tabs.get(tab.openerTabId).then((opener) => {
    const owner = opener?.windowId ? findSessionByWindowId(opener.windowId) : null;
    if (!owner?.quotaNavigationStarted && !owner?.quotaPageResult && changeInfo.status === 'loading') {
      owner.consoleLoadPending = true;
      owner.consoleStableUrl = null;
      owner.consoleWaitGeneration = (owner.consoleWaitGeneration || 0) + 1;
      owner.quotaNavigationScheduled = false;
      if (owner.consoleReached) {
        owner.consoleReachedAt = Date.now();
        owner.consoleLoadChecked = false;
        publishConsoleCountdown(owner);
      }
    } else if (!owner?.quotaNavigationStarted && !owner?.quotaPageResult
      && changeInfo.status === 'complete') {
      startConsoleStabilityWait(owner, tab.windowId, url);
    }
  }).catch(() => {});
});

// 监听窗口关闭
chrome.windows.onRemoved.addListener((windowId) => {
  const session = findSessionByWindowId(windowId);
  if (session && !session.quotaNavigationStarted && !session.quotaPageResult) {
    console.log(`[Service Worker] 会话 ${session.id} 的窗口已关闭`);
    if (session.consoleWindowId === windowId) session.consoleWindowId = null;
    if (session.windowId === windowId) {
      session.windowId = null;
      session.tabId = null;
    }
    if (!session.signupResult && (!session.consoleReached || (!session.quotaNavigationStarted && !session.quotaPageResult))) {
      finishSession(session, { success: false, error: session.consoleReached ? '控制台窗口已关闭，未打开 EC2 Quotas 页面' : '注册窗口已关闭' });
    }
  }
});

// Service Worker 激活时恢复未完成的批次
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Service Worker] 扩展已安装/更新');
});

async function resumeBatchIfNeeded() {
  if (isRunning || resumingBatch) return;
  resumingBatch = true;
  try {
    await historyReady;
    if (isRunning) return;
    const stored = await chrome.storage.local.get('batchJob');
    const job = stored.batchJob;
    if (!job?.active) return;

    batchJob = job;
    if (batchJob.inFlight) {
      const attempt = batchJob.inFlight;
      const windowIds = [...new Set([attempt.windowId, attempt.consoleWindowId].filter(Boolean))];
      let reachedConsole = false;
      for (const windowId of windowIds) {
        if (await windowHasConsole(windowId)) reachedConsole = true;
      }
      recordInterruptedAttempt(
        attempt,
        reachedConsole
          ? '任务中断，未完成 EC2 Quotas 检查'
          : '注册超时或任务中断'
      );
      batchJob.totalFailed += 1;
      for (const windowId of windowIds) {
        await closeWindow(windowId);
      }
      batchJob.inFlight = null;
      await chrome.storage.local.set({ registrationHistory, batchJob });
    }

    if (batchJob.remaining <= 0) {
      globalState = {
        status: 'completed',
        step: `完成！成功 ${batchJob.totalRegistered}/${batchJob.loopCount} 个`,
        error: null,
        totalTarget: batchJob.loopCount,
        totalRegistered: batchJob.totalRegistered,
        totalFailed: batchJob.totalFailed,
        concurrency: batchJob.concurrency,
        lastSuccess: globalState.lastSuccess
      };
      await clearBatchJob();
      broadcastState();
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
    shouldStop = false;
    isRunning = true;
    globalState = {
      status: 'running',
      step: '继续未完成的注册...',
      error: null,
      totalTarget: batchJob.loopCount,
      totalRegistered: batchJob.totalRegistered,
      totalFailed: batchJob.totalFailed,
      concurrency: batchJob.concurrency || 1,
      lastSuccess: globalState.lastSuccess
    };
    sessions.clear();
    taskQueue = Array.from({ length: batchJob.remaining }, (_, index) => index);
    watchBatch();
    broadcastState();
    launchWorkers(Math.min(globalState.concurrency, batchJob.remaining));
  } finally {
    resumingBatch = false;
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BATCH_ALARM) return;
  if (isRunning) failStuckAttempt();
  else resumeBatchIfNeeded();
});

historyReady.then(() => resumeBatchIfNeeded());
