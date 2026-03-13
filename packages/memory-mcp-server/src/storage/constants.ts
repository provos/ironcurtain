/** Very high similarity — treat as duplicate without LLM (distance < 0.05 = cosine > 0.95).
 *  Tighter threshold needed for BGE-base which produces denser clusters than MiniLM. */
export const EXACT_DEDUP_DISTANCE = 0.05;
