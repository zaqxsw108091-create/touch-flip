import type { GameConfig } from '../config';
import type {
  CardOwner,
  GameEvent,
  MatchOptions,
  Phase,
  PlayerId,
  RoundResult,
  Snapshot,
  TapEvent,
  TapResult,
} from './types';

/**
 * 게임 규칙의 유일한 소유자.
 *
 * 절대 규칙:
 * - DOM 에 의존하지 않는다. document / window / performance 참조 금지.
 * - 시간을 스스로 읽지 않는다. 모든 시각은 인자로 주입받는다.
 *   (event.timeStamp 와 performance.now() 는 같은 time origin 이므로
 *    탭 판정 시각과 라운드 타이머가 같은 축 위에 놓인다.)
 * - 입력은 InputGovernor 를 통과한 TapEvent 만 받는다.
 */
export class GameState {
  private readonly cfg: GameConfig;
  /** 시작 화면에서 고른 라운드 길이. 없으면 config 기본값 */
  private readonly roundDuration: number;

  private _phase: Phase = 'idle';
  private _board: CardOwner[];
  private _round = 1;
  private _roundWins: Record<PlayerId, number> = { 1: 0, 2: 0 };
  private _ready: Record<PlayerId, boolean> = { 1: false, 2: false };
  private _fouls: Record<PlayerId, number> = { 1: 0, 2: 0 };
  private _penaltyUntil: Record<PlayerId, number> = { 1: 0, 2: 0 };

  private _countdownEndsAt = 0;
  private _roundStartAt = 0;
  private _roundEndsAt = 0;

  private _lastRound: RoundResult | null = null;
  private _matchWinner: PlayerId | null = null;
  private _revision = 0;

  private readonly listeners = new Set<(event: GameEvent) => void>();

  constructor(cfg: GameConfig, options: Partial<Pick<MatchOptions, 'roundDurationMs'>> = {}) {
    this.cfg = cfg;
    this.roundDuration = options.roundDurationMs ?? cfg.match.ROUND_DURATION_MS;
    this._board = new Array<CardOwner>(cfg.board.CARD_COUNT).fill(0);
  }

  // ---------------------------------------------------------------- 읽기

  get phase(): Phase {
    return this._phase;
  }

  get board(): readonly CardOwner[] {
    return this._board;
  }

  get round(): number {
    return this._round;
  }

  get roundWins(): Record<PlayerId, number> {
    return { ...this._roundWins };
  }

  get orientation(): 0 | 180 {
    // 홀수 라운드 0도, 짝수 라운드 180도
    return this._round % 2 === 1 ? 0 : 180;
  }

  get matchWinner(): PlayerId | null {
    return this._matchWinner;
  }

  get roundDurationMs(): number {
    return this.roundDuration;
  }

  cardCount(player: PlayerId): number {
    let n = 0;
    for (const owner of this._board) if (owner === player) n += 1;
    return n;
  }

  penaltyUntil(player: PlayerId): number {
    return this._penaltyUntil[player];
  }

  remainingMs(now: number): number {
    if (this._phase === 'playing') return Math.max(0, this._roundEndsAt - now);
    if (this._phase === 'countdown') return Math.max(0, this._countdownEndsAt - now);
    if (this._phase === 'idle') return this.roundDuration;
    return 0;
  }

  snapshot(now: number): Snapshot {
    const remainingMs = this.remainingMs(now);
    return {
      phase: this._phase,
      board: this._board,
      round: this._round,
      maxRounds: this.cfg.match.MAX_ROUNDS,
      orientation: this.orientation,
      counts: { 1: this.cardCount(1), 2: this.cardCount(2) },
      roundWins: { ...this._roundWins },
      ready: { ...this._ready },
      fouls: { ...this._fouls },
      penaltyUntil: { ...this._penaltyUntil },
      roundDurationMs: this.roundDuration,
      remainingMs,
      countdownValue: this._phase === 'countdown' ? Math.max(1, Math.ceil(remainingMs / 1000)) : 0,
      lastRound: this._lastRound,
      matchWinner: this._matchWinner,
      revision: this._revision,
    };
  }

  // ---------------------------------------------------------------- 쓰기

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 준비 버튼 홀드 상태 변경.
   * 양쪽이 동시에 누르고 있어야 카운트다운이 시작되고, 도중에 하나라도 놓으면 취소된다.
   */
  setReady(player: PlayerId, held: boolean, now: number): void {
    if (this._ready[player] === held) return;
    this._ready[player] = held;
    this.emit({ type: 'ready', playerId: player, held });

    if (!held) {
      if (this._phase === 'countdown') this.abortCountdown();
      this.bump();
      return;
    }

    if (this._ready[1] && this._ready[2]) {
      switch (this._phase) {
        case 'idle':
          this.beginCountdown(now);
          break;
        case 'roundEnd':
          // 무승부 라운드는 승수를 주지 않았으므로 같은 라운드 번호로 재경기한다
          if (this._lastRound?.winner != null) this._round += 1;
          this.beginCountdown(now);
          break;
        case 'matchEnd':
          this.resetMatch(now);
          this._ready = { 1: true, 2: true };
          this.beginCountdown(now);
          break;
        default:
          break;
      }
    }
    this.bump();
  }

