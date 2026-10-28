import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveConfigDir,
  hasIgnoredConfigDirEntry,
  normalizeEnvEntries,
  otherEntries,
  withConfigDir,
} from '../../src/integration/envVars';

test('normalizes array and object forms like the official extension', () => {
  assert.deepEqual(normalizeEnvEntries([{ name: 'A', value: '1' }, { name: 'B', value: null }, { bad: true }, null]), [
    { name: 'A', value: '1' },
    { name: 'B', value: '' },
  ]);
  assert.deepEqual(normalizeEnvEntries({ A: 1, B: undefined }), [
    { name: 'A', value: '1' },
    { name: 'B', value: '' },
  ]);
  assert.deepEqual(normalizeEnvEntries(undefined), []);
  assert.deepEqual(normalizeEnvEntries('nonsense'), []);
});

test('effective CLAUDE_CONFIG_DIR: last absolute entry wins, relative values are ignored', () => {
  const raw = [
    { name: 'CLAUDE_CONFIG_DIR', value: '/a' },
    { name: 'CLAUDE_CONFIG_DIR', value: 'relative' },
    { name: 'CLAUDE_CONFIG_DIR', value: '/b' },
    { name: 'CLAUDE_CONFIG_DIR', value: '~/c' },
  ];
  assert.equal(effectiveConfigDir(raw, 'darwin'), '/b');
  assert.equal(effectiveConfigDir([{ name: 'CLAUDE_CONFIG_DIR', value: 'rel' }], 'darwin'), undefined);
  assert.equal(effectiveConfigDir([], 'darwin'), undefined);
  assert.equal(hasIgnoredConfigDirEntry(raw, 'darwin'), true);
});

test('name matching is case-sensitive except on Windows', () => {
  assert.equal(effectiveConfigDir([{ name: 'claude_config_dir', value: '/x' }], 'darwin'), undefined);
  assert.equal(effectiveConfigDir([{ name: 'claude_config_dir', value: 'C:\\x' }], 'win32'), 'C:\\x');
});

test('withConfigDir keeps other entries and the array shape', () => {
  const raw = [
    { name: 'FOO', value: 'bar' },
    { name: 'CLAUDE_CONFIG_DIR', value: '/old' },
  ];
  assert.deepEqual(withConfigDir(raw, '/new', 'darwin'), [
    { name: 'FOO', value: 'bar' },
    { name: 'CLAUDE_CONFIG_DIR', value: '/new' },
  ]);
  assert.deepEqual(withConfigDir(raw, undefined, 'darwin'), [{ name: 'FOO', value: 'bar' }]);
  assert.deepEqual(otherEntries(raw, 'darwin'), [{ name: 'FOO', value: 'bar' }]);
});

test('withConfigDir keeps the object shape', () => {
  assert.deepEqual(withConfigDir({ FOO: 'bar', CLAUDE_CONFIG_DIR: '/old' }, '/new', 'darwin'), {
    FOO: 'bar',
    CLAUDE_CONFIG_DIR: '/new',
  });
  assert.deepEqual(withConfigDir({ FOO: 'bar', CLAUDE_CONFIG_DIR: '/old' }, undefined, 'darwin'), { FOO: 'bar' });
});

test('withConfigDir handles a missing setting', () => {
  assert.deepEqual(withConfigDir(undefined, '/p', 'darwin'), [{ name: 'CLAUDE_CONFIG_DIR', value: '/p' }]);
  assert.deepEqual(withConfigDir(undefined, undefined, 'darwin'), []);
});

test('round trip: selecting the default account removes the override entirely', () => {
  const selected = withConfigDir([], '/profiles/acct-1', 'darwin');
  assert.equal(effectiveConfigDir(selected, 'darwin'), '/profiles/acct-1');
  const back = withConfigDir(selected, undefined, 'darwin');
  assert.equal(effectiveConfigDir(back, 'darwin'), undefined);
});
