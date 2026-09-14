import { describe, expect, it } from 'vitest';
import { CONFIG, type GameConfig, type NpcTier } from '../src/config';
import { GameState } from '../src/core/GameState';
import { NpcPlayer, type NpcAction } from '../src/core/NpcPlayer';
import type { CardOwner, Snapshot } from '../src/core/types';

const cfg = (): GameConfig => structuredClone(CONFIG);

/** 항상 같은 값을 내는 난수. 0.5 면 지터가 0 이 되어 간격이 정확히 1000/tapsPerSec 이 된다 */
const fixed = (v: number) => () => v;

function tier(overrides: Partial<NpcTier> = {}): NpcTier {
  return { id: 9, name: '테스트', tapsPerSec: 4, jitter: 0, accuracy: 1, stealBias: 0, ...overrides };
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    phase: 'playing',
    board: new Array<CardOwner>(25).fill(0),
    round: 1,
    maxRounds: 3,
    orientation: 0,
    counts: { 1: 0, 2: 0 },
    roundWins: { 1: 0, 2: 0 },
    ready: { 1: false, 2: false },
    fouls: { 1: 0, 2: 0 },
    penaltyUntil: { 1: 0, 2: 0 },
    roundDurationMs: 30_000,
    remainingMs: 30_000,
    countdownValue: 0,
    lastRound: null,
    matchWinner: null,
    revision: 0,
    ...overrides,
  };
}

const taps = (actions: NpcAction[]) => actions.filter((a) => a.kind === 'tap');

describe('NpcPlayer — 준비', () => {
  it('사람이 준비를 누르고 있어야 NPC 도 준비한다', () => {
    const config = cfg();
    const npc = new NpcPlayer(config, tier(), 2, fixed(0.5));
    expect(npc.update(snap({ phase: 'idle' }), 1_000)).toEqual([]);

    // 사람이 누름 → 지연 예약
    expect(npc.update(snap({ phase: 'idle', ready: { 1: true, 2: false } }), 1_000)).toEqual([]);
    const [min, max] = config.npc.READY_DELAY_MS;
    const expectedDelay = min + (max - min) * 0.5;
    expect(npc.update(snap({ phase: 'idle', ready: { 1: true, 2: false } }), 1_000 + expectedDelay - 1)).toEqual([]);
    expect(npc.update(snap({ phase: 'idle', ready: { 1: true, 2: false } }), 1_000 + expectedDelay)).toEqual([
      { kind: 'ready', held: true },
    ]);
  });

  it('사람이 손을 떼면 NPC 도 뗀다', () => {
    const npc = new NpcPlayer(cfg(), tier(), 2, fixed(0.5));
    expect(npc.update(snap({ phase: 'idle', ready: { 1: false, 2: true } }), 1_000)).toEqual([
      { kind: 'ready', held: false },
    ]);
  });

  it('NPC 는 카운트다운 중 절대 탭하지 않는다 (부정 출발 없음)', () => {
    const npc = new NpcPlayer(cfg(), tier({ tapsPerSec: 20 }), 2, fixed(0.5));
    for (let t = 0; t < 5_000; t += 16) {
      expect(taps(npc.update(snap({ phase: 'countdown', remainingMs: 3_000 - (t % 3_000) }), t))).toEqual([]);
    }
  });
});

describe('NpcPlayer — 탭 타이밍', () => {
  it('탭 timestamp 는 프레임 시각이 아니라 예약 시각이다', () => {
    const config = cfg();
    const npc = new NpcPlayer(config, tier({ tapsPerSec: 4 }), 2, fixed(0.5));
    const [min, max] = config.npc.FIRST_TAP_DELAY_MS;
    const firstAt = 10_000 + (min + (max - min) * 0.5);

    // 첫 프레임: 예약만
    expect(taps(npc.update(snap(), 10_000))).toEqual([]);
    // 예약 시각을 40ms 지나서 프레임이 들어와도 timestamp 는 예약 시각
    const late = taps(npc.update(snap(), firstAt + 40));
    expect(late).toEqual([{ kind: 'tap', cardIndex: expect.any(Number), timestamp: firstAt }]);
  });

  it('평균 탭 속도가 tapsPerSec 와 일치한다 (지터 0)', () => {
    const config = cfg();
    const npc = new NpcPlayer(config, tier({ tapsPerSec: 4 }), 2, fixed(0.5));
    const stamps: number[] = [];
    for (let t = 0; t <= 10_000; t += 16) {
      for (const a of npc.update(snap({ remainingMs: 30_000 - t }), t)) {
        if (a.kind === 'tap') stamps.push(a.timestamp);
      }
    }
    // 첫 탭 지연을 빼면 250ms 간격
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBeCloseTo(250, 5);
    }
    expect(stamps.length).toBeGreaterThanOrEqual(38);
    expect(stamps.length).toBeLessThanOrEqual(40);
  });

  it('탭 간격은 PLAYER_COOLDOWN_MS 보다 짧아질 수 없다', () => {
    const config = cfg();
    // 초당 100회를 설정해도 쿨다운(50ms) 이 바닥이다
    const npc = new NpcPlayer(config, tier({ tapsPerSec: 100 }), 2, fixed(0.5));
    const stamps: number[] = [];
    for (let t = 0; t <= 2_000; t += 4) {
      for (const a of npc.update(snap({ remainingMs: 30_000 - t }), t)) {
        if (a.kind === 'tap') stamps.push(a.timestamp);
      }
    }
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(config.input.PLAYER_COOLDOWN_MS);
    }
  });

  it('프레임이 오래 멈췄다 돌아오면 밀린 탭을 쏟아내지 않는다', () => {
    const config = cfg();
    const npc = new NpcPlayer(config, tier({ tapsPerSec: 10 }), 2, fixed(0.5));
    npc.update(snap(), 0);
    npc.update(snap(), 1_000); // 첫 탭
    // 5초 정지 후 복귀
    const burst = taps(npc.update(snap({ remainingMs: 24_000 }), 6_000));
    expect(burst.length).toBeLessThanOrEqual(1);
    if (burst[0]) expect(burst[0].timestamp).toBe(6_000);
  });

  it('라운드 종료 시각 이후로 예약된 탭은 내지 않는다', () => {
    const npc = new NpcPlayer(cfg(), tier({ tapsPerSec: 4 }), 2, fixed(0.5));
    npc.update(snap({ remainingMs: 100 }), 0);
    // 다음 예약은 300ms 근처인데 라운드는 100ms 뒤에 끝난다
    expect(taps(npc.update(snap({ remainingMs: 0 }), 1_000))).toEqual([]);
  });
});