  /**
   * 유효 탭 처리. InputGovernor 를 통과한 이벤트만 들어온다.
   *
   * 카운트다운 중의 탭은 거부하고 부정 출발로 기록한다.
   * 라운드 종료 시각 이후의 timestamp 는 tick 이 아직 안 돌았더라도 거부한다.
   * (rAF 주기에 따라 판정이 달라지면 주사율 높은 기기가 유리해진다)
   */
  applyTap(tap: TapEvent): TapResult {
    const { cardIndex, playerId, timestamp } = tap;
    const previousOwner = this._board[cardIndex];

    if (previousOwner === undefined) {
      return {
        accepted: false,
        cardIndex,
        playerId,
        owner: 0,
        previousOwner: 0,
        reason: 'out-of-range',
      };
    }

    if (this._phase === 'countdown') {
      this._fouls[playerId] += 1;
      this.emit({ type: 'foul', playerId, timestamp });
      this.bump();
      return this.reject(tap, previousOwner, 'foul');
    }

    if (this._phase !== 'playing') return this.reject(tap, previousOwner, 'not-playing');
    if (timestamp < this._roundStartAt || timestamp >= this._roundEndsAt) {
      return this.reject(tap, previousOwner, 'not-playing');
    }
    if (timestamp < this._penaltyUntil[playerId]) return this.reject(tap, previousOwner, 'penalty');
    if (previousOwner === playerId) return this.reject(tap, previousOwner, 'already-owned');

    // 상태는 즉시 반영된다. 애니메이션은 렌더러가 알아서 하며 여기를 블로킹하지 않는다.
    this._board[cardIndex] = playerId;
    this.emit({ type: 'flip', cardIndex, owner: playerId, previousOwner, timestamp });
    this.bump();

    return { accepted: true, cardIndex, playerId, owner: playerId, previousOwner };
  }

  /** 페이즈 전이를 구동한다. 매 프레임 호출해도 되고, 테스트에서 임의 시각으로 호출해도 된다. */
  tick(now: number): void {
    if (this._phase === 'countdown' && now >= this._countdownEndsAt) {
      this.startRound();
      return;
    }
    if (this._phase === 'playing' && now >= this._roundEndsAt) {
      this.endRound();
    }
  }

  /** 매치 전체 초기화 */
  resetMatch(_now: number): void {
    const previous = this._phase;
    this._phase = 'idle';
    this._board = new Array<CardOwner>(this.cfg.board.CARD_COUNT).fill(0);
    this._round = 1;
    this._roundWins = { 1: 0, 2: 0 };
    this._ready = { 1: false, 2: false };
    this._fouls = { 1: 0, 2: 0 };
    this._penaltyUntil = { 1: 0, 2: 0 };
    this._countdownEndsAt = 0;
    this._roundStartAt = 0;
    this._roundEndsAt = 0;
    this._lastRound = null;
    this._matchWinner = null;
    if (previous !== 'idle') this.emit({ type: 'phase', phase: 'idle', previous });
    this.bump();
  }

  // ---------------------------------------------------------------- 내부

  private beginCountdown(now: number): void {
    const previous = this._phase;
    this._board = new Array<CardOwner>(this.cfg.board.CARD_COUNT).fill(0);
    this._fouls = { 1: 0, 2: 0 };
    this._penaltyUntil = { 1: 0, 2: 0 };
    this._countdownEndsAt = now + this.cfg.match.COUNTDOWN_MS;
    this._phase = 'countdown';
    this.emit({ type: 'phase', phase: 'countdown', previous });
  }

  private abortCountdown(): void {
    const previous = this._phase;
    this._phase = 'idle';
    this._countdownEndsAt = 0;
    this._fouls = { 1: 0, 2: 0 };
    this.emit({ type: 'phase', phase: 'idle', previous });
  }

  private startRound(): void {
    const previous = this._phase;
    // now 가 아니라 예정된 카운트다운 종료 시각을 기준으로 삼는다.
    // rAF 호출이 늦은 기기에서 라운드가 길어지는 것을 막는다.
    this._roundStartAt = this._countdownEndsAt;
    this._roundEndsAt = this._roundStartAt + this.roundDuration;
    this._phase = 'playing';

    const penalty = this.cfg.match.FALSE_START_PENALTY_MS;
    for (const player of [1, 2] as PlayerId[]) {
      const fouls = this._fouls[player];
      if (fouls <= 0) continue;
      const amount = this.cfg.match.STACK_FALSE_START_PENALTY ? penalty * fouls : penalty;
      // 페널티는 라운드 시작 시점부터 적용된다. 카운트다운 중에 정지시켜봐야 의미가 없다.
      this._penaltyUntil[player] = this._roundStartAt + amount;
    }

    this.emit({ type: 'phase', phase: 'playing', previous });
    this.bump();
  }

  private endRound(): void {
    const previous = this._phase;
    const counts: Record<PlayerId, number> = { 1: this.cardCount(1), 2: this.cardCount(2) };
    const winner: PlayerId | null = counts[1] === counts[2] ? null : counts[1] > counts[2] ? 1 : 2;

    const result: RoundResult = { round: this._round, winner, counts };
    this._lastRound = result;
    this._ready = { 1: false, 2: false };

    if (winner != null) this._roundWins[winner] += 1;

    if (winner != null && this._roundWins[winner] >= this.cfg.match.ROUNDS_TO_WIN) {
      this._matchWinner = winner;
      this._phase = 'matchEnd';
      this.emit({ type: 'roundEnd', result });
      this.emit({ type: 'phase', phase: 'matchEnd', previous });
      this.emit({ type: 'matchEnd', winner });
    } else {
      this._phase = 'roundEnd';
      this.emit({ type: 'roundEnd', result });
      this.emit({ type: 'phase', phase: 'roundEnd', previous });
    }
    this.bump();
  }

  private reject(tap: TapEvent, previousOwner: CardOwner, reason: TapResult['reason']): TapResult {
    return {
      accepted: false,
      cardIndex: tap.cardIndex,
      playerId: tap.playerId,
      owner: previousOwner,
      previousOwner,
      ...(reason ? { reason } : {}),
    };
  }

  private emit(event: GameEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private bump(): void {
    this._revision += 1;
  }
}
