import { describe, expect, it } from 'vitest';
import { addRecord, parseRecords, rankRecords, type MatchRecord } from '../src/core/Records';

function rec(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return { npcTier: 1, roundDurationMs: 30_000, result: 'win', myRoundWins: 2, npcRoundWins: 0, at: 0, ...overrides };
}

describe('parseRecords — 손상/빈 값 방어', () => {
  it('null/undefined/빈 문자열은 빈 배열', () => {
    expect(parseRecords(null)).toEqual([]);
    expect(parseRecords(undefined)).toEqual([]);
    expect(parseRecords('')).toEqual([]);
  });

  it('JSON 이 아니면 빈 배열 (게임이 멈추지 않는다)', () => {
    expect(parseRecords('{안깨진 JSON 아님')).toEqual([]);
    expect(parseRecords('undefined')).toEqual([]);
  });

  it('배열이 아닌 JSON 이면 빈 배열', () => {
    expect(parseRecords('{"a":1}')).toEqual([]);
    expect(parseRecords('42')).toEqual([]);
  });

  it('형식이 어긋난 항목만 걸러내고 나머지는 살린다', () => {
    const good = rec({ npcTier: 3 });
    const raw = JSON.stringify([good, { npcTier: 'oops' }, null, 42, { ...good, result: 'draw' }]);
    expect(parseRecords(raw)).toEqual([good]);
  });

  it('정상 기록은 그대로 통과한다', () => {
    const good = [rec({ npcTier: 2 }), rec({ npcTier: 5, result: 'loss' })];
    expect(parseRecords(JSON.stringify(good))).toEqual(good);
  });
});

describe('rankRecords — 순위 규칙', () => {
  it('승리가 패배보다 항상 위다', () => {
    const loss = rec({ result: 'loss', npcTier: 5 });
    const win = rec({ result: 'win', npcTier: 1 });
    expect(rankRecords([loss, win])).toEqual([win, loss]);
  });

  it('같은 결과면 NPC 단계가 높은 쪽이 위다', () => {
    const low = rec({ npcTier: 2 });
    const high = rec({ npcTier: 5 });
    expect(rankRecords([low, high])).toEqual([high, low]);
  });

  it('단계가 같으면 라운드 스코어 차이가 큰 쪽이 위다', () => {
    const narrow = rec({ npcTier: 3, myRoundWins: 2, npcRoundWins: 1 });
    const wide = rec({ npcTier: 3, myRoundWins: 2, npcRoundWins: 0 });
    expect(rankRecords([narrow, wide])).toEqual([wide, narrow]);
  });

  it('전부 같으면 먼저 세운 기록(at 이 이른 쪽)이 위다', () => {
    const later = rec({ at: 2_000 });
    const earlier = rec({ at: 1_000 });
    expect(rankRecords([later, earlier])).toEqual([earlier, later]);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const input = [rec({ result: 'loss' }), rec({ result: 'win' })];
    const copy = [...input];
    rankRecords(input);
    expect(input).toEqual(copy);
  });
});

describe('addRecord — 추가 + 상한', () => {
  it('추가한 기록이 순위에 맞게 들어간다', () => {
    const existing = [rec({ npcTier: 2 })];
    const added = addRecord(existing, rec({ npcTier: 5 }), 10);
    expect(added[0]!.npcTier).toBe(5);
    expect(added).toHaveLength(2);
  });

  it('max 를 넘으면 순위가 낮은 쪽부터 잘린다', () => {
    const existing = [rec({ npcTier: 1 }), rec({ npcTier: 2 }), rec({ npcTier: 3 })];
    const added = addRecord(existing, rec({ npcTier: 4 }), 2);
    expect(added.map((r) => r.npcTier)).toEqual([4, 3]);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    const existing = [rec()];
    addRecord(existing, rec({ npcTier: 5 }), 10);
    expect(existing).toHaveLength(1);
  });
});
