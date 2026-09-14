/**
 * 서버 ↔ 클라이언트 메시지 (docs/GAME_SPEC.md 7절).
 * 필드명은 server/src/main/java/touchflip/net/Messages.java 와 같아야 한다.
 */

export type ClientMessage =
  | { type: 'join'; roomCode?: string; token?: string; roundDurationMs?: number }
  | { type: 'ready'; held: boolean }
  | { type: 'tap'; cardIndex: number; tapTime: number }
  | { type: 'ping'; clientTime: number };

/** 서버가 보내는 Snapshot. 2인 값은 [P1, P2] 배열이다 */
export interface ServerSnapshot {
  phase: 'idle' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';
  board: number[];
  round: number;
  maxRounds: number;
  orientation: 0 | 180;
  counts: [number, number];
  roundWins: [number, number];
  ready: [boolean, boolean];
  fouls: [number, number];
  penaltyUntil: [number, number];
  roundDurationMs: number;
  remainingMs: number;
  countdownValue: number;
  lastRound: { round: number; winner: number | null; counts: [number, number] } | null;
  matchWinner: number | null;
  revision: number;
}

export type ServerMessage =
  | { type: 'joined'; playerId: 1 | 2; roomCode: string; token: string; opponentPresent: boolean; roundDurationMs: number }
  | { type: 'opponentJoined' }
  | { type: 'opponentLeft'; graceMs: number }
  | { type: 'opponentBack' }
  | { type: 'state'; serverTime: number; snapshot: ServerSnapshot }
  | { type: 'tapAck'; cardIndex: number; accepted: boolean; reason: string | null }
  | { type: 'pong'; clientTime: number | null; serverTime: number }
  | { type: 'error'; code: string; message: string };

export function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
