import { sanitise, isRateLimited } from '../services/sanitise.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('sanitise()', () => {
  test('strips angle brackets', () => {
    const r = sanitise('<script>xss</script>');
    assert.ok(!r.includes('<script>'));
  });
  test('trims whitespace', () => {
    assert.equal(sanitise('  hello  '), 'hello');
  });
  test('caps at 500 chars', () => {
    assert.equal(sanitise('a'.repeat(600)).length, 500);
  });
  test('returns empty for null', () => {
    assert.equal(sanitise(null), '');
  });
  test('passes clean text', () => {
    assert.equal(sanitise('Order shawarma'), 'Order shawarma');
  });
});

describe('isRateLimited()', () => {
  test('allows messages under limit', () => {
    const uid = 'u_' + Date.now();
    for (let i = 0; i < 5; i++) assert.equal(isRateLimited(uid, 10), false);
  });
  test('blocks after limit', () => {
    const uid = 'v_' + Date.now();
    for (let i = 0; i < 5; i++) isRateLimited(uid, 5);
    assert.equal(isRateLimited(uid, 5), true);
  });
  test('users are independent', () => {
    const a = 'a_' + Date.now(); const b = 'b_' + Date.now();
    for (let i = 0; i < 5; i++) isRateLimited(a, 5);
    assert.equal(isRateLimited(b, 5), false);
  });
});
         
