import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDir } from "./paths.js";
import { VERSION } from "../version.js";

// Periodic satisfaction pulse ("How's OpenSwap doing?") — Claude Code style.
// Cadence contract (Khaleel, 2026-07-21): ask after a RANDOMIZED 5–10
// successful human commands, never more than once per 48h, one keypress to
// dismiss, permanent opt-out. Machine modes and agents never see it and
// never advance the counter.
const MIN_GAP_MS = 48 * 60 * 60 * 1000;

export interface PulseState {
  successes: number;
  next_ask_at: number; // successes threshold, randomized 5–10 after each ask
  last_asked_at: number | null;
  opted_out: boolean;
}

function statePath(): string {
  return join(dataDir(), "pulse.json");
}

function randomThreshold(): number {
  return 5 + Math.floor(Math.random() * 6); // 5..10
}

export function readPulseState(): PulseState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as PulseState;
    if (typeof parsed.successes === "number" && typeof parsed.next_ask_at === "number") return parsed;
  } catch {
    // fresh state below
  }
  return { successes: 0, next_ask_at: randomThreshold(), last_asked_at: null, opted_out: false };
}

export function writePulseState(state: PulseState): void {
  ensureDir(dataDir());
  const tmp = statePath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(tmp, statePath());
}

// Called after a successful human-TTY command. Returns true when the prompt
// should be shown NOW (caller shows it, then reports the outcome).
export function recordSuccess(now = Date.now()): boolean {
  const state = readPulseState();
  if (state.opted_out) return false;
  state.successes += 1;
  const gapOk = state.last_asked_at === null || now - state.last_asked_at >= MIN_GAP_MS;
  const due = state.successes >= state.next_ask_at && gapOk;
  if (!due) {
    writePulseState(state);
    return false;
  }
  // mark asked immediately so a crash mid-prompt can't cause re-asks
  state.successes = 0;
  state.next_ask_at = randomThreshold();
  state.last_asked_at = now;
  writePulseState(state);
  return true;
}

export function optOut(): void {
  const state = readPulseState();
  state.opted_out = true;
  writePulseState(state);
}

export function pulseMessage(rating: 1 | 2 | 3, comment: string): string {
  const tag = `[pulse ${rating}/3 v${VERSION} ${process.platform}]`;
  return comment.trim() ? `${tag} ${comment.trim()}` : tag;
}
