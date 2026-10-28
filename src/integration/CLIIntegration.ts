import { spawn } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../utils/logger';
import { ensurePrivateDir } from '../utils/filesystem';
import type { EnvEntry } from './envVars';
import { parseUsageStream, type UsageReportOutcome } from '../usage/usageParsing';

// Wrapper around the claude CLI. Always spawned with an args array (no shell).
// Output can contain the account email, so it is parsed but not logged.

export interface CliLocation {
  path: string;
  source: 'setting' | 'claude-code-extension' | 'path';
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  configDirectory?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

export type AuthStatusResult =
  | { ok: true; status: AuthStatus }
  | { ok: false; kind: 'no-cli' | 'failed' | 'parse'; error: string };

export type UsageQueryResult = UsageReportOutcome | { kind: 'error'; noCli: boolean; message: string };

export interface CLIIntegrationOptions {
  configuredPath: () => string | undefined;
  bundledCandidates: () => string[];
  extraEnv: () => EnvEntry[];
  probeCwd: string;
  logger: Logger;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

function runProcess(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r: RunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(file, args, {
        env: options.env,
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += d;
      }
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += d;
      }
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr, timedOut, spawnError: error.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) {
      return false;
    }
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseAuthStatus(stdout: string): AuthStatus | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.loggedIn !== 'boolean') {
    return undefined;
  }
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.length <= 512 ? x : undefined);
  return {
    loggedIn: v.loggedIn,
    authMethod: str(v.authMethod),
    apiProvider: str(v.apiProvider),
    configDirectory: str(v.configDirectory),
    email: str(v.email),
    orgId: str(v.orgId),
    orgName: str(v.orgName),
    subscriptionType: str(v.subscriptionType),
  };
}

export class CLIIntegration {
  private cached?: { at: number; location: CliLocation | undefined };

  constructor(private readonly options: CLIIntegrationOptions) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async resolve(): Promise<CliLocation | undefined> {
    if (this.cached && Date.now() - this.cached.at < 60_000) {
      return this.cached.location;
    }
    const location = await this.findCli();
    this.cached = { at: Date.now(), location };
    return location;
  }

  private async findCli(): Promise<CliLocation | undefined> {
    const configured = this.options.configuredPath()?.trim();
    if (configured) {
      if (path.isAbsolute(configured) && (await isExecutableFile(configured))) {
        return { path: configured, source: 'setting' };
      }
      this.options.logger.warn('ccshift.claudePath is set but is not an absolute path to an executable; ignoring it');
    }
    for (const candidate of this.options.bundledCandidates()) {
      if (await isExecutableFile(candidate)) {
        return { path: candidate, source: 'claude-code-extension' };
      }
    }
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const dirs = [
      ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.claude', 'local'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    for (const dir of dirs) {
      const candidate = path.join(dir, exe);
      if (path.isAbsolute(candidate) && (await isExecutableFile(candidate))) {
        return { path: candidate, source: 'path' };
      }
    }
    return undefined;
  }

  /** Same env the Claude Code extension builds. `undefined` = default config. */
  buildEnv(configDir: string | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const { name, value } of this.options.extraEnv()) {
      env[name] = value;
    }
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    if (configDir !== undefined) {
      env.CLAUDE_CONFIG_DIR = configDir;
    } else if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
      env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    } else {
      delete env.CLAUDE_CONFIG_DIR;
    }
    return env;
  }

  async version(): Promise<string | undefined> {
    const cli = await this.resolve();
    if (!cli) {
      return undefined;
    }
    const r = await runProcess(cli.path, ['--version'], { env: this.buildEnv(undefined), timeoutMs: 15_000 });
    const match = /(\d+\.\d+\.\d+)/.exec(r.stdout);
    return match?.[1];
  }

  async authStatus(configDir: string | undefined): Promise<AuthStatusResult> {
    const cli = await this.resolve();
    if (!cli) {
      return { ok: false, kind: 'no-cli', error: 'Claude Code CLI not found' };
    }
    const r = await runProcess(cli.path, ['auth', 'status', '--json'], {
      env: this.buildEnv(configDir),
      timeoutMs: 20_000,
    });
    if (r.spawnError || r.timedOut) {
      return { ok: false, kind: 'failed', error: r.spawnError ?? 'timed out' };
    }
    // `auth status` exits 1 when signed out but still prints JSON.
    const status = parseAuthStatus(r.stdout);
    if (!status) {
      return { ok: false, kind: 'parse', error: `unexpected output from "claude auth status" (exit ${r.code})` };
    }
    return { ok: true, status };
  }

  async logout(configDir: string): Promise<boolean> {
    const cli = await this.resolve();
    if (!cli) {
      return false;
    }
    const r = await runProcess(cli.path, ['auth', 'logout'], { env: this.buildEnv(configDir), timeoutMs: 20_000 });
    return !r.spawnError && !r.timedOut && r.code === 0;
  }

  /**
   * `/usage` is a local command (no model call, no tokens). Hooks and MCP are
   * off and nothing is saved to history.
   */
  async queryUsage(configDir: string | undefined): Promise<UsageQueryResult> {
    const cli = await this.resolve();
    if (!cli) {
      return { kind: 'error', noCli: true, message: 'Claude Code CLI not found' };
    }
    await ensurePrivateDir(this.options.probeCwd);
    const base = ['-p', '/usage', '--output-format', 'stream-json', '--verbose'];
    const extras = ['--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'];
    const env = this.buildEnv(configDir);
    let r = await runProcess(cli.path, [...base, ...extras], { env, cwd: this.options.probeCwd, timeoutMs: 60_000 });
    if (!r.spawnError && !r.timedOut && r.code !== 0 && /unknown option|unrecognized/i.test(r.stderr)) {
      this.options.logger.info('Installed Claude Code does not accept the lightweight usage flags; retrying without them');
      r = await runProcess(cli.path, base, { env, cwd: this.options.probeCwd, timeoutMs: 60_000 });
    }
    if (r.spawnError || r.timedOut) {
      return { kind: 'error', noCli: false, message: r.spawnError ?? 'usage query timed out' };
    }
    const outcome = parseUsageStream(r.stdout, Date.now());
    if (outcome.kind === 'no-report' && r.code !== 0) {
      return { kind: 'error', noCli: false, message: `claude exited with code ${r.code}` };
    }
    return outcome;
  }
}
