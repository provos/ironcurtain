/** Shared limits for statistics queries at transport and persistence boundaries. */
export const STATISTICS_BUCKET_SIZES_MS = [60_000, 300_000, 900_000, 3_600_000, 86_400_000] as const;

export const MAX_STATISTICS_FILTER_VALUES = 20;
export const STATISTICS_IDENTIFIER_MAX_LENGTH = 256;
export const STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH = 128;

export const STATISTICS_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
export const STATISTICS_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()+&-]*$/;
