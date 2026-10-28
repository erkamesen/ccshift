/**
 * A profile is a local registration (id, name, color, config dir).
 * The Claude identity is whatever `claude auth status` reports for that dir.
 */

export const DEFAULT_PROFILE_ID = 'default';

export const ACCOUNT_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];

/** From `claude auth status --json`. */
export interface ClaudeIdentity {
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
  authMethod?: string;
  apiProvider?: string;
}

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated' | 'error';

export interface AccountProfile {
  /** Local registration id. Not a Claude account identifier. */
  id: string;
  displayName: string;
  color: AccountColor;
  /** `default` = no CLAUDE_CONFIG_DIR, `managed` = its own config dir. */
  kind: 'default' | 'managed';
  /** Absolute path of the Claude Code configuration directory. */
  configDir: string;
  /** Created by us under profiles/. Only these can be deleted. */
  ownedDir: boolean;
  createdAt: number;
  identity?: ClaudeIdentity;
  authState: AuthState;
  authCheckedAt?: number;
}

export interface AccountMetadata {
  version: 1;
  profiles: AccountProfile[];
  defaultProfileId: string;
  /** Newest first, used by Quick Toggle. */
  recentProfileIds: string[];
}

/** What the official extension is currently configured to use. */
export type ActiveSelection =
  | { kind: 'profile'; profile: AccountProfile }
  /** CLAUDE_CONFIG_DIR points at a directory that is not registered. */
  | { kind: 'unregistered'; configDir: string };
