/**
 * 모든 튜닝 상수의 단일 소스.
 *
 * 규칙: 로직 파일 어디에도 매직 넘버를 두지 않는다. 값을 바꾸고 싶으면 이 파일만 고친다.
 * 공정성 상수(input 그룹)는 실기기 테스트 후 여기서만 조정한다.
 */

export type PointerKind = 'touch' | 'mouse' | 'pen';
export type DeviceMode = 'tablet' | 'phone';
export type ZoneMode = 'split' | 'full';

export interface BoardConfig {
  /** 보드 열 수 */
  COLS: number;
  /** 보드 행 수 */
  ROWS: number;
  /** COLS * ROWS. 홀수여야 무승부 확률이 낮다 */
  CARD_COUNT: number;
  /** 카드 중앙 무효 영역이 카드 높이에서 차지하는 비율 (split 존 모드 전용) */
  NEUTRAL_BAND_RATIO: number;
}

export interface DeviceProfile {
  /** 카드 한 변의 물리 크기(mm). 화면이 커져도 보드가 커지지 않게 고정한다 */
  CARD_PHYSICAL_SIZE_MM: number;
  /** 카드 사이 간격(mm) */
  CARD_GAP_MM: number;
}

export interface InputConfig {
  /** 플레이어 한 명이 동시에 유지할 수 있는 유효 포인터 수. 초과분은 무시 */
  MAX_POINTERS_PER_PLAYER: number;
  /** 플레이어별 전역 최소 입력 간격(ms) */
  PLAYER_COOLDOWN_MS: number;
  /** 카드가 뒤집힌 직후 그 카드의 입력을 무시하는 시간(ms) */
  CARD_LOCKOUT_MS: number;
  /** pointerEvent.width/height 가 이 값을 넘으면 손바닥으로 간주하고 무시(px) */
  MAX_TOUCH_SIZE_PX: number;
  /** 유효한 pointerType 목록. 기본은 touch 만 */
  ALLOWED_POINTER_TYPES: PointerKind[];
  /**
   * 이 시간 동안 아무 이벤트도 없던 포인터는 등록에서 제거한다(ms).
   * pointerup 이 유실되면 그 플레이어가 영구히 입력 불가가 되는 것을 막는 안전장치.
   */
  POINTER_STALE_MS: number;
}

export interface MatchConfig {
  /** 시작 화면에서 고를 수 있는 라운드 길이 목록(ms) */
  ROUND_DURATION_OPTIONS_MS: number[];
  /** 아무것도 고르지 않았을 때의 라운드 길이(ms) */
  ROUND_DURATION_MS: number;
  /** 준비 완료 후 카운트다운 길이(ms) */
  COUNTDOWN_MS: number;
  /** 매치 승리에 필요한 라운드 승수 */
  ROUNDS_TO_WIN: number;
  /** 최대 라운드 수 (무승부 라운드는 재경기이므로 초과 가능) */
  MAX_ROUNDS: number;
  /** 부정 출발 시 입력 정지 시간(ms) */
  FALSE_START_PENALTY_MS: number;
  /** 부정 출발 페널티를 횟수만큼 누적할지 여부. false = 몇 번을 눌러도 1회분 */
  STACK_FALSE_START_PENALTY: boolean;
}

export interface NpcTier {
  id: number;
  name: string;
  /** 평균 탭 속도(초당). 쿨다운 상한(1000 / PLAYER_COOLDOWN_MS)을 넘을 수 없다 */
  tapsPerSec: number;
  /** 탭 간격의 흔들림 비율. 0.3 이면 ±30% */
  jitter: number;
  /** 유효한 카드(중립 또는 상대 카드)를 고를 확률. 나머지는 아무 카드나 눌러 헛손질한다 */
  accuracy: number;
  /** 유효한 카드 중에서 상대 카드를 뺏는 쪽을 고를 확률 (중립 카드가 있어도) */
  stealBias: number;
}

export interface NpcConfig {
  tiers: NpcTier[];
  /** 사람이 준비를 누른 뒤 NPC 가 준비를 누르기까지의 지연 범위(ms) */
  READY_DELAY_MS: [number, number];
  /** 라운드 시작 후 첫 탭까지의 반응 지연 범위(ms) */
  FIRST_TAP_DELAY_MS: [number, number];
  /**
   * 예약된 탭 시각이 현재보다 이만큼 이상 뒤처져 있으면 밀린 탭을 버리고 현재로 맞춘다(ms).
   * 탭이 백그라운드로 갔다 돌아왔을 때 NPC 가 밀린 탭을 한꺼번에 쏟아내는 것을 막는다.
   */
  MAX_BACKLOG_MS: number;
  /** NPC 모드에서의 카드 존 방식. 'full' = 카드 전체가 사람 영역, 'split' = 2인 모드와 동일 */
  NPC_ZONE_MODE: ZoneMode;
}

