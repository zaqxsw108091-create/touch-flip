import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, type GameConfig } from '../src/config';
import { GameState } from '../src/core/GameState';
import type { GameEvent, PlayerId } from '../src/core/types';

const cfg = (): GameConfig => structuredClone(CONFIG);

/** 양쪽 준비 → 카운트다운 종료까지 진행시키고 라운드 시작 시각을 돌려준다 */
function startRound(state: GameState, config: GameConfig, at = 1_000): number {
  state.setReady(1, true, at);
  state.setReady(2, true, at);
  const startAt = at + config.match.COUNTDOWN_MS;
  state.tick(startAt);
  return startAt;
}

function tap(state: GameState, player: PlayerId, cardIndex: number, timestamp: number) {
  return state.applyTap({ playerId: player, cardIndex, timestamp });
}

describe('GameState — 초기 상태', () => {
  it('25장 전부 중립이고 idle 로 시작한다', () => {
    const state = new GameState(cfg());
    expect(state.phase).toBe('idle');
    expect(state.board).toHaveLength(25);
    expect(state.board.every((o) => o === 0)).toBe(true);
    expect(state.cardCount(1)).toBe(0);
    expect(state.cardCount(2)).toBe(0);
  });
});

describe('GameState — 준비와 카운트다운', () => {
  let config: GameConfig;
  let state: GameState;

  beforeEach(() => {
    config = cfg();
    state = new GameState(config);
  });

  it('한쪽만 준비해서는 시작하지 않는다', () => {
    state.setReady(1, true, 0);
    expect(state.phase).toBe('idle');
  });

  it('양쪽이 준비를 누르고 있으면 카운트다운이 시작된다', () => {
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
    expect(state.phase).toBe('countdown');
    expect(state.snapshot(0).countdownValue).toBe(3);
    expect(state.snapshot(1_500).countdownValue).toBe(2);
  });

  it('카운트다운 중 한쪽이 손을 떼면 취소된다', () => {
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
    state.setReady(2, false, 500);
    expect(state.phase).toBe('idle');
    state.tick(10_000);
    expect(state.phase).toBe('idle');
  });

  it('카운트다운이 끝나면 playing 으로 넘어가고 라운드 길이는 설정값과 같다', () => {
    const startAt = startRound(state, config);
    expect(state.phase).toBe('playing');
    expect(state.remainingMs(startAt)).toBe(config.match.ROUND_DURATION_MS);
    expect(state.remainingMs(startAt + 10_000)).toBe(config.match.ROUND_DURATION_MS - 10_000);
  });

  it('rAF 가 늦게 들어와도 라운드 길이는 늘어나지 않는다', () => {
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
    // 카운트다운 종료 시각보다 200ms 늦게 tick 이 들어온 상황
    const late = config.match.COUNTDOWN_MS + 200;
    state.tick(late);
    const expectedEnd = config.match.COUNTDOWN_MS + config.match.ROUND_DURATION_MS;
    expect(state.remainingMs(expectedEnd)).toBe(0);
  });
});

describe('GameState — 카드 소유권', () => {
  let config: GameConfig;
  let state: GameState;
  let startAt: number;

  beforeEach(() => {
    config = cfg();
    state = new GameState(config);
    startAt = startRound(state, config);
  });

  it('중립 카드를 누르면 자기 색이 된다', () => {
    const result = tap(state, 1, 7, startAt + 10);
    expect(result.accepted).toBe(true);
    expect(result.previousOwner).toBe(0);
    expect(state.board[7]).toBe(1);
    expect(state.cardCount(1)).toBe(1);
  });

  it('상대 색 카드도 뺏을 수 있다', () => {
    tap(state, 1, 7, startAt + 10);
    const steal = tap(state, 2, 7, startAt + 20);
    expect(steal.accepted).toBe(true);
    expect(steal.previousOwner).toBe(1);
    expect(state.board[7]).toBe(2);
    expect(state.cardCount(1)).toBe(0);
    expect(state.cardCount(2)).toBe(1);
  });

  it('이미 자기 카드면 거부한다', () => {
    tap(state, 1, 7, startAt + 10);
    const again = tap(state, 1, 7, startAt + 20);
    expect(again.accepted).toBe(false);
    expect(again.reason).toBe('already-owned');
  });

  it('보드 범위를 벗어난 인덱스는 거부한다', () => {
    expect(tap(state, 1, 25, startAt + 10).reason).toBe('out-of-range');
    expect(tap(state, 1, -1, startAt + 10).reason).toBe('out-of-range');
  });

  it('라운드 종료 시각 이후의 탭은 tick 이 아직 안 돌았어도 거부한다', () => {
    const endAt = startAt + config.match.ROUND_DURATION_MS;
    const late = tap(state, 1, 3, endAt + 1);
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('not-playing');
    expect(state.board[3]).toBe(0);
  });

  it('라운드 시작 시각 이전의 탭도 거부한다', () => {
    const early = tap(state, 1, 3, startAt - 1);
    expect(early.accepted).toBe(false);
    expect(early.reason).toBe('not-playing');
  });

  it('flip 이벤트를 방출한다', () => {
    const events: GameEvent[] = [];
    state.subscribe((e) => events.push(e));
    tap(state, 2, 12, startAt + 5);
    expect(events).toContainEqual({
      type: 'flip',
      cardIndex: 12,
      owner: 2,
      previousOwner: 0,
      timestamp: startAt + 5,
    });
  });
});

