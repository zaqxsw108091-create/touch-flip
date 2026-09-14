import { describe, expect, it } from 'vitest';
import type { ServerSnapshot } from '../src/net/protocol';
import { RemoteState } from '../src/net/RemoteState';

function server(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return {
    phase: 'playing',
    board: new Array<number>(25).fill(0),
    round: 1,
    maxRounds: 3,
    orientation: 0,
    counts: [0, 0],
    roundWins: [0, 0],
    ready: [false, false],
    fouls: [0, 0],
    penaltyUntil: [0, 0],
    roundDurationMs: 30_000,
    remainingMs: 10_000,
    countdownValue: 0,
    lastRound: null,
    matchWinner: null,
    revision: 1,
    ...overrides,
  };
}

describe('RemoteState — 변환', () => {
  it('서버 상태가 오기 전에는 빈 idle 보드를 준다', () => {
    const r = new RemoteState(60_000);
    const s = r.snapshot(0);
    expect(s.phase).toBe('idle');
    expect(s.board.every((o) => o === 0)).toBe(true);
    expect(s.roundDurationMs).toBe(60_000);
    expect(r.hasState).toBe(false);
  });

  it('[P1, P2] 배열을 {1, 2} 레코드로 바꾼다', () => {
    const r = new RemoteState(30_000);
    const board = new Array<number>(25).fill(0);
    board[3] = 1;
    board[4] = 2;
    r.apply(
      server({
        board,
        counts: [1, 1],
        roundWins: [1, 0],
        ready: [true, false],
        lastRound: { round: 1, winner: 2, counts: [3, 5] },
        matchWinner: null,
      }),
      1_000,
    );
    const s = r.snapshot(1_000);
    expect(s.board[3]).toBe(1);
    expect(s.counts).toEqual({ 1: 1, 2: 1 });
    expect(s.roundWins).toEqual({ 1: 1, 2: 0 });
    expect(s.ready).toEqual({ 1: true, 2: false });
    expect(s.lastRound).toEqual({ round: 1, winner: 2, counts: { 1: 3, 2: 5 } });
  });
});

describe('RemoteState — 타이머 보간', () => {
  it('수신 이후 흐른 시간만큼 남은 시간을 줄여 보여준다', () => {
    const r = new RemoteState(30_000);
    r.apply(server({ remainingMs: 10_000 }), 1_000);
    expect(r.snapshot(1_000).remainingMs).toBe(10_000);
    expect(r.snapshot(1_400).remainingMs).toBe(9_600);
  });

  it('0 아래로 내려가지 않고, 페이즈는 서버가 바꿀 때까지 그대로다', () => {
    // 라운드 종료는 서버만 선언한다 — 클라 시계가 앞서 가도 playing 이 유지된다
    const r = new RemoteState(30_000);
    r.apply(server({ remainingMs: 100 }), 1_000);
    const s = r.snapshot(5_000);
    expect(s.remainingMs).toBe(0);
    expect(s.phase).toBe('playing');
  });

  it('카운트다운 숫자도 보간한다', () => {
    const r = new RemoteState(30_000);
    r.apply(server({ phase: 'countdown', remainingMs: 2_600, countdownValue: 3 }), 0);
    expect(r.snapshot(0).countdownValue).toBe(3);
    expect(r.snapshot(700).countdownValue).toBe(2);
    expect(r.snapshot(2_599).countdownValue).toBe(1);
  });

  it('roundEnd 에서는 보간하지 않는다', () => {
    const r = new RemoteState(30_000);
    r.apply(server({ phase: 'roundEnd', remainingMs: 0 }), 0);
    expect(r.snapshot(10_000).remainingMs).toBe(0);
  });
});

describe('RemoteState — 이벤트 diff', () => {
  it('새로 뒤집힌 카드마다 flip 이벤트를 만든다', () => {
    const r = new RemoteState(30_000);
    r.apply(server(), 0);
    const board = new Array<number>(25).fill(0);
    board[5] = 2;
    board[6] = 1;
    const events = r.apply(server({ board, revision: 2 }), 100);
    expect(events).toContainEqual({ type: 'flip', cardIndex: 5, owner: 2, previousOwner: 0, timestamp: 100 });
    expect(events).toContainEqual({ type: 'flip', cardIndex: 6, owner: 1, previousOwner: 0, timestamp: 100 });
  });

  it('뺏긴 카드도 flip 으로 잡는다', () => {
    const r = new RemoteState(30_000);
    const board = new Array<number>(25).fill(0);
    board[5] = 2;
    r.apply(server({ board }), 0);
    board[5] = 1;
    const events = r.apply(server({ board: board.slice(), revision: 2 }), 50);
    expect(events).toEqual([{ type: 'flip', cardIndex: 5, owner: 1, previousOwner: 2, timestamp: 50 }]);
  });

  it('파울 수가 늘면 foul, 페이즈가 바뀌면 phase 이벤트', () => {
    const r = new RemoteState(30_000);
    r.apply(server({ phase: 'countdown' }), 0);
    const events = r.apply(server({ phase: 'playing', fouls: [1, 0], revision: 2 }), 10);
    expect(events).toContainEqual({ type: 'foul', playerId: 1, timestamp: 10 });
    expect(events).toContainEqual({ type: 'phase', phase: 'playing', previous: 'countdown' });
  });

  it('순서가 뒤바뀐(오래된 revision) 상태는 무시한다', () => {
    const r = new RemoteState(30_000);
    r.apply(server({ revision: 5, remainingMs: 5_000 }), 0);
    const events = r.apply(server({ revision: 3, remainingMs: 9_000 }), 10);
    expect(events).toEqual([]);
    expect(r.snapshot(10).remainingMs).toBe(4_990);
  });

  it('보드가 비워지는 것(라운드 리셋)은 flip 으로 치지 않는다', () => {
    const r = new RemoteState(30_000);
    const board = new Array<number>(25).fill(1);
    r.apply(server({ board }), 0);
    const events = r.apply(server({ board: new Array<number>(25).fill(0), phase: 'countdown', revision: 2 }), 10);
    expect(events.filter((e) => e.type === 'flip')).toEqual([]);
  });
});
