import type { ClaudeIdentity } from '../types/account';
import type { AuthStatus } from '../integration/CLIIntegration';

/** Pure helpers for Claude identities (what `claude auth status` reports). */

export function identityFromStatus(status: AuthStatus): ClaudeIdentity {
  return {
    email: status.email,
    orgId: status.orgId,
    orgName: status.orgName,
    subscriptionType: status.subscriptionType,
    authMethod: status.authMethod,
    apiProvider: status.apiProvider,
  };
}

/** Same Claude account: same email (case-insensitive) in the same organization. */
export function sameClaudeAccount(a: ClaudeIdentity | undefined, b: ClaudeIdentity | undefined): boolean {
  return !!a?.email && !!b?.email && a.email.toLowerCase() === b.email.toLowerCase() && (a.orgId ?? '') === (b.orgId ?? '');
}

/** "Max plan", "Pro plan", "API / Console", ... or undefined when not known. */
export function describePlan(identity: ClaudeIdentity | undefined): string | undefined {
  if (!identity) {
    return undefined;
  }
  const sub = identity.subscriptionType?.toLowerCase();
  const plans: Record<string, string> = {
    max: 'Max plan',
    pro: 'Pro plan',
    team: 'Team plan',
    enterprise: 'Enterprise plan',
    free: 'Free plan',
  };
  if (sub && plans[sub]) {
    return plans[sub];
  }
  if (identity.authMethod && identity.authMethod !== 'claude.ai' && identity.authMethod !== 'none') {
    return identity.apiProvider && identity.apiProvider !== 'firstParty'
      ? `Cloud provider (${identity.apiProvider})`
      : 'API / Console';
  }
  return sub ? `${sub[0].toUpperCase()}${sub.slice(1)} plan` : undefined;
}