describe('NpcPlayer — 카드 선택', () => {
  it('accuracy 1 이면 자기 카드를 절대 누르지 않는다', () => {
    const board = new Array<CardOwner>(25).fill(2);
    board[3] = 0;
    board[7] = 1;
    const npc = new NpcPlayer(cfg(), tier({ accuracy: 1, stealBias: 0 }), 2, fixed(0.5));
    npc.update(snap({ board }), 0);
    const chosen = taps(npc.update(snap({ board }), 2_000));
    expect(chosen).toHaveLength(1);
    expect([3, 7]).toContain(chosen[0]!.cardIndex);
  });

  it('stealBias 1 이면 중립이 있어도 상대 카드를 뺏는다', () => {
    const board = new Array<CardOwner>(25).fill(0);
    board[11] = 1;
    const npc = new NpcPlayer(cfg(), tier({ accuracy: 1, stealBias: 1 }), 2, fixed(0.5));
    npc.update(snap({ board }), 0);
    const chosen = taps(npc.update(snap({ board }), 2_000));
    expect(chosen[0]!.cardIndex).toBe(11);
  });

  it('stealBias 0 이면 중립 카드를 먼저 먹는다', () => {
    const board = new Array<CardOwner>(25).fill(1);
    board[20] = 0;
    const npc = new NpcPlayer(cfg(), tier({ accuracy: 1, stealBias: 0 }), 2, fixed(0.5));
    npc.update(snap({ board }), 0);
    expect(taps(npc.update(snap({ board }), 2_000))[0]!.cardIndex).toBe(20);
  });

  it('accuracy 0 이면 아무 카드나 누른다 (자기 카드도 포함)', () => {
    const board = new Array<CardOwner>(25).fill(2);
    // rng 0.5: 정확도 판정 실패(0.5 < 0 아님) → 25장 중 12번
    const npc = new NpcPlayer(cfg(), tier({ accuracy: 0 }), 2, fixed(0.5));
    npc.update(snap({ board }), 0);
    const chosen = taps(npc.update(snap({ board }), 2_000));
    expect(chosen[0]!.cardIndex).toBe(12);
  });

  it('카드가 전부 자기 것이면 탭을 내지 않는다', () => {
    const board = new Array<CardOwner>(25).fill(2);
    const npc = new NpcPlayer(cfg(), tier({ accuracy: 1 }), 2, fixed(0.5));
    npc.update(snap({ board }), 0);
    expect(taps(npc.update(snap({ board }), 2_000))).toEqual([]);
  });
});

describe('NpcPlayer — GameState 와 통합', () => {
  it('NPC 혼자 라운드를 돌리면 카드를 먹고 라운드가 끝난다', () => {
    const config = cfg();
    const state = new GameState(config, { roundDurationMs: 5_000 });
    const npc = new NpcPlayer(config, tier({ tapsPerSec: 5, accuracy: 1 }), 2, fixed(0.5));

    let now = 0;
    state.setReady(1, true, now);
    for (; now <= 12_000; now += 16) {
      state.tick(now);
      for (const a of npc.update(state.snapshot(now), now)) {
        if (a.kind === 'ready') state.setReady(2, a.held, now);
        else state.applyTap({ playerId: 2, cardIndex: a.cardIndex, timestamp: a.timestamp });
      }
    }
    expect(state.phase).toBe('roundEnd');
    const result = state.snapshot(now).lastRound;
    expect(result?.winner).toBe(2);
    // 5초 × 5탭/초 ≈ 25장 중 상당수. 첫 탭 지연을 감안해 20장 이상
    expect(result?.counts[2]).toBeGreaterThanOrEqual(20);
  });
});
