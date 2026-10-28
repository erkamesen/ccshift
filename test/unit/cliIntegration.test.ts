import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CLIIntegration, parseAuthStatus } from '../../src/integration/CLIIntegration';
import { silentLogger, tempDir } from './helpers';

// Fake claude binary: logs args/env and prints canned output.
const FAKE = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG.args"
printf '%s' "\${CLAUDE_CONFIG_DIR-<unset>}" > "$FAKE_LOG.dir"
printf '%s' "\${EXTRA_VAR-<unset>}" > "$FAKE_LOG.extra"
case "$1 $2" in
  "auth status")
    if [ "$FAKE_MODE" = garbage ]; then echo "not json"; exit 1; fi
    if [ -f "\${CLAUDE_CONFIG_DIR:-/nonexistent}/signed-in" ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"%s","email":"a@b.c","subscriptionType":"max"}\\n' "$CLAUDE_CONFIG_DIR"
      exit 0
    fi
    printf '{"loggedIn":false,"authMethod":"none","configDirectory":"%s"}\\n' "$CLAUDE_CONFIG_DIR"
    exit 1 ;;
  "--version ")
    echo "2.1.312 (Claude Code)"; exit 0 ;;
esac
if [ "$1" = "-p" ]; then
  if [ "$FAKE_MODE" = oldcli ]; then
    for a in "$@"; do if [ "$a" = "--no-session-persistence" ]; then echo "error: unknown option '--no-session-persistence'" >&2; exit 1; fi; done
  fi
  if [ "$FAKE_MODE" = slow ]; then sleep 5; fi
  echo '{"type":"system","subtype":"init"}'
  echo '{"type":"assistant","message":{},"usage_report":{"rate_limits":{"limits":[{"kind":"session","group":"session","percent":12,"resets_at":"2030-01-01T00:00:00Z","scope":null}]}}}'
  exit 0
fi
exit 2
`;

async function setup(mode = ''): Promise<{ cli: CLIIntegration; dir: string; log: string; profile: string }> {
  const dir = await tempDir();
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, FAKE, { mode: 0o755 });
  const log = path.join(dir, 'log');
  process.env.FAKE_LOG = log;
  process.env.FAKE_MODE = mode;
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile);
  const cli = new CLIIntegration({
    configuredPath: () => bin,
    bundledCandidates: () => [],
    extraEnv: () => [{ name: 'EXTRA_VAR', value: 'from-setting' }],
    probeCwd: path.join(dir, 'probe'),
    logger: silentLogger,
  });
  return { cli, dir, log, profile };
}

test('parseAuthStatus validates the JSON shape', () => {
  assert.equal(parseAuthStatus('garbage'), undefined);
  assert.equal(parseAuthStatus('{"loggedIn":"yes"}'), undefined);
  assert.deepEqual(parseAuthStatus('noise {"loggedIn":false,"authMethod":"none"} trailing'), {
    loggedIn: false,
    authMethod: 'none',
    apiProvider: undefined,
    configDirectory: undefined,
    email: undefined,
    orgId: undefined,
    orgName: undefined,
    subscriptionType: undefined,
  });
});

test('auth status passes CLAUDE_CONFIG_DIR and setting variables, and reads JSON despite exit 1', async () => {
  const { cli, log, profile } = await setup();
  const signedOut = await cli.authStatus(profile);
  assert.equal(signedOut.ok, true);
  assert.equal(signedOut.ok && signedOut.status.loggedIn, false);
  assert.equal(await fs.readFile(`${log}.dir`, 'utf8'), profile);
  assert.equal(await fs.readFile(`${log}.extra`, 'utf8'), 'from-setting');
  assert.deepEqual((await fs.readFile(`${log}.args`, 'utf8')).trim().split('\n'), ['auth', 'status', '--json']);

  await fs.writeFile(path.join(profile, 'signed-in'), '');
  const signedIn = await cli.authStatus(profile);
  assert.equal(signedIn.ok && signedIn.status.loggedIn, true);
  assert.equal(signedIn.ok && signedIn.status.configDirectory, profile);
});

test('default account: CLAUDE_CONFIG_DIR is left as the editor has it', async () => {
  const { cli, log } = await setup();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await cli.authStatus(undefined);
    assert.equal(await fs.readFile(`${log}.dir`, 'utf8'), '<unset>');
  } finally {
    if (saved !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('unexpected output is an error, not "signed out"', async () => {
  const { cli, profile } = await setup('garbage');
  const r = await cli.authStatus(profile);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'parse');
});

test('usage query uses lightweight, side-effect-free flags and parses the report', async () => {
  const { cli, log, profile } = await setup();
  const r = await cli.queryUsage(profile);
  assert.equal(r.kind, 'ok');
  assert.equal(r.kind === 'ok' && r.snapshot.fiveHour?.usedPercent, 12);
  const args = (await fs.readFile(`${log}.args`, 'utf8')).trim().split('\n');
  assert.deepEqual(args.slice(0, 5), ['-p', '/usage', '--output-format', 'stream-json', '--verbose']);
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('{"disableAllHooks":true}'));
});

test('usage query retries without newer flags on an older CLI', async () => {
  const { cli, log, profile } = await setup('oldcli');
  const r = await cli.queryUsage(profile);
  assert.equal(r.kind, 'ok');
  const args = (await fs.readFile(`${log}.args`, 'utf8')).trim().split('\n');
  assert.equal(args.includes('--no-session-persistence'), false);
});

test('missing CLI is reported as such', async () => {
  const cli = new CLIIntegration({
    configuredPath: () => '/definitely/not/here/claude',
    bundledCandidates: () => ['/also/missing'],
    extraEnv: () => [],
    probeCwd: '/tmp',
    logger: silentLogger,
  });
  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent-dir';
  try {
    const loc = await cli.resolve();
    if (loc === undefined) {
      const r = await cli.authStatus('/x');
      assert.equal(!r.ok && r.kind, 'no-cli');
    } else {
      // A real claude exists in a well-known folder on this machine; that is fine.
      assert.notEqual(loc.path, '/definitely/not/here/claude');
    }
  } finally {
    process.env.PATH = savedPath;
  }
});
