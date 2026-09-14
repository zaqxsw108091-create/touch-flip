import type { DeviceMode } from '../config';

export type PlayerId = 1 | 2;

/** 0 = 중립(아무도 소유하지 않음) */
export type CardOwner = 0 | PlayerId;

export type Phase = 'idle' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';

/** InputGovernor 의 모든 필터를 통과한 유효 탭. GameState 는 이것만 소비한다. */
export interface TapEvent {
  playerId: PlayerId;
  cardIndex: number;
  /** event.timeStamp 기준 시각(ms). rAF 시각이 아니다 */
  timestamp: number;
}

export type TapRejectReason =
  | 'not-playing' // 라운드 진행 중이 아님 (또는 라운드 종료 시각 이후의 탭)
  | 'penalty' // 부정 출발 페널티 적용 중
  | 'already-owned' // 이미 자기 카드
  | 'foul' // 카운트다운 중 터치 = 부정 출발
  | 'out-of-range'; // 잘못된 카드 인덱스

export interface TapResult {
  accepted: boolean;
  cardIndex: number;
  playerId: PlayerId;
  owner: CardOwner;
  previousOwner: CardOwner;
  reason?: TapRejectReason;
}

export interface RoundResult {
  round: number;
  /** null = 무승부 (양쪽 카드 수가 같음). 이 경우 승수를 주지 않고 재경기한다 */
  winner: PlayerId | null;
  counts: Record<PlayerId, number>;
}

export type GameEvent =
  | { type: 'flip'; cardIndex: number; owner: CardOwner; previousOwner: CardOwner; timestamp: number }
  | { type: 'foul'; playerId: PlayerId; timestamp: number }
  | { type: 'ready'; playerId: PlayerId; held: boolean }
  | { type: 'phase'; phase: Phase; previous: Phase }
  | { type: 'roundEnd'; result: RoundResult }
  | { type: 'matchEnd'; winner: PlayerId };

/** 렌더러가 매 프레임 읽어가는 읽기 전용 상태 스냅샷 */
export interface Snapshot {
  phase: Phase;
  board: readonly CardOwner[];
  round: number;
  maxRounds: number;
  /** 라운드별 보드 회전. 0 또는 180 */
  orientation: 0 | 180;
  counts: Record<PlayerId, number>;
  roundWins: Record<PlayerId, number>;
  ready: Record<PlayerId, boolean>;
  fouls: Record<PlayerId, number>;
  penaltyUntil: Record<PlayerId, number>;
  /** 이 매치의 라운드 길이(ms). 시작 화면에서 고른 값 */
  roundDurationMs: number;
  /** 현재 페이즈에서 남은 시간(ms) */
  remainingMs: number;
  /** 카운트다운 표시 숫자(3/2/1). 카운트다운이 아니면 0 */
  countdownValue: number;
  lastRound: RoundResult | null;
  matchWinner: PlayerId | null;
  /** 상태가 바뀔 때마다 증가. 렌더러의 diff 기준 */
  revision: number;
}

// ---------------------------------------------------------------- 시작 설정

export type OpponentKind = 'local' | 'npc' | 'online';

/** 시작 화면에서 고르는 매치 설정. GameState 는 이 중 roundDurationMs 만 쓴다 */
export interface MatchOptions {
  deviceMode: DeviceMode;
  opponent: OpponentKind;
  /** opponent === 'npc' 일 때의 단계 id. config.npc.tiers 의 id 와 대응 */
  npcTier: number;
  roundDurationMs: number;
  /** opponent === 'online' 일 때의 WebSocket 주소. 비어 있으면 config 기본값 */
  serverUrl: string;
}
