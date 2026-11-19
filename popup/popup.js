/**
 * Popup 脚本 - 弹窗逻辑
 * 支持自定义循环次数和多窗口并发
 */

import { normalizeDomain } from '../lib/domain-mail.js';

const DEFAULT_MAIL_SERVER_URL = 'http://20.189.97.48:2099';
const DEFAULT_MAIL_API_TOKEN = '2088';

// DOM 元素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const stepText = document.getElementById('step-text');
const counter = document.getElementById('counter');

const loopCountInput = document.getElementById('loop-count');
const concurrencyInput = document.getElementById('concurrency');
const autoBootEnabledInput = document.getElementById('auto-boot-enabled');

const startBtn = document.getElementById('start-btn');
const devStartInstanceBtn = document.getElementById('dev-start-instance-btn');
const devStartTestBtn = document.getElementById('dev-start-test-btn');
const devStopTestBtn = document.getElementById('dev-stop-test-btn');
const stopBtn = document.getElementById('stop-btn');
const resetBtn = document.getElementById('reset-btn');

const errorSection = document.getElementById('error-section');
const errorText = document.getElementById('error-text');

const sessionsSection = document.getElementById('sessions-section');
const sessionsList = document.getElementById('sessions-list');

const accountSection = document.getElementById('account-section');
const emailValue = document.getElementById('email-value');
const passwordValue = document.getElementById('password-value');

const historyList = document.getElementById('history-list');
const exportBtn = document.getElementById('export-btn');
const clearBtn = document.getElementById('clear-btn');

// Gmail 配置元素
const gmailAddressInput = document.getElementById('gmail-address');
const gmailSaveBtn = document.getElementById('gmail-save-btn');
const gmailStatus = document.getElementById('gmail-status');
const gmailHint = document.getElementById('gmail-hint');
const gmailForwardEnabledInput = document.getElementById('gmail-forward-enabled');
const gmailForwardSettings = document.getElementById('gmail-forward-settings');
const gmailForwardAddressInput = document.getElementById('gmail-forward-address');
const gmailForwardServerInput = document.getElementById('gmail-forward-server');
const gmailForwardTokenInput = document.getElementById('gmail-forward-token');
const gmailForwardSaveBtn = document.getElementById('gmail-forward-save');
const gmailForwardStatus = document.getElementById('gmail-forward-status');
const gmailSection = document.getElementById('gmail-section');
const domainSection = document.getElementById('domain-section');
const domainInput = document.getElementById('domain-input');
const domainAddBtn = document.getElementById('domain-add-btn');
const domainList = document.getElementById('domain-list');
const mailServerInput = document.getElementById('mail-server-url');
const mailTokenInput = document.getElementById('mail-api-token');
const mailSaveBtn = document.getElementById('mail-save-btn');
const domainStatus = document.getElementById('domain-status');
const settingsHint = document.getElementById('settings-hint');

// Gmail 配置
let gmailAddress = '';
let gmailForwardEnabled = false;
let gmailForwardAddress = '';
let gmailForwardServerUrl = DEFAULT_MAIL_SERVER_URL;
let gmailForwardApiToken = DEFAULT_MAIL_API_TOKEN;
let emailMode = 'gmail';
let emailDomains = [];
let blockedDomains = [];
let mailServerUrl = DEFAULT_MAIL_SERVER_URL;
let mailApiToken = DEFAULT_MAIL_API_TOKEN;

/**
 * 更新 UI 状态
 */
