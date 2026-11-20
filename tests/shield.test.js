import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRules, mergeEntities, expandAliases, buildMap, mask, unmask, suggest } from '../src/shield.js';

const types = (text) => detectRules(text).map((e) => `${e.type}:${e.text}`);

test('finds PAN, Aadhaar, phone and email', () => {
  const found = types('PAN ABCDE1234F, Aadhaar 2345 6789 0123, call 98765 43210, mail priya.k@kavyalog.in');
  assert.deepEqual(found.sort(), [
    'AADHAAR:2345 6789 0123', 'EMAIL:priya.k@kavyalog.in', 'PAN:ABCDE1234F', 'PHONE:98765 43210',
  ]);
});

test('UPI handle followed by a full stop is still caught (found in testing)', () => {
  assert.deepEqual(types('Pay via UPI orbit@okhdfcbank. Thanks'), ['UPI:orbit@okhdfcbank']);
});

test('an email is not mistaken for a UPI handle', () => {
  assert.deepEqual(types('write to a.b@example.com'), ['EMAIL:a.b@example.com']);
});

test('card numbers need a valid Luhn checksum', () => {
  assert.deepEqual(types('card 4111 1111 1111 1111'), ['CARD:4111 1111 1111 1111']);
  assert.deepEqual(types('card 4111 1111 1111 1112'), []); // not a card, and not the first 12 digits of an Aadhaar either
});

test('API keys are caught', () => {
  assert.deepEqual(types('key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'), ['SECRET:AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q']);
});

test('mask then unmask restores the original', () => {
  const raw = 'Email Rohit Sharma at Infosys about ABCDE1234F. Rohit agrees.';
  const map = buildMap(mergeEntities(detectRules(raw), [
    { text: 'Rohit Sharma', type: 'PERSON' }, { text: 'Rohit', type: 'PERSON' }, { text: 'Infosys', type: 'ORG' },
  ]));
  const masked = mask(raw, map);
  assert.ok(!/Rohit|Infosys|ABCDE1234F/.test(masked));
  assert.equal(unmask(masked, map), raw);
});

test('unmask tolerates dropped brackets and keeps PERSON_1 apart from PERSON_10', () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ text: `Person${i}`, type: 'PERSON', src: 'ai' }));
  const map = buildMap(people);
  assert.equal(unmask('[PERSON_1] and PERSON_10 and [PERSON_2]', map), 'Person0 and Person9 and Person1');
});

test('suggest proposes whole names and skips lone sentence starters', () => {
  const raw = 'Draft an email to my manager Rohit Sharma at Infosys. Ask about the Project Nandini bonus of 28 LPA.';
  assert.deepEqual(suggest(raw, []), ['Rohit Sharma', 'Infosys', 'Project Nandini', '28 LPA']);
});

test('a first name on its own is masked when the full name was found', () => {
  const raw = 'Email Rohit Sharma today. Rohit said yes.';
  const ents = expandAliases(raw, mergeEntities(detectRules(raw), [{ text: 'Rohit Sharma', type: 'PERSON' }]));
  const masked = mask(raw, buildMap(ents));
  assert.ok(!/Rohit|Sharma/.test(masked), masked);
});
