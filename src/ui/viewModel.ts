import type { AccountColor, AccountProfile, AuthState } from '../types/account';
import type { UsageRecord, UsageState, UsageWindowKey } from '../types/usage';
import { describePlan } from '../accounts/identity';
import {
  DEFAULT_FRESHNESS,
  USAGE_STATE_LABEL,
  formatPercent,
  severityFor,
  usageState,
  windowView,
  type FreshnessPolicy,
  type Severity,
} from '../usage/usageModel';
import { formatAgo, formatDateTime, formatReset } from '../utils/time';
import { tildify } from '../utils/paths';

// Display strings for one account. Built here so the webview only renders.

export interface WindowDisplay {
  percent?: number;
  percentLabel: string;
  resetLabel: string;
  resetTooltip?: string;
  severity: Severity;
  note?: string;
}

export interface AccountView {
  id: string;
  name: string;
  color: AccountColor;
  kind: 'default' | 'managed';
  configDir: string;
  isActive: boolean;
  isDefault: boolean;
  isWorkspace: boolean;
  plan?: string;
  email?: string;
  authState: AuthState;
  usageState: UsageState;
  usageStateLabel: string;
  fiveHour: WindowDisplay;
  sevenDay: WindowDisplay;
  updatedLabel?: string;
  updatedTooltip?: string;
  sourceLabel?: string;
  errorMessage?: string;
  refreshing: boolean;
}

export interface ViewContext {
  activeId?: string;
  defaultId: string;
  workspaceId?: string;
  record?: UsageRecord;
  refreshing: boolean;
  now: number;
  warningThreshold: number;
  criticalThreshold: number;
  freshness?: FreshnessPolicy;
}

const SOURCE_LABEL = {
  'cli-usage': 'from Claude Code /usage',
  'status-line': 'from a Claude Code CLI session',
} as const;

function windowDisplay(record: UsageRecord | undefined, key: UsageWindowKey, ctx: ViewContext): WindowDisplay {
  const view = windowView(record?.snapshot?.[key], ctx.now);
  if (view.resetSinceObserved) {
    return {
      percent: undefined,
      percentLabel: '—',
      resetLabel: `${formatReset(view.resetsAt, ctx.now)} · refresh for current usage`,
      resetTooltip: view.resetsAt ? formatDateTime(view.resetsAt) : undefined,
      severity: 'normal',
      note: 'reset',
    };
  }
  if (view.percent === undefined) {
    return { percent: undefined, percentLabel: '—', resetLabel: 'No data', severity: 'normal' };
  }
  return {
    percent: view.percent,
    percentLabel: formatPercent(view.percent),
    resetLabel: formatReset(view.resetsAt, ctx.now),
    resetTooltip: view.resetsAt ? formatDateTime(view.resetsAt) : undefined,
    severity: severityFor(view.percent, ctx.warningThreshold, ctx.criticalThreshold),
  };
}

export function buildAccountView(profile: AccountProfile, ctx: ViewContext): AccountView {
  const record = ctx.record;
  const state = usageState(record, profile.authState, ctx.now, ctx.freshness ?? DEFAULT_FRESHNESS);
  const snapshot = record?.snapshot;
  const error = record?.lastError;
  const errorIsNewer = error !== undefined && (!snapshot || error.at > snapshot.observedAt);
  return {
    id: profile.id,
    name: profile.displayName,
    color: profile.color,
    kind: profile.kind,
    configDir: tildify(profile.configDir),
    isActive: profile.id === ctx.activeId,
    isDefault: profile.id === ctx.defaultId,
    isWorkspace: profile.id === ctx.workspaceId,
    plan: describePlan(profile.identity),
    email: profile.identity?.email,
    authState: profile.authState,
    usageState: state,
    usageStateLabel: USAGE_STATE_LABEL[state],
    fiveHour: windowDisplay(record, 'fiveHour', ctx),
    sevenDay: windowDisplay(record, 'sevenDay', ctx),
    updatedLabel: snapshot ? `Updated ${formatAgo(snapshot.observedAt, ctx.now)}` : undefined,
    updatedTooltip: snapshot ? `${formatDateTime(snapshot.observedAt)}, ${SOURCE_LABEL[snapshot.source]}` : undefined,
    sourceLabel: snapshot ? SOURCE_LABEL[snapshot.source] : undefined,
    errorMessage: errorIsNewer ? error.message : undefined,
    refreshing: ctx.refreshing,
  };
}

export function statusBarText(view: AccountView): string {
  const pct = view.fiveHour.percent === undefined ? '—' : view.fiveHour.percentLabel;
  const stale = view.usageState === 'stale' && view.fiveHour.percent !== undefined ? '*' : '';
  return `${view.name} · 5h ${pct}${stale}`;
}
