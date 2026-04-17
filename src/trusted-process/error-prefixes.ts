/**
 * Shared error-message prefixes used by the pipeline to tag error
 * responses with a recognizable category. Consumers (logs, UI, user
 * messages) can pattern-match on these to identify the error category
 * without relying on internal decision fields.
 *
 * The coordinator itself classifies tool-call outcomes via the
 * `_policyDecision.status` field stamped on every response, not by
 * matching these prefixes.
 */

export const ERROR_PREFIX_DENIED = 'DENIED:';
export const ERROR_PREFIX_ESCALATION_REQUIRED = 'ESCALATION REQUIRED:';
export const ERROR_PREFIX_ESCALATION_DENIED = 'ESCALATION DENIED:';
export const ERROR_PREFIX_CIRCUIT_BREAKER = 'CIRCUIT BREAKER:';
export const ERROR_PREFIX_UNKNOWN_ARGS = 'Unknown argument(s):';
export const ERROR_PREFIX_MISSING_ANNOTATION = 'Missing annotation for tool:';
