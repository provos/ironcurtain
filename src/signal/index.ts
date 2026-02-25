/**
 * Signal transport module public API.
 */

export { SignalBotDaemon } from './signal-bot-daemon.js';
export type { SignalBotDaemonOptions, SignalEnvelope } from './signal-bot-daemon.js';
export { parseSignalEnvelope, isAuthorizedSender, normalizePhoneNumber } from './signal-bot-daemon.js';

export { SignalSessionTransport } from './signal-transport.js';

export { createSignalContainerManager } from './signal-container.js';
export type { SignalContainerConfig, SignalContainerManager } from './signal-container.js';

export { resolveSignalConfig, getSignalDataDir, SIGNAL_DEFAULTS } from './signal-config.js';
export type { SignalConfig, ResolvedSignalConfig } from './signal-config.js';

export { markdownToSignal } from './markdown-to-signal.js';

export {
  formatEscalationBanner,
  formatBudgetMessage,
  formatBudgetSummary,
  splitMessage,
  SIGNAL_MAX_MESSAGE_LENGTH,
} from './format.js';

export { runBot } from './bot-command.js';
export type { BotOptions } from './bot-command.js';

export { runSignalSetup } from './setup-signal.js';
