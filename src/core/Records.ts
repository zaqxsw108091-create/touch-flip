/**
 * 싱글플레이(NPC) 개인 최고기록. 서버 없이 이 기기의 localStorage 에만 남는다.
 *
 * DOM 에 의존하지 않는 순수 함수들이다. 실제 저장/로딩(try/catch, localStorage)은
 * main.ts 가 담당하고, 여기서는 "문자열을 안전하게 기록 배열로 바꾸는 것"과
 * "기록을 순위대로 정렬/보관하는 것"만 책임진다 — GameState 와 같은 원칙.
 */

export type MatchOutcome = 'win' | 'loss';

export interface MatchRecord {
  /** config.npc.tiers 의 id */
  npcTier: number;
  roundDurationMs: number;
  result: MatchOutcome;
  myRoundWins: number;
  npcRoundWins: number;
  /** Date.now(). 순위가 같을 때 먼저 세운 기록을 우선한다 */
  at: number;
}

function isValidRecord(value: unknown): value is MatchRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['npcTier'] === 'number' &&
    Number.isFinite(r['npcTier']) &&
    typeof r['roundDurationMs'] === 'number' &&
    Number.isFinite(r['roundDurationMs']) &&
    (r['result'] === 'win' || r['result'] === 'loss') &&
    typeof r['myRoundWins'] === 'number' &&
    typeof r['npcRoundWins'] === 'number' &&
    typeof r['at'] === 'number' &&
    Number.isFinite(r['at'])
  );
}

/**
 * 저장된 문자열을 기록 배열로 바꾼다. 비어있거나, JSON이 아니거나, 배열이 아니거나,
 * 항목 형식이 어긋나면 그 항목만 걸러내고(전체를 버리지 않고) 나머지는 살린다.
 * 완전히 못 읽으면 빈 배열 — 게임이 멈추지 않는다.
 */
export function parseRecords(raw: string | null | undefined): MatchRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecord);
  } catch {
    return [];
  }
}

/**
 * 순위 정렬: 승리가 패배보다 위, 그 안에서는 상대한 NPC 단계가 높을수록,
 * 같은 단계면 라운드 스코어 차이가 클수록, 그래도 같으면 먼저 세운 기록이 위.
 * "느낌"이 아니라 이 규칙 하나로 항상 같은 순서가 나온다.
 */
export function rankRecords(records: readonly MatchRecord[]): MatchRecord[] {
  return [...records].sort((a, b) => {
    const aWin = a.result === 'win' ? 1 : 0;
    const bWin = b.result === 'win' ? 1 : 0;
    if (bWin !== aWin) return bWin - aWin;
    if (b.npcTier !== a.npcTier) return b.npcTier - a.npcTier;
    const marginA = a.myRoundWins - a.npcRoundWins;
    const marginB = b.myRoundWins - b.npcRoundWins;
    if (marginB !== marginA) return marginB - marginA;
    return a.at - b.at;
  });
}

/** 기록을 추가하고 순위로 정렬한 뒤 max 개로 자른다. 원본 배열은 바꾸지 않는다. */
export function addRecord(records: readonly MatchRecord[], record: MatchRecord, max: number): MatchRecord[] {
  return rankRecords([...records, record]).slice(0, Math.max(0, max));
}
