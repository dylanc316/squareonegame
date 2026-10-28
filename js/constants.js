// Game rules shared by the client. Server-side rules live in supabase/schema.sql
// and must match (checkpoint formula, prices, limits).

export const TILE = 72;                 // pixels per square along the path
export const STEP_MS = 130;             // hold-to-walk speed (~7.7 squares/sec; server allows 12)
export const ZONE_SIZE = 150;           // art style + biome can change every this many squares
export const COMMENT_MAX_CHARS = 200;
export const COMMENTS_PER_SQUARE = 100;
export const NEARBY_RANGE = 15;         // other players within this many squares are drawn

// Checkpoints at 100 * n^2: 100, 400, 900, 1600, 2500, 3600 ...
export function isCheckpoint(s) {
  if (s < 100 || s % 100 !== 0) return false;
  const n = Math.round(Math.sqrt(s / 100));
  return n * n * 100 === s;
}
export function nextCheckpointAfter(s) {
  let n = Math.floor(Math.sqrt(Math.max(s, 0) / 100)) + 1;
  while (n * n * 100 <= s) n++;
  return n * n * 100;
}

// Fallback shop list (the real prices come from the database)
export const SHOP_ITEMS = [
  { id: 'sunglasses', name: 'Cool Sunglasses', slot: 'face', price: 1000 },
  { id: 'scarf', name: 'Cozy Scarf', slot: 'neck', price: 2000 },
  { id: 'fun_hat', name: 'Fun Hat', slot: 'head', price: 3000 },
];
