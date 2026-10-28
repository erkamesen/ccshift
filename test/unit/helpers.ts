import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../../src/utils/logger';

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export async function tempDir(prefix = 'cam-test-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
