import type { GameConfig, NpcTier } from '../config';
import type { PlayerId, Snapshot } from './types';

export type NpcAction =
  | { kind: 'ready'; held: boolean }
  | { kind: 'tap'; cardIndex: number; timestamp: number };

/**
 * 상대가 없을 때 상대 역할을 하는 NPC.
 *
 * 공정성 관련 규칙:
 * - DOM 과 시계에 의존하지 않는다. 스냅샷과 now 만 받아 행동 목록을 돌려준다.
 * - 탭의 timestamp 는 프레임 시각(now)이 아니라 **예약된 탭 시각**이다.
 *   rAF 가 늦게 돌아도 NPC 의 탭 시각이 밀리지 않으므로, 사람 쪽 규칙(event.timeStamp 사용)과
 *   같은 기준에 놓인다.
 * - 여기서 나온 탭은 InputGovernor.submitTap 을 거쳐 쿨다운·락아웃을 똑같이 적용받는다.
 *   NPC 가 아무리 강해도 사람이 물리적으로 낼 수 있는 상한을 넘지 못한다.
 * - NPC 는 부정 출발을 하지 않는다.
 */
export class NpcPlayer {
  readonly playerId: PlayerId;
  readonly tier: NpcTier;

  private readonly cfg: GameConfig;
  private readonly rng: () => number;
  private readonly human: PlayerId;

  /** 다음 탭 예약 시각. null = 아직 라운드에 들어가지 않음 */
  private nextTapAt: number | null = null;
  /** 준비 버튼을 누를 예정 시각. null = 예약 없음 */
  private readyAt: number | null = null;

  constructor(cfg: GameConfig, tier: NpcTier, playerId: PlayerId = 2, rng: () => number = Math.random) {
    this.cfg = cfg;
    this.tier = tier;
    this.playerId = playerId;
    this.human = playerId === 1 ? 2 : 1;
    this.rng = rng;
  }

  /** 매 프레임 호출. 지금 시점에 실행해야 할 행동을 돌려준다 (없으면 빈 배열). */
  update(snapshot: Snapshot, now: number): NpcAction[] {
    switch (snapshot.phase) {
      case 'idle':
      case 'roundEnd':
      case 'matchEnd':
        this.nextTapAt = null;
        return this.updateReady(snapshot, now);
      case 'countdown':
        // 라운드 시작(카운트다운 종료) 직후 반응 지연을 두고 첫 탭을 예약한다
        this.readyAt = null;
        if (this.nextTapAt === null) {
          this.nextTapAt = now + snapshot.remainingMs + this.between(this.cfg.npc.FIRST_TAP_DELAY_MS);
        }
        return [];
      case 'playing':
        return this.updatePlaying(snapshot, now);
      default:
        return [];
    }
  }

  reset(): void {
    this.nextTapAt = null;
    this.readyAt = null;
  }

  // ------------------------------------------------------------ 내부

  private updateReady(snapshot: Snapshot, now: number): NpcAction[] {
    const humanReady = snapshot.ready[this.human];
    const npcReady = snapshot.ready[this.playerId];

    if (!humanReady) {
      this.readyAt = null;
      // 사람이 손을 뗐으면 NPC 도 뗀다. 그래야 다음에 사람이 다시 누를 때 새로 카운트다운이 돈다
      return npcReady ? [{ kind: 'ready', held: false }] : [];
    }
    if (npcReady) return [];

    if (this.readyAt === null) {
      this.readyAt = now + this.between(this.cfg.npc.READY_DELAY_MS);
      return [];
    }
    if (now >= this.readyAt) {
      this.readyAt = null;
      return [{ kind: 'ready', held: true }];
    }
    return [];
  }

  private updatePlaying(snapshot: Snapshot, now: number): NpcAction[] {
    if (this.nextTapAt === null) {
      this.nextTapAt = now + this.between(this.cfg.npc.FIRST_TAP_DELAY_MS);
    }

    // 백그라운드에서 돌아온 경우 등 예약이 크게 뒤처졌으면 밀린 탭을 버린다
    if (now - this.nextTapAt > this.cfg.npc.MAX_BACKLOG_MS) {
      this.nextTapAt = now;
    }

    const actions: NpcAction[] = [];
    const roundEndsAt = now + snapshot.remainingMs;
    // 같은 스냅샷을 보고 여러 탭을 만들면 같은 카드를 고를 수 있다.
    // 프레임당 한 번만 탭하고 나머지는 다음 프레임으로 넘긴다 (예약 시각은 그대로 유지).
    if (this.nextTapAt <= now && this.nextTapAt < roundEndsAt) {
      const cardIndex = this.chooseCard(snapshot);
      if (cardIndex !== null) {
        actions.push({ kind: 'tap', cardIndex, timestamp: this.nextTapAt });
      }
      this.nextTapAt += this.interval();
    }
    return actions;
  }

  /** 다음 탭까지의 간격. 쿨다운보다 짧을 수 없다 */
  private interval(): number {
    const base = 1000 / this.tier.tapsPerSec;
    const wobble = 1 + this.tier.jitter * (this.rng() * 2 - 1);
    return Math.max(this.cfg.input.PLAYER_COOLDOWN_MS, base * wobble);
  }

  /**
   * 누를 카드 선택.
   * accuracy 확률로 "의미 있는" 카드(중립 또는 상대 카드)를 고르고,
   * 그 안에서 stealBias 확률로 상대 카드를 우선한다. 나머지는 아무 카드나 눌러 헛손질한다.
   */
  private chooseCard(snapshot: Snapshot): number | null {
    const neutral: number[] = [];
    const enemy: number[] = [];
    for (let i = 0; i < snapshot.board.length; i += 1) {
      const owner = snapshot.board[i];
      if (owner === 0) neutral.push(i);
      else if (owner === this.human) enemy.push(i);
    }

    if (this.rng() < this.tier.accuracy) {
      const preferSteal = enemy.length > 0 && (neutral.length === 0 || this.rng() < this.tier.stealBias);
      const pool = preferSteal ? enemy : neutral.length > 0 ? neutral : enemy;
      if (pool.length === 0) return null; // 전부 내 카드 — 누를 이유가 없다
      return pool[Math.floor(this.rng() * pool.length)] ?? null;
    }

    // 헛손질: 아무 카드나. 자기 카드를 누르면 쿨다운만 소모하고 아무 일도 없다
    return Math.floor(this.rng() * snapshot.board.length);
  }

  private between([min, max]: [number, number]): number {
    return min + (max - min) * this.rng();
  }
}
