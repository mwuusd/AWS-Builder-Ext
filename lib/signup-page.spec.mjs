import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_SIGNUP_URL,
  isConsoleUrl,
  isPaymentText,
  createAddressQuery,
  createContactPhone
} from './signup-page.js';

test('signup starts at the official Builder ID url', () => {
  assert.equal(
    BUILDER_SIGNUP_URL,
    'https://signin.aws.amazon.com/signup?request_type=builderId'
  );
});

test('console hosts count as signed in', () => {
  assert.equal(isConsoleUrl('https://console.aws.amazon.com/console/home'), true);
  assert.equal(isConsoleUrl('https://us-east-1.console.aws.amazon.com/console/home'), true);
  assert.equal(isConsoleUrl('https://signin.aws.amazon.com/signup?request_type=builderId'), false);
  assert.equal(isConsoleUrl('https://view.awsapps.com/start'), false);
});

test('payment copy is recognized and ordinary signup copy is not', () => {
  assert.equal(isPaymentText('Add a payment method\nCredit or debit card'), true);
  assert.equal(isPaymentText('请添加付款方式'), true);
  assert.equal(isPaymentText('Verify your email address'), false);
  assert.equal(isPaymentText('Get up to USD $200 in credits'), false);
});

test('address lookup is three digits and one letter', () => {
  const sequence = [0.14, 0.25, 0.36, 0.5];
  let index = 0;
  const query = createAddressQuery(() => sequence[index++]);
  assert.equal(query, '123 n');
  assert.match(createAddressQuery(), /^\d{3} [a-z]$/);
});

test('contact phone starts with 323660 and four random digits', () => {
  const sequence = [0.1, 0.2, 0.3, 0.4];
  let index = 0;
  const phone = createContactPhone(() => sequence[index++]);
  assert.equal(phone, '3236601234');
  assert.match(createContactPhone(), /^323660\d{4}$/);
});
