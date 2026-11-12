import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDomainEmail,
  normalizeDomain,
  buildMailLookupUrl,
  extractVerificationCode,
  interpretMailResponse,
  fetchDomainVerificationCode
} from './domain-mail.js';

test('normalizeDomain accepts a hostname and rejects junk', () => {
  assert.equal(normalizeDomain(' My.Example.com '), 'my.example.com');
  assert.equal(normalizeDomain('@my.mypjnr.org'), 'my.mypjnr.org');
  assert.throws(() => normalizeDomain('not a domain'), /域名格式无效/);
  assert.throws(() => normalizeDomain('user@example.com'), /域名格式无效/);
});

test('generateDomainEmail picks one of the configured domains and a random local part', () => {
  const domains = ['alpha.example', 'beta.example'];
  for (let i = 0; i < 20; i++) {
    const email = generateDomainEmail(domains);
    assert.match(email, /^[a-z][a-z0-9]{7,11}@(alpha\.example|beta\.example)$/);
  }
  assert.throws(() => generateDomainEmail([]), /未配置域名/);
});

test('buildMailLookupUrl uses the /Mail endpoint and encodes the address', () => {
  const url = buildMailLookupUrl('http://mail.example:2099/', '2088', 'bee@my.mypjnr.org');
  assert.equal(
    url,
    'http://mail.example:2099/Mail?token=2088&mail=bee%40my.mypjnr.org'
  );
});

test('extractVerificationCode reads div.code and ignores other numbers', () => {
  const html = `
    <div class="label">Verification code:</div>
    <div class="code" style="font-size:36px;">123456</div>
    <p>Seattle, WA 98109 reference 111111</p>
  `;
  assert.equal(extractVerificationCode(html), '123456');
  assert.equal(extractVerificationCode('<p>no code here</p>'), null);
});

test('interpretMailResponse waits when the inbox is empty and rejects a bad token', () => {
  assert.deepEqual(
    interpretMailResponse(404, '{"error":"Verification email not found"}'),
    { pending: true }
  );

  assert.throws(
    () => interpretMailResponse(401, '{"error":"Invalid token"}'),
    (error) => error.fatal === true && error.message === 'Invalid token'
  );

  assert.deepEqual(
    interpretMailResponse(200, '<div class="code">654321</div>'),
    { code: '654321' }
  );
});

test('fetchDomainVerificationCode returns the code from an HTML body', async () => {
  const result = await fetchDomainVerificationCode({
    serverUrl: 'http://mail.example:2099',
    token: '2088',
    email: 'bee@my.mypjnr.org',
    fetchImpl: async (url) => {
      assert.match(url, /mail=bee%40my\.mypjnr\.org/);
      return {
        status: 200,
        text: async () => '<div class="code">284851</div>'
      };
    }
  });
  assert.deepEqual(result, { code: '284851' });
});
