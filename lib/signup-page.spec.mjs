import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_SIGNUP_URL,
  EC2_QUOTA_URL,
  isConsoleUrl,
  isPaymentText,
  isDomainBlockedText,
  isSignupFaultText,
  planAfterDomainBlock,
  markDomainBlocked,
  PHONE_PREFIXES,
  createAddressQuery,
  createContactPhone
} from './signup-page.js';

test('signup starts at the official Builder ID url', () => {
  assert.equal(
    BUILDER_SIGNUP_URL,
    'https://signin.aws.amazon.com/signup?request_type=builderId'
  );
});

test('EC2 quota target is the requested account-level quota page', () => {
  assert.equal(EC2_QUOTA_URL, 'https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A');
});

test('console hosts count as signed in', () => {
  assert.equal(isConsoleUrl('https://console.aws.amazon.com/console/home'), true);
  assert.equal(isConsoleUrl('https://us-east-1.console.aws.amazon.com/console/home'), true);
  assert.equal(
    isConsoleUrl('https://910453117359-s37namr4.us-east-2.console.aws.amazon.com/console/home?region=us-east-2#'),
    true
  );
  assert.equal(isConsoleUrl('https://signin.aws.amazon.com/signup?request_type=builderId'), false);
  assert.equal(isConsoleUrl('https://view.awsapps.com/start'), false);
});

test('payment copy is recognized and ordinary signup copy is not', () => {
  assert.equal(isPaymentText('Add a payment method\nCredit or debit card'), true);
  assert.equal(isPaymentText('请添加付款方式'), true);
  assert.equal(isPaymentText('Verify your email address'), false);
  assert.equal(isPaymentText('Get up to USD $200 in credits'), false);
});

test('address lookup is three digits and one letter, and does not start with zero', () => {
  const sequence = [0.14, 0.25, 0.36, 0.5];
  let index = 0;
  const query = createAddressQuery(() => sequence[index++]);
  assert.equal(query, '223 n');
  assert.match(createAddressQuery(), /^[1-9]\d{2} [a-z]$/);
});

test('ERR-837 means the signup domain is blocked', () => {
  const page = [
    'Error',
    'ERR-837 - Sorry, there was an error processing your request. Please try again.',
    'Enter your name'
  ].join('\n');
  assert.equal(isDomainBlockedText(page), true);
  assert.equal(isDomainBlockedText('Enter your name\nJacqueline West'), false);
});

test('Error 83720 ends the current signup without treating it as a blocked domain', () => {
  const page = [
    'Enter your contact details',
    'Error 83720: Sorry, there was an error processing your request.',
    'Please refresh the page and try again.'
  ].join('\n');
  assert.equal(isSignupFaultText(page), true);
  assert.equal(isSignupFaultText('Error: 83720'), true);
  assert.equal(isDomainBlockedText(page), false);
  assert.equal(isSignupFaultText('Postal Code\n94301-2012'), false);
});

test('a blocked domain stays in the list and is marked so later signups skip it', () => {
  const marked = markDomainBlocked({
    domains: ['ae.melindazhang.com', 'i.totalcare.pk', 'u.marcosruben.com'],
    blockedDomains: [],
    domain: 'AE.melindazhang.com'
  });
  assert.deepEqual(marked.domains, ['ae.melindazhang.com', 'i.totalcare.pk', 'u.marcosruben.com']);
  assert.deepEqual(marked.blockedDomains, ['ae.melindazhang.com']);
});

test('a blocked domain is skipped and the batch continues only when another usable domain and another task remain', () => {
  const continued = planAfterDomainBlock({
    domains: ['my.mypjnr.org', 'other.example'],
    email: 'iw3h3ntzq@my.mypjnr.org',
    pendingTasks: 2
  });
  assert.equal(continued.blocked, 'my.mypjnr.org');
  assert.deepEqual(continued.domains, ['other.example']);
  assert.equal(continued.continueBatch, true);

  const stopped = planAfterDomainBlock({
    domains: ['My.MyPJNR.org'],
    email: 'iw3h3ntzq@my.mypjnr.org',
    pendingTasks: 4
  });
  assert.deepEqual(stopped.domains, []);
  assert.equal(stopped.continueBatch, false);

  const lastTask = planAfterDomainBlock({
    domains: ['my.mypjnr.org', 'other.example'],
    email: 'iw3h3ntzq@my.mypjnr.org',
    pendingTasks: 0
  });
  assert.deepEqual(lastTask.domains, ['other.example']);
  assert.equal(lastTask.continueBatch, false);
});

test('contact phone uses one of the area prefixes and four random digits', () => {
  const sequence = [0, 0.1, 0.2, 0.3, 0.4];
  let index = 0;
  const phone = createContactPhone(() => sequence[index++]);
  assert.equal(phone, '3236601234');
  const prefixes = PHONE_PREFIXES.join('|');
  assert.match(createContactPhone(), new RegExp(`^(${prefixes})\\d{4}$`));
});
