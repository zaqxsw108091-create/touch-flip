import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, type GameConfig } from '../src/config';
import type { PlayerId, TapEvent, TapResult } from '../src/core/types';
import type { CardHit, HitTester } from '../src/input/HitTester';
import { InputGovernor, type PointerLike } from '../src/input/InputGovernor';

const cfg = (): GameConfig => structuredClone(CONFIG);

/**
 * 좌표 규약(테스트 전용): x = 카드 인덱스, y = 존.
 *   y > 0 → 아래쪽 존(P1), y < 0 → 위쪽 존(P2), y === 0 → 중립 띠(무효)
 */
const hitTester: HitTester = {
  hitTest(x: number, y: number): CardHit | null {
    if (y === 0) return null;
    if (x < 0 || x >= CONFIG.board.CARD_COUNT) return null;
    return { cardIndex: x, playerId: y > 0 ? 1 : 2 };
  },
};

function pointer(overrides: Partial<PointerLike> = {}): PointerLike {
  return {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 0,
    clientY: 1,
    width: 20,
    height: 20,
    timeStamp: 1_000,
    ...overrides,
  };
}

/** 항상 성공을 돌려주는 GameState 대역 */
function acceptAll(): { taps: TapEvent[]; onTap: (t: TapEvent) => TapResult } {
  const taps: TapEvent[] = [];
  return {
    taps,
    onTap: (t) => {
      taps.push(t);
      return {
        accepted: true,
        cardIndex: t.cardIndex,
        playerId: t.playerId,
        owner: t.playerId,
        previousOwner: 0,
      };
    },
  };
}

/** 항상 거부하는 GameState 대역 */
function rejectAll(): { taps: TapEvent[]; onTap: (t: TapEvent) => TapResult } {
  const taps: TapEvent[] = [];
  return {
    taps,
    onTap: (t) => {
      taps.push(t);
      return {
        accepted: false,
        cardIndex: t.cardIndex,
        playerId: t.playerId,
        owner: 0,
        previousOwner: 0,
        reason: 'already-owned',
      };
    },
  };
}

describe('InputGovernor — 포인터 종류', () => {
  let config: GameConfig;

  beforeEach(() => {
    config = cfg();
  });

  it('touch 만 유효하다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    expect(g.handlePointerDown(pointer({ pointerType: 'touch' })).emitted).toBe(true);
  });

  it('마우스는 무시한다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const out = g.handlePointerDown(pointer({ pointerType: 'mouse' }));
    expect(out.emitted).toBe(false);
    expect(out.reject).toBe('pointer-type');
    expect(sink.taps).toHaveLength(0);
  });

  it('펜은 무시한다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    expect(g.handlePointerDown(pointer({ pointerType: 'pen' })).reject).toBe('pointer-type');
  });

  it('디버그 모드에서만 마우스가 허용된다', () => {
    config.debug.allowMouse = true;
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    expect(g.handlePointerDown(pointer({ pointerType: 'mouse' })).emitted).toBe(true);
    // 펜은 디버그 모드에서도 허용하지 않는다
    expect(g.handlePointerDown(pointer({ pointerType: 'pen', timeStamp: 5_000 })).reject).toBe(
      'pointer-type',
    );
  });
});

describe('InputGovernor — 접촉 크기', () => {
  it('MAX_TOUCH_SIZE_PX 를 넘으면 손바닥으로 보고 무시한다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const big = config.input.MAX_TOUCH_SIZE_PX + 1;
    expect(g.handlePointerDown(pointer({ width: big, height: 5 })).reject).toBe('touch-size');
    expect(g.handlePointerDown(pointer({ width: 5, height: big })).reject).toBe('touch-size');
  });

  it('크기를 보고하지 않는 브라우저(0)는 통과시킨다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    expect(g.handlePointerDown(pointer({ width: 0, height: 0 })).emitted).toBe(true);
  });

  it('경계값(정확히 MAX_TOUCH_SIZE_PX)은 통과시킨다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const size = config.input.MAX_TOUCH_SIZE_PX;
    expect(g.handlePointerDown(pointer({ width: size, height: size })).emitted).toBe(true);
  });
});

