import { runTests } from '@vscode/test-electron';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Runs the suite in the installed VS Code + Claude Code extension with temp
// user-data/extensions dirs and a temp CLAUDE_CONFIG_DIR, so ~/.claude is never used.
// Env: VSCODE_EXECUTABLE, CLAUDE_CODE_EXTENSION_DIR, CAM_IT_EXTENSION_PATH.

async function findClaudeCodeExtension(): Promise<string | undefined> {
  if (process.env.CLAUDE_CODE_EXTENSION_DIR) {
    return process.env.CLAUDE_CODE_EXTENSION_DIR;
  }
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('anthropic.claude-code-'));
  const version = (n: string): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(n) ?? []).slice(1).map(Number);
  names.sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < 3; i++) {
      if (x[i] !== y[i]) {
        return (y[i] ?? 0) - (x[i] ?? 0);
      }
    }
    return 0;
  });
  return names[0] ? path.join(dir, names[0]) : undefined;
}

async function main(): Promise<void> {
  // Set when this runs from a terminal inside VS Code; it would start Code as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cam-it-')));
  const extensionsDir = path.join(root, 'extensions');
  const userDataDir = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  const fakeDefaultConfig = path.join(root, 'default-claude-config');
  const managerHome = path.join(root, 'manager-home');
  await Promise.all([extensionsDir, userDataDir, workspace, fakeDefaultConfig].map((d) => fs.mkdir(d, { recursive: true })));

  const claudeExt = await findClaudeCodeExtension();
  if (claudeExt) {
    await fs.symlink(claudeExt, path.join(extensionsDir, path.basename(claudeExt)));
    console.log(`Using Claude Code extension: ${path.basename(claudeExt)}`);
  } else {
    console.log('Claude Code extension not found; extension-specific checks will be skipped.');
  }

  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ??
    (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : undefined);

  try {
    await runTests({
      vscodeExecutablePath,
      // CAM_IT_EXTENSION_PATH: test an installed copy (e.g. unpacked from the VSIX) instead of the source tree.
      extensionDevelopmentPath: process.env.CAM_IT_EXTENSION_PATH ?? path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, './suite/index'),
      launchArgs: [
        workspace,
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        CLAUDE_CONFIG_DIR: fakeDefaultConfig,
        CCSHIFT_HOME: managerHome,
        CAM_IT_EXPECT_CLAUDE_CODE: claudeExt ? '1' : '0',
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('Integration tests failed:', error);
  process.exit(1);
});
