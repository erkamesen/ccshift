import * as vscode from 'vscode';

/** Lets pure modules log without importing vscode. Don't log secrets or raw CLI output. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class OutputLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  debug(message: string): void {
    this.channel.debug(message);
  }
  info(message: string): void {
    this.channel.info(message);
  }
  warn(message: string): void {
    this.channel.warn(message);
  }
  error(message: string, error?: unknown): void {
    this.channel.error(error === undefined ? message : `${message}: ${describeError(error)}`);
  }
  show(): void {
    this.channel.show(true);
  }
  dispose(): void {
    this.channel.dispose();
  }
}