describe('InputGovernor — 히트 테스트', () => {
  it('중립 띠는 무효다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    expect(g.handlePointerDown(pointer({ clientY: 0 })).reject).toBe('no-hit');
    expect(sink.taps).toHaveLength(0);
  });

  it('존에 따라 소유자 후보가 결정된다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.handlePointerDown(pointer({ clientX: 3, clientY: 1, pointerId: 1, timeStamp: 1_000 }));
    g.handlePointerDown(pointer({ clientX: 4, clientY: -1, pointerId: 2, timeStamp: 1_000 }));
    expect(sink.taps).toEqual([
      { playerId: 1, cardIndex: 3, timestamp: 1_000 },
      { playerId: 2, cardIndex: 4, timestamp: 1_000 },
    ]);
  });
});

describe('InputGovernor — 동시 포인터 제한', () => {
  let config: GameConfig;

  beforeEach(() => {
    config = cfg();
  });

  it('플레이어당 MAX_POINTERS_PER_PLAYER 를 넘는 손가락은 무시한다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const gap = config.input.PLAYER_COOLDOWN_MS + 10;

    expect(g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: 1_000 })).emitted).toBe(true);
    expect(g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, timeStamp: 1_000 + gap })).emitted).toBe(true);
    const third = g.handlePointerDown(pointer({ pointerId: 3, clientX: 2, timeStamp: 1_000 + gap * 2 }));
    expect(third.emitted).toBe(false);
    expect(third.reject).toBe('max-pointers');
    expect(g.countPointers(1)).toBe(2);
  });

  it('상대 플레이어의 포인터 수와는 독립이다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, clientY: 1, timeStamp: 1_000 }));
    g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, clientY: 1, timeStamp: 1_100 }));
    const p2 = g.handlePointerDown(pointer({ pointerId: 3, clientX: 2, clientY: -1, timeStamp: 1_200 }));
    expect(p2.emitted).toBe(true);
    expect(g.countPointers(1)).toBe(2);
    expect(g.countPointers(2)).toBe(1);
  });

  it('pointerup 이 유실돼도 POINTER_STALE_MS 후에는 회복된다', () => {
    // 이벤트 하나를 놓쳤다고 해당 플레이어가 남은 판 내내 입력 불가가 되면 안 된다
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const gap = config.input.PLAYER_COOLDOWN_MS + 10;
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: 1_000 }));
    g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, timeStamp: 1_000 + gap }));
    // pointerup 없음
    const blocked = g.handlePointerDown(pointer({ pointerId: 3, clientX: 2, timeStamp: 1_000 + gap * 2 }));
    expect(blocked.reject).toBe('max-pointers');

    const later = 1_000 + config.input.POINTER_STALE_MS + 1;
    expect(g.handlePointerDown(pointer({ pointerId: 3, clientX: 2, timeStamp: later })).emitted).toBe(true);
    // 오래된 1번만 정리되고, 아직 만료 전인 2번과 새로 들어온 3번이 남는다
    expect(g.countPointers(1)).toBe(2);
  });

  it('계속 눌려 있는 포인터는 만료되지 않는다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const stale = config.input.POINTER_STALE_MS;
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: 1_000 }));
    // 같은 포인터가 계속 이벤트를 보내면 lastSeen 이 갱신된다
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 1, timeStamp: 1_000 + stale - 100 }));
    g.handlePointerDown(pointer({ pointerId: 2, clientX: 2, timeStamp: 1_000 + stale }));
    const third = g.handlePointerDown(pointer({ pointerId: 3, clientX: 3, timeStamp: 1_000 + stale + 100 }));
    expect(third.reject).toBe('max-pointers');
  });

  it('손을 떼면 다시 누를 수 있다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const gap = config.input.PLAYER_COOLDOWN_MS + 10;
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: 1_000 }));
    g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, timeStamp: 1_000 + gap }));
    g.handlePointerUp({ pointerId: 1 });
    expect(g.handlePointerDown(pointer({ pointerId: 3, clientX: 2, timeStamp: 1_000 + gap * 2 })).emitted).toBe(true);
  });
});