function updateUI(state) {
  console.log('[Popup] 更新 UI:', state);

  // 状态指示器
  statusDot.className = 'dot';
  switch (state.status) {
    case 'idle':
      statusDot.classList.add('idle');
      statusText.textContent = '准备就绪';
      break;
    case 'running':
      statusDot.classList.add('processing');
      statusText.textContent = '注册进行中';
      break;
    case 'completed':
      statusDot.classList.add('success');
      statusText.textContent = '全部完成';
      break;
    case 'error':
      statusDot.classList.add('error');
      statusText.textContent = '发生错误';
      break;
    default:
      statusDot.classList.add('idle');
      statusText.textContent = state.status || '未知状态';
  }

  // 计数器
  if (state.totalTarget > 0) {
    counter.style.display = 'inline';
    counter.textContent = `${state.totalRegistered}/${state.totalTarget}`;
  } else {
    counter.style.display = 'none';
  }

  // 步骤文本
  stepText.textContent = state.step || '';

  // 错误显示
  if (state.error) {
    errorSection.style.display = 'flex';
    errorText.textContent = state.error;
  } else {
    errorSection.style.display = 'none';
  }

  // 按钮和设置状态
  const isRunning = state.status === 'running';
  const isIdle = state.status === 'idle';
  const isFinished = state.status === 'completed' || state.status === 'error';

  // 设置输入框禁用状态
  loopCountInput.disabled = !isIdle;
  concurrencyInput.disabled = !isIdle;

  if (isIdle) {
    startBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    resetBtn.style.display = 'none';
  } else if (isRunning) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    resetBtn.style.display = 'none';
  } else if (isFinished) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    resetBtn.style.display = 'flex';
    resetBtn.style.flex = '1';
  }

  // 并发会话显示
  if (state.sessions && state.sessions.length > 0) {
    sessionsSection.style.display = 'block';
    renderSessions(state.sessions);
  } else {
    sessionsSection.style.display = 'none';
  }

  // 账号信息（显示最后一个成功的）
  if (state.lastSuccess) {
    accountSection.style.display = 'block';
    emailValue.textContent = state.lastSuccess.email || '-';
    passwordValue.textContent = state.lastSuccess.password || '-';
  } else {
    accountSection.style.display = 'none';
  }

  // 历史记录。缺少 history 时保留当前列表，避免报错把已有结果刷掉。
  if (Array.isArray(state.domains)) {
    emailDomains = state.domains.slice();
  }
  if (Array.isArray(state.blockedDomains)) {
    blockedDomains = state.blockedDomains.slice();
  }
  if (Array.isArray(state.domains) || Array.isArray(state.blockedDomains)) {
    renderDomainList();
  }
  if (state.domainNotice) {
    setDomainStatus(state.domainNotice, true);
  }

  if (Array.isArray(state.history)) {
    renderHistory(state.history);
  }
}

/**
 * 渲染并发会话列表
 */
