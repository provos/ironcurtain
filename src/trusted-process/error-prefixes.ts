/**
 * Shared string prefixes used to tag error responses from the tool-call
 * pipeline. Producers (tool-call-pipeline, call-circuit-breaker) prepend
 * these to error text; the coordinator matches against them to classify
 * the response status.
 */

export const ERROR_PREFIX_DENIED = 'DENIED:';
export const ERROR_PREFIX_ESCALATION_REQUIRED = 'ESCALATION REQUIRED:';
export const ERROR_PREFIX_ESCALATION_DENIED = 'ESCALATION DENIED:';
export const ERROR_PREFIX_CIRCUIT_BREAKER = 'CIRCUIT BREAKER:';
export const ERROR_PREFIX_UNKNOWN_ARGS = 'Unknown argument(s):';
export const ERROR_PREFIX_MISSING_ANNOTATION = 'Missing annotation for tool:';