describe('InputGovernor — 쿨다운', () => {
  let config: GameConfig;

  beforeEach(() => {
    config = cfg();
  });

  it('PLAYER_COOLDOWN_MS 안에 들어온 두 번째 탭은 무시한다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const t0 = 1_000;
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: t0 }));
    const tooFast = g.handlePointerDown(
      pointer({ pointerId: 2, clientX: 1, timeStamp: t0 + config.input.PLAYER_COOLDOWN_MS - 1 }),
    );
    expect(tooFast.reject).toBe('cooldown');

    const ok = g.handlePointerDown(
      pointer({ pointerId: 2, clientX: 1, timeStamp: t0 + config.input.PLAYER_COOLDOWN_MS }),
    );
    expect(ok.emitted).toBe(true);
  });

  it('쿨다운은 플레이어별로 따로 돈다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, clientY: 1, timeStamp: 1_000 }));
    // 다른 카드여야 카드 락아웃이 아닌 쿨다운만 검증된다
    const p2 = g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, clientY: -1, timeStamp: 1_001 }));
    expect(p2.emitted).toBe(true);
  });

  it('GameState 가 거부한 탭도 쿨다운을 소모한다', () => {
    // 자기 카드를 연타해 쿨다운을 우회하는 구멍을 막는다
    const sink = rejectAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, timeStamp: 1_000 }));
    const second = g.handlePointerDown(pointer({ pointerId: 1, clientX: 1, timeStamp: 1_010 }));
    expect(second.reject).toBe('cooldown');
  });
});

describe('InputGovernor — 카드 락아웃', () => {
  let config: GameConfig;

  beforeEach(() => {
    config = cfg();
  });

  it('뒤집힌 직후 CARD_LOCKOUT_MS 동안 같은 카드는 무시한다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    const t0 = 1_000;
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: t0 }));

    // 상대가 곧바로 같은 카드를 노려도 락아웃에 걸린다
    const early = g.handlePointerDown(
      pointer({ pointerId: 2, clientX: 7, clientY: -1, timeStamp: t0 + config.input.CARD_LOCKOUT_MS - 1 }),
    );
    expect(early.reject).toBe('card-lockout');

    const late = g.handlePointerDown(
      pointer({ pointerId: 2, clientX: 7, clientY: -1, timeStamp: t0 + config.input.CARD_LOCKOUT_MS }),
    );
    expect(late.emitted).toBe(true);
  });

  it('락아웃은 해당 카드에만 걸린다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: 1_000 }));
    const other = g.handlePointerDown(pointer({ pointerId: 2, clientX: 8, clientY: -1, timeStamp: 1_001 }));
    expect(other.emitted).toBe(true);
  });

  it('GameState 가 거부하면 락아웃을 걸지 않는다', () => {
    const sink = rejectAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: 1_000 }));
    const p2 = g.handlePointerDown(pointer({ pointerId: 2, clientX: 7, clientY: -1, timeStamp: 1_010 }));
    expect(p2.reject).not.toBe('card-lockout');
  });
});

describe('InputGovernor — 판정 시각', () => {
  it('event.timeStamp 를 그대로 판정에 쓴다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.handlePointerDown(pointer({ timeStamp: 4_321 }), 9_999);
    expect(sink.taps[0]?.timestamp).toBe(4_321);
  });

  it('timeStamp 가 epoch 로 오는 환경에서는 대체 시각을 쓴다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.handlePointerDown(pointer({ timeStamp: Date.now() }), 1_234);
    expect(sink.taps[0]?.timestamp).toBe(1_234);
  });
});