function renderSessions(sessions) {
  sessionsList.innerHTML = sessions.map((session, index) => {
    let statusClass = 'running';
    if (session.status === 'completed') statusClass = 'success';
    else if (session.status === 'error') statusClass = 'error';

    return `
      <div class="session-item">
        <span class="session-id">#${index + 1}</span>
        <span class="session-status ${statusClass}"></span>
        <span class="session-step">${session.step || session.status}</span>
        <span class="session-email">${session.email || ''}</span>
      </div>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function resultText(item) {
  if (item.success) {
    const note = String(item.note || '').trim();
    const normalizedNote = note.replace(/^成功[，,.\s·]*/, '');
    return normalizedNote ? `成功 · ${normalizedNote}` : '成功';
  }
  const reason = String(item.error || '').trim();
  return reason ? `失败 · ${reason}` : '失败';
}

/**
 * 渲染导出结果
 */
function renderHistory(history) {
  if (!history || history.length === 0) {
    historyList.innerHTML = '<div class="history-empty">暂无记录</div>';
    return;
  }

  historyList.innerHTML = history.slice(0, 20).map((item) => {
    const statusClass = item.success ? 'success' : 'failed';
    return `
    <div class="history-item">
      <div class="history-status ${statusClass}"></div>
      <div class="history-info">
        <div class="history-email">${escapeHtml(item.email || '-')}</div>
        <div class="history-result">${escapeHtml(resultText(item))}</div>
        <div class="history-time">${escapeHtml(item.time || '')}</div>
      </div>
    </div>
  `;
  }).join('');
}

/**
 * 检测操作系统类型
 * @returns {'windows' | 'macos' | 'linux'}
 */
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    const originalText = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => {
      button.classList.remove('copied');
      button.textContent = originalText;
    }, 1500);
  } catch (err) {
    console.error('复制失败:', err);
  }
}

/**
 * 开始注册
 */
async function startRegistration() {
  const loopCount = parseInt(loopCountInput.value) || 1;
  const concurrency = parseInt(concurrencyInput.value) || 1;

  if (emailMode === 'domain') {
    if (emailDomains.length === 0) {
      alert('请先添加至少一个域名');
      domainInput.focus();
      return;
    }
    if (usableDomains().length === 0) {
      alert('可用域名都已被 AWS 拉黑，请添加其他域名后再注册');
      domainInput.focus();
      return;
    }
    if (!mailServerUrl || !mailApiToken) {
      alert('请先保存收信服务器和 API Token');
      mailServerInput.focus();
      return;
    }
    const allowed = await ensureMailOriginPermission(mailServerUrl);
    if (!allowed) {
      alert('没有收信服务器的访问权限，无法自动获取验证码');
      return;
    }
  } else if (!gmailAddress) {
    alert('请先配置 Gmail 地址');
    gmailAddressInput.focus();
    return;
  } else if (gmailForwardEnabled) {
    if (!gmailForwardAddress || !gmailForwardServerUrl || !gmailForwardApiToken) {
      alert('请先保存转发邮箱、收信服务器和 API Token');
      gmailForwardAddressInput.focus();
      return;
    }
    const allowed = await ensureMailOriginPermission(gmailForwardServerUrl);
    if (!allowed) {
      alert('没有收信服务器的访问权限，无法自动获取验证码');
      return;
    }
  }

  // 验证输入
  if (loopCount < 1 || loopCount > 100) {
    alert('注册数量需在 1-100 之间');
    return;
  }
  if (concurrency < 1 || concurrency > 3) {
    alert('并发窗口需在 1-3 之间');
    return;
  }

  // Gmail 别名模式建议并发为 1
  if (emailMode !== 'domain' && !gmailForwardEnabled && concurrency > 1) {
    const confirm = window.confirm('使用 Gmail 别名模式时，建议并发设为 1（需要手动输入验证码）。\n\n是否继续？');
    if (!confirm) return;
  }

  startBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_BATCH_REGISTRATION',
      loopCount,
      concurrency,
      autoBootEnabled: autoBootEnabledInput.checked,
      emailMode,
      gmailAddress,
      gmailForwardEnabled,
      gmailForwardAddress,
      gmailForwardServerUrl,
      gmailForwardApiToken,
      domains: usableDomains(),
      blockedDomains,
      mailServerUrl,
      mailApiToken
    });
    console.log('[Popup] 注册响应:', response);
    if (response && response.success === false) {
      alert(response.error || '启动注册失败');
    }

    if (response.state) {
      updateUI(response.state);
    }
  } catch (error) {
    console.error('[Popup] 注册错误:', error);
    try {
      const stateResponse = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (stateResponse?.state) {
        updateUI(stateResponse.state);
        return;
      }
    } catch (stateError) {
      console.error('[Popup] 重新获取状态失败:', stateError);
    }
    errorSection.style.display = 'flex';
    errorText.textContent = error.message;
  } finally {
    startBtn.disabled = false;
  }
}

async function startDevInstanceWindow() {
  devStartInstanceBtn.disabled = true;
  try {
    const existing = await chrome.storage.local.get('devAutoBootTestWindowId');
    if (existing.devAutoBootTestWindowId) {
      try {
        await chrome.windows.get(existing.devAutoBootTestWindowId);
        const confirmClose = window.confirm('发现上一次开发测试窗口仍打开。关闭旧窗口并新开一个吗？');
        if (!confirmClose) return;
        await chrome.windows.remove(existing.devAutoBootTestWindowId);
      } catch {
        // Previous test window was already closed.
      }
    }
    const response = await chrome.runtime.sendMessage({ type: 'DEV_START_EC2_AUTO_BOOT_WINDOW' });
    if (!response?.success) alert(response?.error || '开发测试窗口启动失败');
    else {
      await chrome.storage.local.set({ devAutoBootTestWindowId: response.windowId });
      await chrome.storage.local.remove('devAutoBootTestPrefillStarted');
      updateDevTestButtons({ prefillStarted: false });
      alert('无痕窗口已打开。请手动登录 AWS 并进入 EC2 Quotas 页面，然后点击 starttest。之后保持该窗口不关，即可反复测试无需重新登录。');
    }
  } catch (error) {
    alert(`开发测试窗口启动失败：${error.message}`);
  } finally {
    devStartInstanceBtn.disabled = false;
  }
}

async function startDevAutoBootTest() {
  devStartTestBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      alert('找不到当前活动标签页');
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'DEV_START_EC2_AUTO_BOOT_TEST',
      tabId: tab.id
    });
    if (!response?.success) {
      alert(response?.error || '无法启动 EC2 预填测试；请确认当前页面是 EC2 Quotas');
    } else {
      await chrome.storage.local.set({ devAutoBootTestTabId: tab.id });
      alert('已跳转 EC2 启动配置页，扩展将预填并点击 Launch 真实启动实例；完成后点击 stoptest 返回 Quotas（窗口保留）。');
    }
  } catch (error) {
    alert(`启动测试失败：${error.message}`);
  } finally {
    devStartTestBtn.disabled = false;
  }
}

async function stopDevAutoBootTest() {
  devStopTestBtn.disabled = true;
  try {
    const { devAutoBootTestTabId } = await chrome.storage.local.get('devAutoBootTestTabId');
    const response = await chrome.runtime.sendMessage({
      type: 'DEV_STOP_EC2_AUTO_BOOT_TEST',
      tabId: devAutoBootTestTabId
    });
    if (!response?.success) {
      alert(response?.error || '停止测试失败');
      return;
    }
    await chrome.storage.local.remove(['devAutoBootTestTabId', 'devAutoBootTestPrefillStarted']);
    updateDevTestButtons({ prefillStarted: false });
  } catch (error) {
    alert(`停止测试失败：${error.message}`);
  } finally {
    devStopTestBtn.disabled = false;
  }
}

function updateDevTestButtons({ prefillStarted }) {
  devStartInstanceBtn.style.display = '';
  devStartTestBtn.style.display = prefillStarted ? 'none' : '';
  devStopTestBtn.style.display = prefillStarted ? '' : 'none';
}

/**
 * 停止注册
 */
async function stopRegistration() {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_REGISTRATION' });
  } catch (error) {
    console.error('[Popup] 停止错误:', error);
  }
}

/**
 * 重置
 */
async function reset() {
  try {
    await chrome.runtime.sendMessage({ type: 'RESET' });
    // 重新获取状态
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.state) {
      updateUI(response.state);
    } else {
      updateUI({ status: 'idle', history: [] });
    }
  } catch (error) {
    console.error('[Popup] 重置错误:', error);
  }
}

/**
 * 导出邮箱、密码和成功或失败
 */
async function exportHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_HISTORY' });
    const history = response.history || [];

    if (history.length === 0) {
      alert('暂无记录');
      return;
    }

    const headers = ['email', 'password', 'result'];
    const rows = history.map((record) => [
      record.email || '',
      record.password || '',
      resultText(record)
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[Popup] 导出错误:', error);
  }
}


/**
 * 清空历史
 */
async function clearHistory() {
  if (!confirm('确定要清空所有导出结果吗？')) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
    renderHistory([]);
  } catch (error) {
    console.error('[Popup] 清空错误:', error);
  }
}


// ==================== Gmail 配置功能 ====================

/**
 * 加载 Gmail 配置
 */
async function loadGmailConfig() {
  try {
    const result = await chrome.storage.local.get([
      'gmailAddress',
      'gmailForwardEnabled',
      'gmailForwardAddress',
      'gmailForwardServerUrl',
      'gmailForwardApiToken'
    ]);
    if (result.gmailAddress) {
      gmailAddress = result.gmailAddress;
      gmailAddressInput.value = gmailAddress;
      updateGmailStatus(true);
    }
    gmailForwardEnabled = Boolean(result.gmailForwardEnabled);
    gmailForwardAddress = result.gmailForwardAddress || '';
    gmailForwardServerUrl = result.gmailForwardServerUrl || DEFAULT_MAIL_SERVER_URL;
    gmailForwardApiToken = result.gmailForwardApiToken || DEFAULT_MAIL_API_TOKEN;
    gmailForwardEnabledInput.checked = gmailForwardEnabled;
    gmailForwardAddressInput.value = gmailForwardAddress;
    gmailForwardServerInput.value = gmailForwardServerUrl;
    gmailForwardTokenInput.value = gmailForwardApiToken;
    applyGmailForwardVisibility();
    if (gmailForwardEnabled && gmailForwardAddress && gmailForwardServerUrl && gmailForwardApiToken) {
      setGmailForwardStatus('收信设置已保存', false);
    }
  } catch (error) {
    console.error('[Gmail] 加载配置错误:', error);
  }
}

/**
 * 保存 Gmail 配置
 */
async function saveGmailConfig() {
  const email = gmailAddressInput.value.trim();
  
  if (!email) {
    gmailStatus.textContent = '请输入邮箱地址';
    gmailStatus.classList.add('error');
    return;
  }
  
  // 验证邮箱格式
  if (!email.includes('@')) {
    gmailStatus.textContent = '邮箱格式无效';
    gmailStatus.classList.add('error');
    return;
  }
  
  try {
    gmailAddress = email;
    await chrome.storage.local.set({ gmailAddress: email });
    updateGmailStatus(true);
  } catch (error) {
    console.error('[Gmail] 保存配置错误:', error);
    gmailStatus.textContent = '保存失败: ' + error.message;
    gmailStatus.classList.add('error');
  }
}

async function saveGmailForwardSettings() {
  const address = gmailForwardAddressInput.value.trim();
  const serverUrl = gmailForwardServerInput.value.trim().replace(/\/+$/, '');
  const token = gmailForwardTokenInput.value.trim();

  if (!address || !address.includes('@') || address.startsWith('@') || address.endsWith('@')) {
    setGmailForwardStatus('请填写有效的转发邮箱地址', true);
    gmailForwardAddressInput.focus();
    return;
  }
  if (!serverUrl || !token) {
    setGmailForwardStatus('请填写服务器地址和 API Token', true);
    return;
  }

  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('服务器地址需要以 http:// 或 https:// 开头');
    }
  } catch (error) {
    setGmailForwardStatus(error.message.startsWith('服务器地址') ? error.message : '服务器地址无效', true);
    return;
  }

  const allowed = await ensureMailOriginPermission(serverUrl);
  if (!allowed) {
    setGmailForwardStatus('未授予该服务器的访问权限', true);
    return;
  }

  gmailForwardEnabled = true;
  gmailForwardEnabledInput.checked = true;
  gmailForwardAddress = address;
  gmailForwardServerUrl = serverUrl;
  gmailForwardApiToken = token;
  gmailForwardServerInput.value = serverUrl;
  applyGmailForwardVisibility();
  updateSettingsHint();
  await chrome.storage.local.set({
    gmailForwardEnabled,
    gmailForwardAddress,
    gmailForwardServerUrl,
    gmailForwardApiToken
  });
  setGmailForwardStatus('收信设置已保存', false);
}

/**
 * 更新 Gmail 状态显示
 */
function updateGmailStatus(saved) {
  if (saved && gmailAddress) {
    gmailStatus.textContent = `✓ 已配置: ${gmailAddress}`;
    gmailStatus.classList.remove('error');
  } else {
    gmailStatus.textContent = '';
    gmailStatus.classList.remove('error');
  }
}

function applyGmailForwardVisibility() {
  gmailForwardSettings.style.display = gmailForwardEnabled ? 'flex' : 'none';
  if (gmailHint) {
    gmailHint.textContent = gmailForwardEnabled
      ? '自动生成别名变体（+号/点号/大小写）。验证码从转发邮箱自动读取并填写'
      : '自动生成别名变体（+号/点号/大小写），验证码需手动填写';
  }
}

function setGmailForwardStatus(message, isError) {
  gmailForwardStatus.textContent = message || '';
  gmailForwardStatus.classList.toggle('error', Boolean(isError));
}

function updateSettingsHint() {
  if (emailMode === 'domain') {
    settingsHint.textContent = '域名邮箱会自动读取并填写验证码';
  } else if (gmailForwardEnabled) {
    settingsHint.textContent = 'Gmail 别名的验证码会从转发邮箱自动读取并填写';
  } else {
    settingsHint.textContent = '使用 Gmail 别名时，验证码需手动填写，建议并发设为 1';
  }
}

function setDomainStatus(message, isError) {
  domainStatus.textContent = message || '';
  domainStatus.classList.toggle('error', Boolean(isError));
}

function applyEmailMode(mode) {
  emailMode = mode === 'domain' ? 'domain' : 'gmail';
  document.querySelectorAll('input[name="email-mode"]').forEach((input) => {
    input.checked = input.value === emailMode;
  });
  gmailSection.style.display = emailMode === 'gmail' ? 'block' : 'none';
  domainSection.style.display = emailMode === 'domain' ? 'block' : 'none';
  updateSettingsHint();
}

async function persistDomainSettings() {
  await chrome.storage.local.set({
    emailMode,
    emailDomains,
    blockedDomains,
    mailServerUrl,
    mailApiToken
  });
}

function usableDomains() {
  const blocked = new Set(blockedDomains.map((item) => String(item).trim().toLowerCase()));
  return emailDomains.filter((domain) => !blocked.has(String(domain).trim().toLowerCase()));
}

function renderDomainList() {
  if (emailDomains.length === 0) {
    domainList.innerHTML = '<li class="domain-empty">尚未添加域名</li>';
    return;
  }

  const blocked = new Set(blockedDomains.map((item) => String(item).trim().toLowerCase()));
  domainList.innerHTML = emailDomains.map((domain) => {
    const marked = blocked.has(String(domain).trim().toLowerCase());
    return `
    <li class="domain-item${marked ? ' domain-blocked' : ''}">
      <span>${escapeHtml(domain)}${marked ? ' [AWS已拉黑]' : ''}</span>
      <button type="button" class="btn-small btn-small-danger domain-remove" data-domain="${escapeHtml(domain)}">删除</button>
    </li>
  `;
  }).join('');
}

async function loadDomainSettings() {
  try {
    const stored = await chrome.storage.local.get([
      'emailMode',
      'emailDomains',
      'blockedDomains',
      'mailServerUrl',
      'mailApiToken'
    ]);
    emailDomains = Array.isArray(stored.emailDomains) ? stored.emailDomains : [];
    blockedDomains = Array.isArray(stored.blockedDomains) ? stored.blockedDomains : [];
    mailServerUrl = stored.mailServerUrl || DEFAULT_MAIL_SERVER_URL;
    mailApiToken = stored.mailApiToken || DEFAULT_MAIL_API_TOKEN;
    mailServerInput.value = mailServerUrl;
    mailTokenInput.value = mailApiToken;
    applyEmailMode(stored.emailMode || 'gmail');
    renderDomainList();
    if (mailServerUrl && mailApiToken) {
      setDomainStatus('收信设置已保存', false);
    }
  } catch (error) {
    console.error('[Popup] 加载域名设置错误:', error);
    applyEmailMode(emailMode);
  }
}

async function ensureMailOriginPermission(serverUrl) {
  let origin;
  try {
    origin = new URL(serverUrl).origin + '/*';
  } catch {
    return false;
  }
  const current = await chrome.permissions.contains({ origins: [origin] });
  if (current) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function addDomain() {
  try {
    const domain = normalizeDomain(domainInput.value);
    if (emailDomains.includes(domain)) {
      setDomainStatus('这个域名已经添加过', true);
      return;
    }
    emailDomains.push(domain);
    domainInput.value = '';
    renderDomainList();
    await persistDomainSettings();
    setDomainStatus(`已添加 ${domain}`, false);
  } catch (error) {
    setDomainStatus(error.message, true);
  }
}

async function saveMailSettings() {
  const serverUrl = mailServerInput.value.trim().replace(/\/+$/, '');
  const token = mailTokenInput.value.trim();

  if (!serverUrl || !token) {
    setDomainStatus('请填写服务器地址和 API Token', true);
    return;
  }

  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('服务器地址需要以 http:// 或 https:// 开头');
    }
  } catch (error) {
    setDomainStatus(error.message.startsWith('服务器地址') ? error.message : '服务器地址无效', true);
    return;
  }

  const allowed = await ensureMailOriginPermission(serverUrl);
  if (!allowed) {
    setDomainStatus('未授予该服务器的访问权限', true);
    return;
  }

  mailServerUrl = serverUrl;
  mailApiToken = token;
  mailServerInput.value = serverUrl;
  await persistDomainSettings();
  setDomainStatus('收信设置已保存', false);
}

/**
 * 初始化
 */
async function init() {
  // 获取当前状态
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response?.state) {
      updateUI(response.state);
    }
  } catch (error) {
    console.error('[Popup] 获取状态错误:', error);
  }

  // 加载 Gmail 配置
  const preferences = await chrome.storage.local.get('autoBootEnabled');
  autoBootEnabledInput.checked = Boolean(preferences.autoBootEnabled);
  autoBootEnabledInput.addEventListener('change', () => {
    chrome.storage.local.set({ autoBootEnabled: autoBootEnabledInput.checked });
  });

  await loadGmailConfig();
  await loadDomainSettings();

  // 监听状态更新
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'STATE_UPDATE') {
        updateUI(message.state);
        if (message.state?.devTestStatus === 'settled') {
          updateDevTestButtons({ prefillStarted: true });
          chrome.storage.local.set({ devAutoBootTestPrefillStarted: true });
        }
      }
    });
  } catch (error) {
    console.error('[Popup] 无法监听状态更新:', error);
  }

  // 绑定按钮事件
  startBtn.addEventListener('click', startRegistration);
  devStartInstanceBtn.addEventListener('click', startDevInstanceWindow);
  devStartTestBtn.addEventListener('click', startDevAutoBootTest);
  devStopTestBtn.addEventListener('click', stopDevAutoBootTest);
  const devState = await chrome.storage.local.get([
    'devAutoBootTestWindowId',
    'devAutoBootTestTabId',
    'devAutoBootTestPrefillStarted'
  ]);
  if (devState.devAutoBootTestWindowId) {
    try {
      await chrome.windows.get(devState.devAutoBootTestWindowId);
    } catch {
      await chrome.storage.local.remove('devAutoBootTestWindowId');
    }
  }
  let devTabOpen = false;
  if (devState.devAutoBootTestTabId) {
    try {
      await chrome.tabs.get(devState.devAutoBootTestTabId);
      devTabOpen = true;
    } catch {
      await chrome.storage.local.remove(['devAutoBootTestTabId', 'devAutoBootTestPrefillStarted']);
    }
  }
  let devTestSettled = false;
  try {
    const { state } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    devTestSettled = state?.devTestStatus === 'settled';
  } catch (error) {
    console.error('[Popup] 无法获取开发测试状态:', error);
  }
  if (devTestSettled) await chrome.storage.local.set({ devAutoBootTestPrefillStarted: true });
  updateDevTestButtons({
    prefillStarted: devTestSettled || (devTabOpen && Boolean(devState.devAutoBootTestPrefillStarted))
  });
  stopBtn.addEventListener('click', stopRegistration);
  resetBtn.addEventListener('click', reset);
  exportBtn.addEventListener('click', exportHistory);
  clearBtn.addEventListener('click', clearHistory);

  // Gmail 配置事件
  gmailSaveBtn.addEventListener('click', saveGmailConfig);
  gmailAddressInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      saveGmailConfig();
    }
  });
  gmailForwardEnabledInput.addEventListener('change', async () => {
    gmailForwardEnabled = gmailForwardEnabledInput.checked;
    applyGmailForwardVisibility();
    updateSettingsHint();
    await chrome.storage.local.set({ gmailForwardEnabled });
  });
  gmailForwardSaveBtn.addEventListener('click', saveGmailForwardSettings);

  document.querySelectorAll('input[name="email-mode"]').forEach((input) => {
    input.addEventListener('change', async () => {
      if (!input.checked) return;
      applyEmailMode(input.value);
      await persistDomainSettings();
    });
  });
  domainAddBtn.addEventListener('click', addDomain);
  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addDomain();
  });
  domainList.addEventListener('click', async (e) => {
    const button = e.target.closest('.domain-remove');
    if (!button) return;
    const domain = button.getAttribute('data-domain');
    emailDomains = emailDomains.filter((item) => item !== domain);
    blockedDomains = blockedDomains.filter((item) => item !== domain);
    renderDomainList();
    await persistDomainSettings();
    setDomainStatus(`已删除 ${domain}`, false);
  });
  mailSaveBtn.addEventListener('click', saveMailSettings);

  // 绑定复制按钮事件
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const targetElement = document.getElementById(targetId);
      if (targetElement && targetElement.textContent !== '-') {
        copyToClipboard(targetElement.textContent, btn);
      }
    });
  });
}

// 启动
document.addEventListener('DOMContentLoaded', init);
