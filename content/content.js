/**
 * Content Script - 页面自动化
 * 持续检测页面类型并自动填写表单
 * 包含右上角实时进度 Toast
 */

(function() {
  'use strict';

  console.log('[Content Script] 已加载，当前 URL:', window.location.href);

  // ============== Toast 通知系统 ==============
  let toastContainer = null;
  let toastContent = null;
  let toastVisible = false;
  let hideTimeout = null;

  /**
   * 创建 Toast 容器
   */
  function createToast() {
    if (toastContainer) return;

    // 创建样式
    const style = document.createElement('style');
    style.textContent = `
      #aws-reg-toast {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        pointer-events: none;
        transition: opacity 0.3s, transform 0.3s;
        opacity: 0;
        transform: translateX(100%);
      }
      #aws-reg-toast.visible {
        opacity: 1;
        transform: translateX(0);
      }
      #aws-reg-toast-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        background: linear-gradient(135deg, #232f3e 0%, #1a242f 100%);
        color: #fff;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 153, 0, 0.3);
        min-width: 200px;
        max-width: 350px;
      }
      #aws-reg-toast-icon {
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #aws-reg-toast-icon svg {
        width: 100%;
        height: 100%;
      }
      #aws-reg-toast-icon.spinning svg {
        animation: aws-toast-spin 1.2s linear infinite;
      }
      @keyframes aws-toast-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      #aws-reg-toast-text {
        flex: 1;
        line-height: 1.4;
      }
      #aws-reg-toast-title {
        font-weight: 600;
        font-size: 12px;
        color: #ff9900;
        margin-bottom: 2px;
      }
      #aws-reg-toast-step {
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        word-break: break-word;
      }
      #aws-reg-toast-counter {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.6);
        margin-top: 4px;
      }
      #aws-reg-toast.success #aws-reg-toast-inner {
        background: linear-gradient(135deg, #1d4e2c 0%, #143d22 100%);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(82, 196, 26, 0.3);
      }
      #aws-reg-toast.success #aws-reg-toast-title {
        color: #52c41a;
      }
      #aws-reg-toast.error #aws-reg-toast-inner {
        background: linear-gradient(135deg, #4e1d1d 0%, #3d1414 100%);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(245, 34, 45, 0.3);
      }
      #aws-reg-toast.error #aws-reg-toast-title {
        color: #f5222d;
      }
    `;
    document.head.appendChild(style);

    // 创建 Toast 容器
    toastContainer = document.createElement('div');
    toastContainer.id = 'aws-reg-toast';
    toastContainer.innerHTML = `
      <div id="aws-reg-toast-inner">
        <div id="aws-reg-toast-icon" class="spinning">
          <svg viewBox="0 0 24 24" fill="none" stroke="#ff9900" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke="#ff9900"/>
          </svg>
        </div>
        <div id="aws-reg-toast-text">
          <div id="aws-reg-toast-title">AWS 自动注册</div>
          <div id="aws-reg-toast-step">准备中...</div>
          <div id="aws-reg-toast-counter" style="display: none;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(toastContainer);
    toastContent = {
      title: document.getElementById('aws-reg-toast-title'),
      step: document.getElementById('aws-reg-toast-step'),
      counter: document.getElementById('aws-reg-toast-counter'),
      icon: document.getElementById('aws-reg-toast-icon')
    };
  }

  /**
   * 显示 Toast
   */
  function showToast(state) {
    if (!toastContainer) createToast();
    if (!state) return;

    // 清除隐藏定时器
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }

    // 更新内容
    const step = state.step || state.status || '处理中...';
    toastContent.step.textContent = step;

    // 更新计数器 - 支持新的状态格式
    if (state.totalTarget > 1) {
      toastContent.counter.style.display = 'block';
      toastContent.counter.textContent = `进度: ${state.totalRegistered}/${state.totalTarget}`;
    } else if (state.loopMode && state.loopCount > 0) {
      // 兼容旧格式
      toastContent.counter.style.display = 'block';
      toastContent.counter.textContent = `已注册: ${state.totalRegistered} / 第 ${state.loopCount} 次`;
    } else {
      toastContent.counter.style.display = 'none';
    }

    // 更新状态样式
    toastContainer.classList.remove('success', 'error');
    toastContent.icon.classList.remove('spinning');

    if (state.status === 'completed') {
      toastContainer.classList.add('success');
      toastContent.title.textContent = '注册成功';
      toastContent.icon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="#52c41a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 12l3 3 5-6"/>
        </svg>
      `;
      // 成功后 5 秒自动隐藏
      hideTimeout = setTimeout(() => hideToast(), 5000);
    } else if (state.status === 'error') {
      toastContainer.classList.add('error');
      toastContent.title.textContent = '注册失败';
      toastContent.step.textContent = state.error || '未知错误';
      toastContent.icon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="#f5222d" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M15 9l-6 6M9 9l6 6"/>
        </svg>
      `;
      // 错误后 8 秒自动隐藏
      hideTimeout = setTimeout(() => hideToast(), 8000);
    } else if (state.status === 'idle') {
      // idle 状态不显示 toast
      hideToast();
      return;
    } else {
      // 进行中状态 (running, polling_token, initializing 等)
      const isMultiWindow = state.totalTarget > 1 || (state.sessions && state.sessions.length > 1);
      toastContent.title.textContent = isMultiWindow ? '批量注册中' : 'AWS 自动注册';
      toastContent.icon.classList.add('spinning');
      toastContent.icon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="#ff9900" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" stroke-opacity="0.3"/>
          <path d="M12 2a10 10 0 0 1 10 10"/>
        </svg>
      `;
    }

    // 显示
    toastContainer.classList.add('visible');
    toastVisible = true;
  }

  /**
   * 隐藏 Toast
   */
  function hideToast() {
    if (toastContainer) {
      toastContainer.classList.remove('visible');
      toastVisible = false;
    }
  }

  /**
   * 监听状态更新
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATE_UPDATE') {
      console.log('[Content Script] 收到状态更新:', message.state);
      showToast(message.state);
    }
  });

  // 初始化时获取当前状态并显示 Toast
  async function initToast() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (response?.state && response.state.status !== 'idle') {
        showToast(response.state);
      }
    } catch (e) {
      // 忽略错误
    }
  }

  // ============== 页面自动化逻辑 ==============

  // 页面类型
  const PAGE_TYPES = {
    LOGIN: 'login',
    NAME: 'name',
    VERIFY: 'verify',
    PASSWORD: 'password',
    CONTACT: 'contact',
    PAYMENT: 'payment',
    CONSOLE: 'console',
    DEVICE_CONFIRM: 'device_confirm',
    ALLOW_ACCESS: 'allow_access',
    COMPLETE: 'complete',
    UNKNOWN: 'unknown'
  };

  const PAYMENT_PHRASES = [
    'credit or debit card',
    'payment method',
    'add a payment method',
    'payment information',
    '信用卡',
    '付款方式',
    '添加付款'
  ];

  // 状态
  let isProcessing = false;
  let contactSubmitPending = false;
  let accountInfo = null;
  let verificationCode = null;
  let processedPages = new Set(); // 已处理的页面标识
  let pollInterval = null;

  /**
   * 延迟函数
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 查找元素（支持多个选择器）
   */
  function $(selectors) {
    const list = selectors.split(',').map(s => s.trim());
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * 等待元素出现
   */
  async function waitFor(selectors, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = $(selectors);
      if (el) return el;
      await sleep(100);
    }
    throw new Error(`等待元素超时: ${selectors}`);
  }

  /**
   * 更新步骤到 Service Worker 和本地 Toast
   */
  function updateStep(step) {
    console.log('[Content Script]', step);
    chrome.runtime.sendMessage({ type: 'UPDATE_STEP', step }).catch(() => {});
    // 同时更新本地 Toast
    showToast({ step, status: 'initializing' });
  }

  /**
   * 报告错误
   */
  function reportError(error) {
    console.error('[Content Script] 错误:', error);
    chrome.runtime.sendMessage({ type: 'REPORT_ERROR', error }).catch(() => {});
  }

  /**
   * 获取账号信息（带重试和详细日志）
   */
  async function getAccountInfo() {
    if (accountInfo && accountInfo.email) {
      return accountInfo;
    }

    console.log('[Content Script] 开始获取账号信息...');

    for (let i = 0; i < 10; i++) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_INFO' });
        if (response && response.email) {
          accountInfo = response;
          console.log('[Content Script] 获取到账号信息:', accountInfo.email);
          return accountInfo;
        } else {
          console.log(`[Content Script] 第 ${i + 1} 次尝试: 未获取到账号信息`);
        }
      } catch (e) {
        console.log(`[Content Script] 第 ${i + 1} 次尝试失败:`, e.message);
      }
      await sleep(300);
    }

    console.warn('[Content Script] 多次尝试后仍未获取到账号信息');
    return null;
  }

  /**
   * 获取验证码（Gmail 别名模式 - 等待用户手动输入）
   */
  async function getVerificationCode() {
    if (verificationCode) {
      return { code: verificationCode };
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_VERIFICATION_CODE' });
      if (response && response.success && response.code) {
        verificationCode = response.code;
        console.log('[Content Script] 已获取验证码');
        return { code: verificationCode };
      }
      if (response && response.pending) {
        return { pending: true };
      }
      if (response && response.fatal) {
        return { fatal: true, error: response.error || '收信失败' };
      }
      if (response && response.needManualInput) {
        return { manual: true };
      }
    } catch (e) {
      console.error('[Content Script] 获取验证码失败:', e);
    }
    return { manual: true };
  }

  /**
   * 快速填充输入框（最高效方案）
   */
  const EMAIL_INPUT_SELECTORS = [
    '#email-address',
    'input[placeholder="Enter your email"]',
    'input[placeholder*="email" i]',
    'input[name="emailAddress"]',
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[placeholder="username@example.com"]'
  ].join(', ');

  function isVisible(el) {
    return Boolean(el && el.offsetParent !== null && !el.disabled);
  }

  function findButton(selectors, labels) {
    const direct = $(selectors);
    if (isVisible(direct)) return direct;
    for (const button of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      const text = (button.innerText || button.value || '').replace(/\s+/g, ' ').trim();
      if (labels.some((label) => text === label || text.includes(label)) && isVisible(button)) {
        return button;
      }
    }
    return null;
  }

  const US_STATE_NAMES = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
    ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
    il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
    me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
    mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
    nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
    or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
    tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
    wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia'
  };

  function normalizePlace(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text === 'us' || text === 'usa' || text === 'united states of america') return 'united states';
    return US_STATE_NAMES[text] || text;
  }

  function pressControl(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const point = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: Math.round(rect.left + Math.max(rect.width, 1) / 2),
      clientY: Math.round(rect.top + Math.max(rect.height, 1) / 2)
    };
    const pointer = { ...point, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', pointer));
    el.dispatchEvent(new MouseEvent('mousedown', point));
    el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...point, buttons: 0 }));
    el.click();
    return true;
  }

  async function selectAwsOption(button, wanted) {
    if (!button || !wanted) return false;
    const target = normalizePlace(wanted);
    const selected = () => {
      const current = normalizePlace(button.innerText || '');
      return Boolean(current && (current === target || current.includes(target)));
    };
    if (selected()) return true;

    // Cloudscape 下拉只在 mousedown 时展开，单独 click() 不会打开选项。
    pressControl(button);
    await sleep(400);
    let options = [...document.querySelectorAll('[role="option"]')].filter(isVisible);
    if (!options.length) {
      pressControl(button);
      await sleep(400);
      options = [...document.querySelectorAll('[role="option"]')].filter(isVisible);
    }
    const match = options.find((option) => normalizePlace(option.innerText) === target);
    if (!match) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
    pressControl(match);
    await sleep(200);
    return selected();
  }

  function fastFill(el, text) {
    // 聚焦
    el.focus();
    
    // 直接设置值
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(el, text);
    
    // 触发所有必要的事件
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
  }

  /**
   * 快速点击按钮
   */
  function fastClick(btn) {
    if (!btn) return false;
    
    // 确保按钮可见且可点击
    if (btn.offsetParent === null || btn.disabled) {
      return false;
    }
    
    // 触发点击
    btn.click();
    return true;
  }

  /**
   * 检测当前页面类型
   */
  function detectPageType() {
    const url = window.location.href;
    const host = window.location.hostname;
    const text = document.body?.innerText || '';

    console.log('[Content Script] 检测页面 - URL:', url, 'Host:', host);

    if (host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com')) {
      return PAGE_TYPES.CONSOLE;
    }

    const cardField = $('input[autocomplete="cc-number"], input[autocomplete="cc-csc"], input[name="cardNumber"], input[name="creditCard"]');
    const lowered = text.toLowerCase();
    if ((cardField && cardField.offsetParent !== null) || PAYMENT_PHRASES.some((phrase) => lowered.includes(phrase.toLowerCase()))) {
      return PAGE_TYPES.PAYMENT;
    }

    // 完成页面
    if (text.includes('successfully authorized') || text.includes('Authorization complete') || text.includes('You have been successfully authorized')) {
      return PAGE_TYPES.COMPLETE;
    }

    // 授权页 - Allow access 按钮（优先检测，因为可能在 awsapps.com 域名下）
    const allowBtn = $('button#cli_login_button, button[data-testid="allow-access-button"], input[type="submit"][value*="Allow"]');
    if (allowBtn && allowBtn.offsetParent !== null) {
      return PAGE_TYPES.ALLOW_ACCESS;
    }
    // 也检查页面文本
    if ((text.includes('Allow access') || text.includes('allow access')) && host.includes('awsapps.com')) {
      return PAGE_TYPES.ALLOW_ACCESS;
    }

    // 设备确认页 - 检查按钮
    const confirmBtn = $('button#cli_verification_btn, button[data-testid="confirm-device-button"]');
    if (confirmBtn && confirmBtn.offsetParent !== null) {
      return PAGE_TYPES.DEVICE_CONFIRM;
    }
    // 也检查页面文本
    if (text.includes('Confirm and continue') || text.includes('confirm this code')) {
      return PAGE_TYPES.DEVICE_CONFIRM;
    }

    // 验证码页
    if (url.includes('verify-otp') || url.includes('verification') || url.includes('verifyEmail')) {
      return PAGE_TYPES.VERIFY;
    }

    // 姓名页
    if (url.includes('enter-email') || url.includes('signup/enter') || url.includes('createAccount')) {
      return PAGE_TYPES.NAME;
    }

    // 密码页
    const pwdInput = $('input[placeholder="Enter password"], input[name="password"], input[type="password"][autocomplete="new-password"]');
    const confirmPwdInput = $('input[placeholder="Re-enter password"], input[name="confirmPassword"], input[type="password"][autocomplete="new-password"]:nth-of-type(2)');
    if (pwdInput && confirmPwdInput) {
      return PAGE_TYPES.PASSWORD;
    }

    const contactField = $([
      '[id="address.addressLine1"]',
      'input[name="address.addressLine1"]',
      'input[autocomplete="address-line1"]',
      '[id="address.phoneNumber"]',
      'input[name="address.phoneNumber"]',
      'input[autocomplete="tel-national"]',
      'input[type="tel"]',
      'input[name="phoneNumber"]'
    ].join(', '));
    if (contactField && contactField.offsetParent !== null) {
      return PAGE_TYPES.CONTACT;
    }

    // 登录页 - 支持多种选择器
    const emailInput = $(EMAIL_INPUT_SELECTORS);
    if (isVisible(emailInput)) {
      return PAGE_TYPES.LOGIN;
    }

    return PAGE_TYPES.UNKNOWN;
  }

  /**
   * 生成页面标识（用于避免重复处理）
   */
  function getPageId() {
    const type = detectPageType();
    // 包含 hash，因为 AWS 用 SPA 路由
    const url = window.location.href.split('?')[0] + window.location.hash;
    return `${type}:${url}`;
  }

  /**
   * 处理 Cookie 弹窗
   */
  function handleCookiePopup() {
    const btn = $('button[data-id="awsccc-cb-btn-accept"]');
    if (btn) {
      btn.click();
      console.log('[Content Script] 已关闭 Cookie 弹窗');
    }
  }

  /**
   * 处理登录页
   */
  async function handleLoginPage() {
    updateStep('填写邮箱...');

    const info = await getAccountInfo();
    if (!info?.email) {
      reportError('无法获取邮箱信息');
      return false;
    }

    const emailInput = $(EMAIL_INPUT_SELECTORS);
    if (!isVisible(emailInput)) {
      console.log('[Content Script] 找不到邮箱输入框');
      return false;
    }

    fastFill(emailInput, info.email);
    await sleep(200);

    updateStep('点击继续...');
    const btn = findButton(
      'button[data-testid="continue-email-button"], button[data-testid="test-primary-button"], button[type="submit"]',
      ['Continue with email']
    );
    if (!fastClick(btn)) {
      console.log('[Content Script] 找不到继续按钮');
      return false;
    }

    return true;
  }

  /**
   * 处理姓名页
   */
  async function handleNamePage() {
    updateStep('填写姓名...');

    const info = await getAccountInfo();
    if (!info?.fullName) {
      reportError('无法获取姓名信息');
      return false;
    }

    const nameInput = $('input[placeholder="Maria José Silva"], input[placeholder*="name" i], input[name="name"], input[name="fullName"]');
    if (!nameInput) {
      console.log('[Content Script] 找不到姓名输入框');
      return false;
    }

    fastFill(nameInput, info.fullName);
    await sleep(200);

    updateStep('点击继续...');
    const btn = findButton(
      'button[data-testid="signup-next-button"]',
      ['Continue']
    );
    if (!fastClick(btn)) {
      console.log('[Content Script] 找不到姓名页继续按钮');
      return false;
    }

    return true;
  }

  /**
   * 处理验证码页（Gmail 别名模式 - 用户手动输入）
   */
  async function handleVerifyPage() {
    const result = await getVerificationCode();

    if (result.pending) {
      updateStep('正在收取验证码...');
      return false;
    }

    if (result.fatal) {
      updateStep(result.error || '收信失败');
      reportError(result.error || '收信失败');
      return true;
    }

    if (!result.code) {
      updateStep('请从 Gmail 收件箱获取验证码并手动填写');
      console.log('[Content Script] Gmail 别名模式，等待用户手动输入验证码');
      return true;
    }

    const code = result.code;
    updateStep(`填写验证码: ${code}`);
    const codeInput = $([
      'input[placeholder="6-digit"]',
      'input[placeholder*="digit" i]',
      'input[placeholder*="位数"]',
      'input[name="otp"]',
      'input[name="code"]'
    ].join(', '));
    if (!isVisible(codeInput)) {
      console.log('[Content Script] 找不到验证码输入框');
      return false;
    }

    fastFill(codeInput, code);
    await sleep(200);

    updateStep('点击验证...');
    const btn = findButton(
      'button[data-testid="email-verification-verify-button"]',
      ['Continue', 'Verify']
    );
    if (!fastClick(btn)) {
      console.log('[Content Script] 找不到验证按钮');
      return false;
    }

    return true;
  }

  /**
   * 处理密码页
   */
  async function handlePasswordPage() {
    updateStep('填写密码...');

    const info = await getAccountInfo();
    if (!info?.password) {
      reportError('无法获取密码信息');
      return false;
    }

    const pwdInput = $('input[placeholder="Enter password"], input[name="password"], input[type="password"]:not([name="confirmPassword"])');
    const confirmInput = $('input[placeholder="Re-enter password"], input[name="confirmPassword"]');

    if (!pwdInput) {
      console.log('[Content Script] 找不到密码输入框');
      return false;
    }

    fastFill(pwdInput, info.password);
    
    if (confirmInput) {
      await sleep(100);
      fastFill(confirmInput, info.password);
    }
    
    await sleep(200);

    updateStep('点击继续...');
    const btn = findButton(
      'button[data-testid="test-primary-button"]',
      ['Continue']
    );
    if (!fastClick(btn)) {
      console.log('[Content Script] 找不到密码页继续按钮');
      return false;
    }

    return true;
  }

  function selectByText(select, wanted) {
    const target = String(wanted || '').trim().toLowerCase();
    if (!target) return false;
    const options = Array.from(select.options || []);
    const match = options.find((option) => {
      const text = option.text.trim().toLowerCase();
      const value = option.value.trim().toLowerCase();
      return text === target || value === target;
    }) || options.find((option) => option.text.toLowerCase().includes(target));
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function createAddressQuery() {
    const digits = Array.from({ length: 3 }, () => Math.floor(Math.random() * 10)).join('');
    const letter = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    return `${digits} ${letter}`;
  }

  function createContactPhone() {
    const suffix = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join('');
    return `323660${suffix}`;
  }

  async function typeAddressQuery(input, text) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward'
    }));
    for (const char of text) {
      setter.call(input, `${input.value}${char}`);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char
      }));
      await sleep(80);
    }
  }

  function addressSuggestions() {
    return [...document.querySelectorAll('[role="option"]')].filter((option) => {
      if (!isVisible(option)) return false;
      const text = (option.innerText || '').replace(/\s+/g, ' ').trim();
      return text.length > 8 && (text.includes(',') || /\d/.test(text)) && suggestionLooksDeliverable(text);
    });
  }

  async function waitForAddressSuggestions(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const options = addressSuggestions();
      if (options.length) return options;
      await sleep(200);
    }
    return [];
  }

  function dismissAddressError() {
    for (const node of document.querySelectorAll('[role="alert"], [class*="error"], [class*="alert"]')) {
      if (/address entered is invalid/i.test(node.innerText || '')) {
        node.style.display = 'none';
      }
    }
  }

  function addressRejected() {
    const text = document.body?.innerText || '';
    return /address entered is invalid/i.test(text);
  }

  function postalLooksValid(value) {
    return /^\d{5}(?:-\d{4})?$/.test(String(value || '').trim());
  }

  function suggestionLooksDeliverable(text) {
    const zip4 = String(text || '').match(/\b\d{5}-([A-Za-z0-9]+)\b/);
    return !(zip4 && /[A-Za-z]/.test(zip4[1]));
  }

  function clearInputValue(el) {
    if (!el || el.tagName !== 'INPUT') return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward'
    }));
  }

  function contactValue(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    return (el.value || el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  async function waitForSuggestedAddress(timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const city = contactValue('address.city');
      const postal = contactValue('address.postalCode');
      const state = contactValue('address.state');
      if (city && postalLooksValid(postal) && state && !addressRejected()) return true;
      await sleep(200);
    }
    return false;
  }

  async function handleContactPage() {
    updateStep('搜索地址...');
    let address = document.getElementById('address.addressLine1') || $(
      'input[name="address.addressLine1"], input[autocomplete="address-line1"]'
    );
    if (!address) {
      const manual = [...document.querySelectorAll('a, button')].find((el) =>
        /enter address manually/i.test(el.innerText || '') && isVisible(el)
      );
      if (manual) {
        pressControl(manual);
        await sleep(400);
        address = document.getElementById('address.addressLine1');
      }
    }
    if (!address) {
      console.log('[Content Script] 找不到地址输入框');
      return false;
    }

    if (!address) {
      console.log('[Content Script] 找不到地址输入框');
      return false;
    }

    if (contactSubmitPending) {
      if (!/contactinformation/i.test(location.href)) {
        contactSubmitPending = false;
        return true;
      }
      if (!addressRejected()) return false;
      contactSubmitPending = false;
      dismissAddressError();
    }

    let phoneNumber = '';
    const existingPhone = document.getElementById('address.phoneNumber');
    if (existingPhone && /^323660\d{4}$/.test(existingPhone.value || '')) {
      phoneNumber = existingPhone.value;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0 || addressRejected() || !postalLooksValid(contactValue('address.postalCode'))) {
        updateStep('地址无效，重新搜索...');
        dismissAddressError();
        clearInputValue(address);
        clearInputValue(document.getElementById('address.city'));
        clearInputValue(document.getElementById('address.postalCode'));
        clearInputValue(document.getElementById('address.addressLine2'));
        await sleep(300);
        const query = createAddressQuery();
        updateStep(`搜索地址 ${query}...`);
        await typeAddressQuery(address, query);
        const options = await waitForAddressSuggestions();
        if (!options.length) continue;
        pressControl(options[0]);
        if (!(await waitForSuggestedAddress())) continue;
      }

      let phone = document.getElementById('address.phoneNumber') || $(
        'input[name="address.phoneNumber"], input[autocomplete="tel-national"]'
      );
      if (!isVisible(phone)) {
        await sleep(500);
        phone = document.getElementById('address.phoneNumber');
      }
      if (!isVisible(phone)) {
        reportError('找不到电话输入框');
        return true;
      }
      if (!phoneNumber) phoneNumber = createContactPhone();
      updateStep(`填写电话 ${phoneNumber}...`);
      fastFill(phone, phoneNumber);
      await sleep(200);

      updateStep('提交联系信息...');
      const btn = findButton(
        'button[data-testid="starter-home-contact-info-submit-button"], button[data-testid="test-primary-button"]',
        ['Continue']
      );
      if (!pressControl(btn)) {
        console.log('[Content Script] 找不到联系信息继续按钮');
        return false;
      }

      contactSubmitPending = true;
      const started = Date.now();
      while (Date.now() - started < 8000) {
        if (!/contactinformation/i.test(location.href)) {
          contactSubmitPending = false;
          return true;
        }
        if (addressRejected()) break;
        await sleep(250);
      }
      if (!/contactinformation/i.test(location.href)) {
        contactSubmitPending = false;
        return true;
      }
      if (!addressRejected()) return false;
      contactSubmitPending = false;
      dismissAddressError();
    }

    reportError('地址多次被页面拒绝');
    return true;
  }

  function handlePaymentPage() {
    updateStep('要求添加付款资料');
    chrome.runtime.sendMessage({
      type: 'PAYMENT_REQUIRED',
      error: '要求添加付款资料'
    }).catch(() => {});
    return true;
  }

  function handleConsolePage() {
    updateStep('已进入控制台');
    chrome.runtime.sendMessage({ type: 'REGISTRATION_COMPLETED' }).catch(() => {});
    return true;
  }

  function handleUnexpectedDevicePage() {
    const error = '出现设备配对页面，注册已停止';
    updateStep(error);
    reportError(error);
    return true;
  }

  /**
   * 处理设备确认页
   */
  async function handleDeviceConfirmPage() {
    updateStep('点击确认设备...');
    await sleep(300);

    // 尝试多种选择器
    const btn = $('button#cli_verification_btn, button[data-testid="confirm-device-button"], button[type="submit"]');
    if (btn && fastClick(btn)) {
      updateStep('已确认设备，等待授权页...');
      return true;
    }

    // 如果找不到按钮，尝试查找所有包含 "Confirm" 文字的按钮
    const buttons = document.querySelectorAll('button');
    for (const b of buttons) {
      if (b.textContent.includes('Confirm') && fastClick(b)) {
        updateStep('已确认设备，等待授权页...');
        return true;
      }
    }

    console.log('[Content Script] 找不到确认按钮');
    return false;
  }

  /**
   * 处理授权页
   */
  async function handleAllowAccessPage() {
    updateStep('点击允许访问...');
    await sleep(300);

    // 尝试多种选择器
    const btn = $('button#cli_login_button, button[data-testid="allow-access-button"], input[type="submit"][value*="Allow"]');
    if (btn && fastClick(btn)) {
      updateStep('已允许访问，等待完成...');
      chrome.runtime.sendMessage({ type: 'AUTH_COMPLETED' }).catch(() => {});
      return true;
    }

    // 如果找不到按钮，尝试查找所有包含 "Allow" 文字的按钮
    const buttons = document.querySelectorAll('button, input[type="submit"]');
    for (const b of buttons) {
      const text = b.textContent || b.value || '';
      if (text.includes('Allow') && fastClick(b)) {
        updateStep('已允许访问，等待完成...');
        chrome.runtime.sendMessage({ type: 'AUTH_COMPLETED' }).catch(() => {});
        return true;
      }
    }

    console.log('[Content Script] 找不到允许按钮');
    return false;
  }

  /**
   * 处理完成页
   */
  function handleCompletePage() {
    updateStep('授权完成！');
    chrome.runtime.sendMessage({ type: 'AUTH_COMPLETED' }).catch(() => {});
    return true;
  }

  /**
   * 主处理函数
   */
  async function processPage() {
    if (isProcessing) return;

    // 检查是否有正在进行的注册
    const info = await getAccountInfo();
    if (!info?.email) {
      console.log('[Content Script] 没有注册任务，跳过');
      return;
    }

    const pageId = getPageId();
    if (processedPages.has(pageId)) {
      return; // 已处理过
    }

    isProcessing = true;
    handleCookiePopup();

    const pageType = detectPageType();
    console.log('[Content Script] 页面类型:', pageType, '页面ID:', pageId);

    let success = false;
    try {
      switch (pageType) {
        case PAGE_TYPES.LOGIN:
          success = await handleLoginPage();
          break;
        case PAGE_TYPES.NAME:
          success = await handleNamePage();
          break;
        case PAGE_TYPES.VERIFY:
          success = await handleVerifyPage();
          break;
        case PAGE_TYPES.PASSWORD:
          success = await handlePasswordPage();
          break;
        case PAGE_TYPES.CONTACT:
          success = await handleContactPage();
          break;
        case PAGE_TYPES.PAYMENT:
          success = handlePaymentPage();
          break;
        case PAGE_TYPES.CONSOLE:
          success = handleConsolePage();
          break;
        case PAGE_TYPES.DEVICE_CONFIRM:
        case PAGE_TYPES.ALLOW_ACCESS:
        case PAGE_TYPES.COMPLETE:
          success = handleUnexpectedDevicePage();
          break;
        default:
          console.log('[Content Script] 未知页面，继续等待...');
      }

      if (success) {
        processedPages.add(pageId);
      }
    } catch (error) {
      console.error('[Content Script] 处理错误:', error);
      reportError(error.message);
    } finally {
      isProcessing = false;
    }
  }

  /**
   * 开始持续轮询检测
   */
  function startPolling() {
    if (pollInterval) return;

    console.log('[Content Script] 开始轮询检测页面...');

    // 立即执行一次
    processPage();

    // 每 500ms 检测一次（加快响应速度）
    pollInterval = setInterval(() => {
      processPage();
    }, 500);
  }

  /**
   * 停止轮询
   */
  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // 页面卸载时停止轮询
  window.addEventListener('beforeunload', stopPolling);

  // 初始化
  async function init() {
    console.log('[Content Script] 初始化...');

    // 等待 DOM 完全加载
    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve));
    }

    await sleep(200);

    // 初始化 Toast（获取当前状态）
    initToast();

    await sleep(200);
    startPolling();
  }

  init();
})();
