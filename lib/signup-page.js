const BUILDER_SIGNUP_URL = 'https://signin.aws.amazon.com/signup?request_type=builderId';
const EC2_QUOTA_URL = 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A';
const EC2_LAUNCH_URL = 'https://console.aws.amazon.com/ec2/home?region=us-east-2#LaunchInstances:';

const PAYMENT_PHRASES = [
  'credit or debit card',
  'payment method',
  'add a payment method',
  'payment information',
  '信用卡',
  '付款方式',
  '添加付款'
];

function isConsoleUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'console.aws.amazon.com' || host.endsWith('.console.aws.amazon.com');
  } catch {
    return false;
  }
}

function isPaymentText(text) {
  const value = String(text || '').toLowerCase();
  return PAYMENT_PHRASES.some((phrase) => value.includes(phrase.toLowerCase()));
}

function isDomainBlockedText(text) {
  return /ERR-837/i.test(String(text || ''));
}

function isSignupFaultText(text) {
  return /Error\s*:?\s*83720\b/i.test(String(text || ''));
}

function domainNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function planAfterDomainBlock({ domains, email, pendingTasks }) {
  const blocked = String(email || '').split('@')[1]?.trim().toLowerCase() || '';
  const next = domainNames(domains).filter((item) => item !== blocked);
  return {
    blocked,
    domains: next,
    continueBatch: next.length > 0 && pendingTasks > 0
  };
}

function markDomainBlocked({ domains, blockedDomains, domain }) {
  const blocked = String(domain || '').trim().toLowerCase();
  const names = domainNames(domains);
  if (blocked && !names.includes(blocked)) names.push(blocked);
  const marks = new Set(domainNames(blockedDomains));
  if (blocked) marks.add(blocked);
  return {
    domains: names,
    blockedDomains: [...marks]
  };
}

const PHONE_PREFIXES = ['323660', '337727', '212330', '508336', '304380', '531309'];

function createAddressQuery(random = Math.random) {
  const head = 1 + Math.floor(random() * 9);
  const tail = Array.from({ length: 2 }, () => Math.floor(random() * 10)).join('');
  const letter = String.fromCharCode(97 + Math.floor(random() * 26));
  return `${head}${tail} ${letter}`;
}

function createContactPhone(random = Math.random) {
  const prefix = PHONE_PREFIXES[Math.floor(random() * PHONE_PREFIXES.length)];
  const suffix = Array.from({ length: 4 }, () => Math.floor(random() * 10)).join('');
  return `${prefix}${suffix}`;
}

export {
  BUILDER_SIGNUP_URL,
  EC2_QUOTA_URL,
  EC2_LAUNCH_URL,
  PAYMENT_PHRASES,
  isConsoleUrl,
  isPaymentText,
  isDomainBlockedText,
  isSignupFaultText,
  planAfterDomainBlock,
  markDomainBlocked,
  PHONE_PREFIXES,
  createAddressQuery,
  createContactPhone
};