describe('GameState — 부정 출발', () => {
  let config: GameConfig;
  let state: GameState;

  beforeEach(() => {
    config = cfg();
    state = new GameState(config);
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
  });

  it('카운트다운 중 탭은 파울로 기록되고 반영되지 않는다', () => {
    const result = tap(state, 1, 4, 1_000);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('foul');
    expect(state.board[4]).toBe(0);
    expect(state.snapshot(1_000).fouls[1]).toBe(1);
  });

  it('페널티는 라운드 시작 시점부터 500ms 동안 적용된다', () => {
    tap(state, 1, 4, 1_000);
    const startAt = config.match.COUNTDOWN_MS;
    state.tick(startAt);

    expect(state.penaltyUntil(1)).toBe(startAt + config.match.FALSE_START_PENALTY_MS);
    expect(tap(state, 1, 4, startAt + 499).reason).toBe('penalty');
    expect(tap(state, 1, 4, startAt + 500).accepted).toBe(true);
  });

  it('파울을 저지르지 않은 쪽은 페널티가 없다', () => {
    tap(state, 1, 4, 1_000);
    const startAt = config.match.COUNTDOWN_MS;
    state.tick(startAt);
    expect(state.penaltyUntil(2)).toBe(0);
    expect(tap(state, 2, 4, startAt + 1).accepted).toBe(true);
  });

  it('기본 설정에서 파울 페널티는 누적되지 않는다', () => {
    tap(state, 1, 4, 500);
    tap(state, 1, 5, 900);
    tap(state, 1, 6, 1_400);
    const startAt = config.match.COUNTDOWN_MS;
    state.tick(startAt);
    expect(state.penaltyUntil(1)).toBe(startAt + config.match.FALSE_START_PENALTY_MS);
  });

  it('STACK_FALSE_START_PENALTY 를 켜면 횟수만큼 누적된다', () => {
    const stacking = cfg();
    stacking.match.STACK_FALSE_START_PENALTY = true;
    const s = new GameState(stacking);
    s.setReady(1, true, 0);
    s.setReady(2, true, 0);
    s.applyTap({ playerId: 2, cardIndex: 0, timestamp: 500 });
    s.applyTap({ playerId: 2, cardIndex: 1, timestamp: 900 });
    const startAt = stacking.match.COUNTDOWN_MS;
    s.tick(startAt);
    expect(s.penaltyUntil(2)).toBe(startAt + stacking.match.FALSE_START_PENALTY_MS * 2);
  });

  it('카운트다운이 취소되면 파울 기록도 지워진다', () => {
    tap(state, 1, 4, 1_000);
    state.setReady(1, false, 1_100);
    expect(state.snapshot(1_100).fouls[1]).toBe(0);
  });
});

