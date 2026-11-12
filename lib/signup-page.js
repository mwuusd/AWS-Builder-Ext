const BUILDER_SIGNUP_URL = 'https://signin.aws.amazon.com/signup?request_type=builderId';

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

function createAddressQuery(random = Math.random) {
  const digits = Array.from({ length: 3 }, () => Math.floor(random() * 10)).join('');
  const letter = String.fromCharCode(97 + Math.floor(random() * 26));
  return `${digits} ${letter}`;
}

function createContactPhone(random = Math.random) {
  const suffix = Array.from({ length: 4 }, () => Math.floor(random() * 10)).join('');
  return `323660${suffix}`;
}

export {
  BUILDER_SIGNUP_URL,
  PAYMENT_PHRASES,
  isConsoleUrl,
  isPaymentText,
  createAddressQuery,
  createContactPhone
};