describe('InputGovernor — 상태 제어', () => {
  it('비활성화하면 아무것도 방출하지 않는다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.setEnabled(false);
    expect(g.handlePointerDown(pointer()).reject).toBe('disabled');
    expect(sink.taps).toHaveLength(0);
  });

  it('resetRuntime 은 쿨다운과 락아웃을 지우되 눌린 손가락은 유지한다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: 1_000 }));
    expect(g.countPointers(1)).toBe(1);

    g.resetRuntime();
    expect(g.countPointers(1)).toBe(1);
    // 쿨다운도 락아웃도 남아 있지 않다
    expect(g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: 1_001 })).emitted).toBe(true);
  });

  it('통계를 집계한다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerType: 'mouse' }));
    g.handlePointerDown(pointer({ clientY: 0 }));
    g.handlePointerDown(pointer({ timeStamp: 2_000 }));
    expect(g.stats.received).toBe(3);
    expect(g.stats.emitted).toBe(1);
    expect(g.stats.accepted).toBe(1);
    expect(g.stats.rejected['pointer-type']).toBe(1);
    expect(g.stats.rejected['no-hit']).toBe(1);
  });
});

describe('InputGovernor — 플레이어 판정', () => {
  it('아래쪽 존은 P1, 위쪽 존은 P2 로 간다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    const players: PlayerId[] = [];
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, clientY: 5, timeStamp: 1_000 }));
    g.handlePointerDown(pointer({ pointerId: 2, clientX: 1, clientY: -5, timeStamp: 1_000 }));
    for (const t of sink.taps) players.push(t.playerId);
    expect(players).toEqual([1, 2]);
  });
});

describe('InputGovernor — submitTap (NPC 경로)', () => {
  it('포인터 필터 없이 들어오지만 쿨다운은 똑같이 적용된다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    expect(g.submitTap(2, 0, 1_000).emitted).toBe(true);
    expect(g.submitTap(2, 1, 1_000 + config.input.PLAYER_COOLDOWN_MS - 1).reject).toBe('cooldown');
    expect(g.submitTap(2, 1, 1_000 + config.input.PLAYER_COOLDOWN_MS).emitted).toBe(true);
  });

  it('카드 락아웃도 사람과 NPC 사이에 똑같이 걸린다', () => {
    const config = cfg();
    const sink = acceptAll();
    const g = new InputGovernor(config, hitTester, sink.onTap);
    // 사람이 7번을 뒤집은 직후 NPC 가 노린다
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 7, clientY: 1, timeStamp: 1_000 }));
    expect(g.submitTap(2, 7, 1_000 + config.input.CARD_LOCKOUT_MS - 1).reject).toBe('card-lockout');
    expect(g.submitTap(2, 7, 1_000 + config.input.CARD_LOCKOUT_MS).emitted).toBe(true);
    // 반대로 NPC 가 뒤집은 카드는 사람이 락아웃에 걸린다
    const p1 = g.handlePointerDown(pointer({ pointerId: 2, clientX: 7, clientY: 1, timeStamp: 1_000 + config.input.CARD_LOCKOUT_MS + 10 }));
    expect(p1.reject).toBe('card-lockout');
  });

  it('NPC 의 쿨다운은 사람의 쿨다운과 독립이다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.handlePointerDown(pointer({ pointerId: 1, clientX: 0, clientY: 1, timeStamp: 1_000 }));
    expect(g.submitTap(2, 1, 1_001).emitted).toBe(true);
  });

  it('비활성화 상태에서는 NPC 탭도 막힌다', () => {
    const sink = acceptAll();
    const g = new InputGovernor(cfg(), hitTester, sink.onTap);
    g.setEnabled(false);
    expect(g.submitTap(2, 0, 1_000).reject).toBe('disabled');
  });
});