describe('GameState — 라운드와 매치 승패', () => {
  let config: GameConfig;
  let state: GameState;

  beforeEach(() => {
    config = cfg();
    state = new GameState(config);
  });

  /** 지정한 플레이어가 지정 장수만큼 먹은 상태로 라운드를 끝낸다 */
  function playRound(winner: PlayerId, cards: number, at: number): number {
    const startAt = startRound(state, config, at);
    for (let i = 0; i < cards; i += 1) {
      tap(state, winner, i, startAt + 10 + i);
    }
    const endAt = startAt + config.match.ROUND_DURATION_MS;
    state.tick(endAt);
    return endAt;
  }

  it('카드가 많은 쪽이 라운드를 가져간다', () => {
    playRound(1, 3, 0);
    expect(state.phase).toBe('roundEnd');
    expect(state.roundWins).toEqual({ 1: 1, 2: 0 });
    expect(state.snapshot(0).lastRound).toEqual({
      round: 1,
      winner: 1,
      counts: { 1: 3, 2: 0 },
    });
  });

  it('2라운드를 먼저 이기면 매치가 끝난다', () => {
    let t = 0;
    t = playRound(1, 3, t) + 100;
    expect(state.phase).toBe('roundEnd');
    t = playRound(1, 4, t) + 100;
    expect(state.phase).toBe('matchEnd');
    expect(state.matchWinner).toBe(1);
    expect(state.roundWins).toEqual({ 1: 2, 2: 0 });
  });

  it('3라운드까지 가는 매치를 처리한다', () => {
    let t = 0;
    t = playRound(1, 5, t) + 100;
    t = playRound(2, 5, t) + 100;
    expect(state.roundWins).toEqual({ 1: 1, 2: 1 });
    expect(state.round).toBe(2); // 아직 준비를 누르기 전이라 라운드 번호는 그대로다
    t = playRound(2, 6, t) + 100;
    expect(state.snapshot(t).lastRound?.round).toBe(3);
    expect(state.phase).toBe('matchEnd');
    expect(state.matchWinner).toBe(2);
  });

  it('무승부 라운드는 승수를 주지 않고 같은 라운드를 재경기한다', () => {
    const startAt = startRound(state, config, 0);
    tap(state, 1, 0, startAt + 10);
    tap(state, 2, 1, startAt + 20);
    state.tick(startAt + config.match.ROUND_DURATION_MS);

    expect(state.snapshot(0).lastRound?.winner).toBeNull();
    expect(state.roundWins).toEqual({ 1: 0, 2: 0 });
    expect(state.round).toBe(1);

    // 다음 준비 → 여전히 1라운드
    const next = startAt + config.match.ROUND_DURATION_MS + 100;
    state.setReady(1, true, next);
    state.setReady(2, true, next);
    expect(state.round).toBe(1);
    expect(state.phase).toBe('countdown');
  });

  it('라운드가 끝나면 준비 상태가 풀린다', () => {
    playRound(1, 3, 0);
    expect(state.snapshot(0).ready).toEqual({ 1: false, 2: false });
  });

  it('다음 라운드는 보드가 비워진 상태로 시작한다', () => {
    const endAt = playRound(1, 3, 0);
    state.setReady(1, true, endAt + 10);
    state.setReady(2, true, endAt + 10);
    expect(state.board.every((o) => o === 0)).toBe(true);
    expect(state.round).toBe(2);
  });

  it('라운드마다 보드 방향이 180도씩 바뀐다', () => {
    expect(state.orientation).toBe(0);
    const endAt = playRound(1, 3, 0);
    state.setReady(1, true, endAt + 10);
    state.setReady(2, true, endAt + 10);
    expect(state.round).toBe(2);
    expect(state.orientation).toBe(180);
  });

  it('매치 종료 후 양쪽이 준비하면 새 매치가 시작된다', () => {
    let t = 0;
    t = playRound(1, 3, t) + 100;
    t = playRound(1, 4, t) + 100;
    expect(state.phase).toBe('matchEnd');

    state.setReady(1, true, t);
    state.setReady(2, true, t);
    expect(state.phase).toBe('countdown');
    expect(state.round).toBe(1);
    expect(state.roundWins).toEqual({ 1: 0, 2: 0 });
    expect(state.matchWinner).toBeNull();
  });

  it('resetMatch 는 모든 것을 되돌린다', () => {
    const startAt = startRound(state, config, 0);
    tap(state, 1, 0, startAt + 10);
    state.resetMatch(startAt + 100);
    expect(state.phase).toBe('idle');
    expect(state.round).toBe(1);
    expect(state.board.every((o) => o === 0)).toBe(true);
    expect(state.roundWins).toEqual({ 1: 0, 2: 0 });
  });
});

