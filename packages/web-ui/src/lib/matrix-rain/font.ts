/**
 * Font constants for the Matrix rain animation.
 *
 * The wordmark is rendered via an offscreen canvas using a real font (Orbitron),
 * then sampled to produce the locked-cell grid. Rain drop characters still use
 * katakana + digits in the monospace font.
 */

/** The wordmark the engine assembles by default. */
export const WORD = 'IronCurtain';

/** Subtitle rendered below the main wordmark. */
export const SUBTITLE = 'Secure Agent Runtime';

/**
 * Katakana + digits used for both assembly and ambient drop characters.
 * Matches the terminal splash so both surfaces share the same alphabet.
 */
export const RAIN_CHARS = 'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

/** CSS font-family string for the wordmark. Orbitron is loaded via Google Fonts. */
export const WORDMARK_FONT_FAMILY = '"Orbitron", sans-serif';

/** Font weight for the wordmark rendering. */
export const WORDMARK_FONT_WEIGHT = '700';