export interface OnlineConfig {
  /** 끊긴 뒤 재접속을 시도하는 시간(ms). 서버 GameRules.reconnectGraceMs 와 같아야 한다 */
  RECONNECT_GRACE_MS: number;
  /** 재접속 시도 간격(ms) */
  RETRY_INTERVAL_MS: number;
  /** 서버 주소를 입력하지 않았을 때: <현재 호스트>:<포트><경로> */
  DEFAULT_PORT: number;
  DEFAULT_PATH: string;
}

export interface UiConfig {
  /** 카드 뒤집기 연출 길이(ms). 순수 시각 효과이며 상태를 블로킹하지 않는다 */
  FLIP_ANIM_MS: number;
  /** 파울 표시 유지 시간(ms) */
  FOUL_FLASH_MS: number;
  /** 남은 시간이 이 값 이하가 되면 타이머를 경고색으로 표시(ms) */
  TIMER_WARN_MS: number;
  /** 마지막 시작 설정을 저장하는 localStorage 키 */
  OPTIONS_STORAGE_KEY: string;
  /** 싱글플레이 개인 최고기록을 저장하는 localStorage 키 (서버 없음, 이 기기 안에서만) */
  RECORDS_STORAGE_KEY: string;
  /** 저장할 최고기록 최대 개수. 넘으면 순위 낮은 것부터 버린다 */
  MAX_RECORDS: number;
  /** 음소거/모션 감소 설정을 저장하는 localStorage 키 */
  SETTINGS_STORAGE_KEY: string;
}

export interface DebugConfig {
  /** true 이면 마우스 입력도 유효 판정에 포함한다. URL ?debug=mouse 로만 켠다 */
  allowMouse: boolean;
  /** 입력 필터 통계 패널 표시 */
  showInputStats: boolean;
}

export interface GameConfig {
  board: BoardConfig;
  device: Record<DeviceMode, DeviceProfile>;
  input: InputConfig;
  match: MatchConfig;
  npc: NpcConfig;
  online: OnlineConfig;
  ui: UiConfig;
  debug: DebugConfig;
}

export const CONFIG: GameConfig = {
  board: {
    COLS: 5,
    ROWS: 5,
    CARD_COUNT: 25,
    NEUTRAL_BAND_RATIO: 0.16,
  },
  device: {
    tablet: { CARD_PHYSICAL_SIZE_MM: 16, CARD_GAP_MM: 2.4 },
    phone: { CARD_PHYSICAL_SIZE_MM: 13, CARD_GAP_MM: 1.8 },
  },
  input: {
    MAX_POINTERS_PER_PLAYER: 2,
    PLAYER_COOLDOWN_MS: 50,
    CARD_LOCKOUT_MS: 200,
    MAX_TOUCH_SIZE_PX: 40,
    ALLOWED_POINTER_TYPES: ['touch'],
    POINTER_STALE_MS: 2_000,
  },
  match: {
    ROUND_DURATION_OPTIONS_MS: [30_000, 60_000, 120_000],
    ROUND_DURATION_MS: 30_000,
    COUNTDOWN_MS: 3_000,
    ROUNDS_TO_WIN: 2,
    MAX_ROUNDS: 3,
    FALSE_START_PENALTY_MS: 500,
    STACK_FALSE_START_PENALTY: false,
  },
  npc: {
    tiers: [
      { id: 1, name: '입문', tapsPerSec: 1.5, jitter: 0.5, accuracy: 0.55, stealBias: 0.2 },
      { id: 2, name: '보통', tapsPerSec: 2.5, jitter: 0.4, accuracy: 0.7, stealBias: 0.4 },
      { id: 3, name: '숙련', tapsPerSec: 4.0, jitter: 0.3, accuracy: 0.82, stealBias: 0.6 },
      { id: 4, name: '고수', tapsPerSec: 6.0, jitter: 0.25, accuracy: 0.92, stealBias: 0.75 },
      { id: 5, name: '괴물', tapsPerSec: 9.0, jitter: 0.15, accuracy: 0.98, stealBias: 0.9 },
    ],
    READY_DELAY_MS: [300, 800],
    FIRST_TAP_DELAY_MS: [150, 450],
    MAX_BACKLOG_MS: 400,
    NPC_ZONE_MODE: 'full',
  },
  online: {
    RECONNECT_GRACE_MS: 5_000,
    RETRY_INTERVAL_MS: 700,
    DEFAULT_PORT: 8080,
    DEFAULT_PATH: '/ws',
  },
  ui: {
    FLIP_ANIM_MS: 170,
    FOUL_FLASH_MS: 1_200,
    TIMER_WARN_MS: 5_000,
    OPTIONS_STORAGE_KEY: 'touch-flip:options',
    RECORDS_STORAGE_KEY: 'touch-flip:records',
    MAX_RECORDS: 20,
    SETTINGS_STORAGE_KEY: 'touch-flip:settings',
  },
  debug: {
    allowMouse: false,
    showInputStats: false,
  },
};