describe('GameState — 라운드 시간 선택', () => {
  it('시작 설정에서 고른 라운드 시간을 쓴다', () => {
    const config = cfg();
    const state = new GameState(config, { roundDurationMs: 60_000 });
    expect(state.roundDurationMs).toBe(60_000);
    expect(state.remainingMs(0)).toBe(60_000);
    const startAt = startRound(state, config, 0);
    expect(state.remainingMs(startAt)).toBe(60_000);
    state.tick(startAt + 59_999);
    expect(state.phase).toBe('playing');
    state.tick(startAt + 60_000);
    expect(state.phase).toBe('roundEnd');
  });

  it('지정하지 않으면 config 기본값을 쓴다', () => {
    const config = cfg();
    const state = new GameState(config);
    expect(state.roundDurationMs).toBe(config.match.ROUND_DURATION_MS);
    expect(state.snapshot(0).roundDurationMs).toBe(config.match.ROUND_DURATION_MS);
  });

  it('config 의 시간 선택지는 전부 양수이고 기본값을 포함한다', () => {
    const config = cfg();
    expect(config.match.ROUND_DURATION_OPTIONS_MS.every((ms) => ms > 0)).toBe(true);
    expect(config.match.ROUND_DURATION_OPTIONS_MS).toContain(config.match.ROUND_DURATION_MS);
  });
});

describe('GameState — 일시정지 (extendDeadlines)', () => {
  let config: GameConfig;
  let state: GameState;

  beforeEach(() => {
    config = cfg();
    state = new GameState(config);
  });

  it('카운트다운 중 정지 시간만큼 밀어도 남은 시간이 그대로 보존된다', () => {
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
    const beforePause = state.remainingMs(1_000); // 카운트다운 중 1초 지난 시점의 잔여
    state.extendDeadlines(5_000); // 5초 동안 멈춰 있었다고 알림
    expect(state.remainingMs(1_000 + 5_000)).toBe(beforePause);
  });

  it('플레이 중 정지해도 라운드가 끝난 것으로 처리되지 않는다', () => {
    const startAt = startRound(state, config, 0);
    const pauseAt = startAt + 10_000;
    const remainingAtPause = state.remainingMs(pauseAt);
    state.extendDeadlines(20_000); // 20초 정지 — 정지 없이 그냥 뒀으면 라운드가 끝났을 시간
    const resumeAt = pauseAt + 20_000;
    expect(state.remainingMs(resumeAt)).toBe(remainingAtPause);
    state.tick(resumeAt);
    expect(state.phase).toBe('playing'); // 아직 안 끝났다
  });

  it('정지 중 놓친 탭은 재개 후 같은 시각 축에서 다시 유효하다', () => {
    const startAt = startRound(state, config, 0);
    const pauseAt = startAt + 100;
    state.extendDeadlines(3_000);
    const resumeAt = pauseAt + 3_000;
    // 정지를 보정하지 않았다면 이 타임스탬프는 이미 지난 라운드의 것으로 거부됐을 것이다
    const result = tap(state, 1, 0, resumeAt + 50);
    expect(result.accepted).toBe(true);
  });

  it('활성 페널티도 함께 밀려서 남은 정지 시간이 보존된다', () => {
    state.setReady(1, true, 0);
    state.setReady(2, true, 0);
    tap(state, 1, 4, 1_000); // 카운트다운 중 파울
    const startAt = config.match.COUNTDOWN_MS;
    state.tick(startAt);
    const penaltyRemaining = state.penaltyUntil(1) - (startAt + 100);
    state.extendDeadlines(4_000);
    expect(state.penaltyUntil(1) - (startAt + 100 + 4_000)).toBe(penaltyRemaining);
  });

  it('진행 중인 마감이 없으면(idle) 아무것도 바뀌지 않는다', () => {
    expect(state.penaltyUntil(1)).toBe(0);
    state.extendDeadlines(9_999);
    expect(state.penaltyUntil(1)).toBe(0); // 0이 9999가 되어 "가짜 페널티"가 생기면 안 된다
    expect(state.phase).toBe('idle');
  });

  it('0 이하의 delta 는 아무 효과가 없다', () => {
    const startAt = startRound(state, config, 0);
    const before = state.remainingMs(startAt + 500);
    state.extendDeadlines(0);
    state.extendDeadlines(-100);
    expect(state.remainingMs(startAt + 500)).toBe(before);
  });
});
