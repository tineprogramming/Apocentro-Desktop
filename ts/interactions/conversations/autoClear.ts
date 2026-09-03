import { SettingsKey } from '../../data/settings-key';
import { ConvoHub } from '../../session/conversations';
import { DURATION } from '../../session/constants';
import { Storage } from '../../util/storage';
import { canClearRemotely, cleanConversation, type ClearScope } from './messageCleaner';

export type AutoClearUnit = 'hours' | 'days';

export interface AutoClearConfig {
  scope: ClearScope;
  amount: number;
  unit: AutoClearUnit;
}

/**
 * What a single conversation is configured to do.
 *
 * `useGlobal` (the default, stored as no key at all) follows the global policy;
 * `off` is an explicit opt-out that also blocks the global policy for that
 * conversation, which is why it needs to be distinct from "not configured".
 */
export type AutoClearSetting =
  | { kind: 'useGlobal' }
  | { kind: 'off' }
  | { kind: 'on'; config: AutoClearConfig };

const OFF_VALUE = 'off';
const CONVERSATION_KEY_PREFIX = 'autoClearConversation_';

function conversationKey(conversationId: string) {
  return `${CONVERSATION_KEY_PREFIX}${conversationId}`;
}

function serializeConfig({ scope, amount, unit }: AutoClearConfig) {
  return `${scope}|${amount}|${unit}`;
}

function parseConfig(value: unknown): AutoClearConfig | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [scope, amountStr, unit] = value.split('|');
  const amount = Number(amountStr);

  const scopeValid = scope === 'device_only' || scope === 'others_only' || scope === 'both';
  const unitValid = unit === 'hours' || unit === 'days';
  if (!scopeValid || !unitValid || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return { scope, amount, unit };
}

export function getGlobalAutoClear(): AutoClearConfig | null {
  return parseConfig(Storage.get(SettingsKey.autoClearGlobal));
}

export async function setGlobalAutoClear(config: AutoClearConfig | null) {
  if (!config) {
    await Storage.remove(SettingsKey.autoClearGlobal);
    return;
  }
  await Storage.put(SettingsKey.autoClearGlobal, serializeConfig(config));
}

export function getConversationAutoClear(conversationId: string): AutoClearSetting {
  const raw = Storage.get(conversationKey(conversationId));
  if (raw === undefined || raw === null) {
    return { kind: 'useGlobal' };
  }
  if (raw === OFF_VALUE) {
    return { kind: 'off' };
  }
  const config = parseConfig(raw);
  return config ? { kind: 'on', config } : { kind: 'useGlobal' };
}

export async function setConversationAutoClear(conversationId: string, setting: AutoClearSetting) {
  const key = conversationKey(conversationId);
  switch (setting.kind) {
    case 'useGlobal':
      await Storage.remove(key);
      break;
    case 'off':
      await Storage.put(key, OFF_VALUE);
      break;
    case 'on':
      await Storage.put(key, serializeConfig(setting.config));
      break;
    default:
  }
}

/**
 * The policy that actually applies to a conversation: its own if it has one, the
 * global one if it defers, and none at all if it opted out.
 */
export function effectiveAutoClear(conversationId: string): AutoClearConfig | null {
  const setting = getConversationAutoClear(conversationId);
  switch (setting.kind) {
    case 'on':
      return setting.config;
    case 'off':
      return null;
    default:
      return getGlobalAutoClear();
  }
}

export function retentionCutoffMs({ amount, unit }: AutoClearConfig, now = Date.now()): number {
  const perUnit = unit === 'days' ? DURATION.DAYS : DURATION.HOURS;
  return now - amount * perUnit;
}

export function autoClearSummary(config: AutoClearConfig | null): string {
  if (!config) {
    return 'Off';
  }
  const { amount, unit, scope } = config;
  const unitLabel = amount === 1 ? unit.replace(/s$/, '') : unit;
  const scopeLabel =
    scope === 'device_only'
      ? 'this device'
      : scope === 'others_only'
        ? "other people's devices"
        : 'both sides';

  return `Older than ${amount} ${unitLabel} · ${scopeLabel}`;
}

/**
 * Runs the retention policy over every conversation it applies to.
 *
 * The GLOBAL policy is deliberately restricted to the conversations where a
 * per-conversation policy can also be configured -- 1:1 chats and groups we
 * administer -- so switching it on never silently starts wiping communities the
 * user never opted in for. A conversation carrying its own explicit policy is
 * always swept, whatever it is. (Matches Android's MessageCleaner.runAutoClear.)
 *
 * A remote scope additionally needs a conversation that can actually reach the
 * other side, so a "both" policy never quietly degrades into a local-only wipe.
 * Note-to-Self is skipped entirely, and a conversation that throws is logged and
 * stepped over -- one bad thread must not stop the sweep.
 *
 * Returns how many conversations were swept.
 */
export async function runAutoClearSweep(): Promise<number> {
  const conversations = ConvoHub.use()
    .getConversations()
    .filter(convo => !convo.isMe());

  let swept = 0;

  for (const convo of conversations) {
    const config = effectiveAutoClear(convo.id);
    if (!config) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const remotePossible = await canClearRemotely(convo.id);

      const hasOwnPolicy = getConversationAutoClear(convo.id).kind === 'on';
      if (!hasOwnPolicy && !remotePossible) {
        // the global policy only reaches 1:1s and groups we administer
        continue;
      }

      if (config.scope !== 'device_only' && !remotePossible) {
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const cleared = await cleanConversation({
        conversationId: convo.id,
        scope: config.scope,
        beforeTimestampMs: retentionCutoffMs(config),
      });
      if (cleared) {
        swept++;
      }
    } catch (error) {
      window.log.warn(`runAutoClearSweep: skipping ${convo.id}`, error);
    }
  }

  if (swept) {
    window.log.info(`runAutoClearSweep: swept ${swept} conversation(s)`);
  }

  return swept;
}
