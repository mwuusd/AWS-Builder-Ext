/**
 * 域名邮箱：随机地址，以及从收信接口 HTML 中取出验证码。
 * 有邮件时接口返回 AWS 邮件 HTML，验证码在 class="code" 的节点里。
 * 没有邮件时返回 JSON：{"error":"Verification email not found"}。
 */

function generateDomainEmail(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('未配置域名');
  }

  const domain = domains[Math.floor(Math.random() * domains.length)];
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const chars = letters + '0123456789';
  const length = 8 + Math.floor(Math.random() * 5);
  let local = letters[Math.floor(Math.random() * letters.length)];

  for (let i = 1; i < length; i++) {
    local += chars[Math.floor(Math.random() * chars.length)];
  }

  return `${local}@${domain}`;
}

function normalizeDomain(input) {
  const domain = String(input || '').trim().toLowerCase().replace(/^@+/, '');
  const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
  if (!valid) {
    throw new Error('域名格式无效');
  }
  return domain;
}

function buildMailLookupUrl(serverUrl, token, email) {
  const base = String(serverUrl || '').trim().replace(/\/+$/, '');
  const url = new URL(`${base}/Mail`);
  url.searchParams.set('token', token);
  url.searchParams.set('mail', email);
  return url.toString();
}

function extractVerificationCode(html) {
  const text = String(html || '');
  const classMatch = text.match(/class="code"[^>]*>\s*(\d{4,8})\s*</i);
  if (classMatch) return classMatch[1];

  const labelMatch = text.match(/verification code:\s*(?:<\/div>\s*)?(?:<div[^>]*>\s*)?(\d{4,8})/i);
  if (labelMatch) return labelMatch[1];

  return null;
}

function interpretMailResponse(status, body) {
  const trimmed = String(body || '').trim();
  let data = null;

  if (trimmed.startsWith('{')) {
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = null;
    }
  }

  if (data && data.error) {
    const message = String(data.error);
    if (status === 404 || /not found/i.test(message)) {
      return { pending: true };
    }
    const error = new Error(message);
    error.fatal = status === 401 || status === 403 || /invalid token/i.test(message);
    throw error;
  }

  if (status === 404) {
    return { pending: true };
  }

  if (status >= 400) {
    const error = new Error(`收信失败: HTTP ${status}`);
    error.fatal = status === 401 || status === 403;
    throw error;
  }

  const code = extractVerificationCode(trimmed);
  if (!code) {
    return { pending: true };
  }
  return { code };
}

async function fetchDomainVerificationCode({ serverUrl, token, email, fetchImpl = fetch }) {
  const url = buildMailLookupUrl(serverUrl, token, email);
  const response = await fetchImpl(url, { method: 'GET' });
  const body = await response.text();
  return interpretMailResponse(response.status, body);
}

export {
  generateDomainEmail,
  normalizeDomain,
  buildMailLookupUrl,
  extractVerificationCode,
  interpretMailResponse,
  fetchDomainVerificationCode
};
