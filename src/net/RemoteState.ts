import type { GameEvent, PlayerId, Snapshot } from '../core/types';
import type { ServerSnapshot } from './protocol';

/**
 * 서버가 보내준 상태의 로컬 거울.
 *
 * 규칙은 전혀 없다. 서버 Snapshot 을 클라이언트 Snapshot 모양으로 바꾸고,
 * 다음 메시지가 올 때까지 남은 시간을 수신 시각 기준으로 보간할 뿐이다.
 * 라운드 종료는 오직 서버가 선언한다 — 여기서 remainingMs 가 0 이 돼도 페이즈는 바뀌지 않는다.
 *
 * DOM·네트워크 의존이 없어 그대로 테스트된다.
 */
export class RemoteState {
  private last: ServerSnapshot | null = null;
  private receivedAt = 0;
  private prevBoard: number[] = [];
  private prevFouls: [number, number] = [0, 0];
  private prevPhase: ServerSnapshot['phase'] | null = null;

  constructor(private readonly initialRoundDurationMs: number) {}

  get hasState(): boolean {
    return this.last !== null;
  }

  /**
   * 서버 state 반영. 직전 상태와 비교해 화면 연출용 이벤트(flip/foul/phase)를 돌려준다.
   * 서버가 보낸 revision 이 이전보다 작으면(순서 뒤바뀜) 무시한다.
   */
  apply(snapshot: ServerSnapshot, receivedAt: number): GameEvent[] {
    if (this.last && snapshot.revision < this.last.revision) return [];

    const events: GameEvent[] = [];
    for (let i = 0; i < snapshot.board.length; i += 1) {
      const owner = snapshot.board[i] ?? 0;
      const prev = this.prevBoard[i] ?? 0;
      if (owner !== prev && owner !== 0) {
        events.push({ type: 'flip', cardIndex: i, owner: owner as 0 | PlayerId, previousOwner: prev as 0 | PlayerId, timestamp: receivedAt });
      }
    }
    for (const p of [1, 2] as PlayerId[]) {
      if ((snapshot.fouls[p - 1] ?? 0) > (this.prevFouls[p - 1] ?? 0)) {
        events.push({ type: 'foul', playerId: p, timestamp: receivedAt });
      }
    }
    if (this.prevPhase !== null && this.prevPhase !== snapshot.phase) {
      events.push({ type: 'phase', phase: snapshot.phase, previous: this.prevPhase });
    }

    this.last = snapshot;
    this.receivedAt = receivedAt;
    this.prevBoard = snapshot.board.slice();
    this.prevFouls = [snapshot.fouls[0], snapshot.fouls[1]];
    this.prevPhase = snapshot.phase;
    return events;
  }

  /** 렌더러용 스냅샷. 아직 서버 상태가 없으면 빈 idle 보드 */
  snapshot(now: number): Snapshot {
    const s = this.last;
    if (!s) return emptySnapshot(this.initialRoundDurationMs);

    // 남은 시간은 수신 시각부터 흐른 만큼 빼서 보여준다. 0 이하로는 내려가지 않는다.
    const elapsed = Math.max(0, now - this.receivedAt);
    const remainingMs =
      s.phase === 'playing' || s.phase === 'countdown' ? Math.max(0, s.remainingMs - elapsed) : s.remainingMs;

    return {
      phase: s.phase,
      board: s.board as Snapshot['board'],
      round: s.round,
      maxRounds: s.maxRounds,
      orientation: s.orientation,
      counts: { 1: s.counts[0], 2: s.counts[1] },
      roundWins: { 1: s.roundWins[0], 2: s.roundWins[1] },
      ready: { 1: s.ready[0], 2: s.ready[1] },
      fouls: { 1: s.fouls[0], 2: s.fouls[1] },
      penaltyUntil: { 1: s.penaltyUntil[0], 2: s.penaltyUntil[1] },
      roundDurationMs: s.roundDurationMs,
      remainingMs,
      countdownValue: s.phase === 'countdown' ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0,
      lastRound: s.lastRound
        ? {
            round: s.lastRound.round,
            winner: s.lastRound.winner === null ? null : (s.lastRound.winner as PlayerId),
            counts: { 1: s.lastRound.counts[0], 2: s.lastRound.counts[1] },
          }
        : null,
      matchWinner: s.matchWinner === null ? null : (s.matchWinner as PlayerId),
      revision: s.revision,
    };
  }
}

function emptySnapshot(roundDurationMs: number): Snapshot {
  return {
    phase: 'idle',
    board: new Array<0>(25).fill(0),
    round: 1,
    maxRounds: 3,
    orientation: 0,
    counts: { 1: 0, 2: 0 },
    roundWins: { 1: 0, 2: 0 },
    ready: { 1: false, 2: false },
    fouls: { 1: 0, 2: 0 },
    penaltyUntil: { 1: 0, 2: 0 },
    roundDurationMs,
    remainingMs: roundDurationMs,
    countdownValue: 0,
    lastRound: null,
    matchWinner: null,
    revision: -1,
  };
}
