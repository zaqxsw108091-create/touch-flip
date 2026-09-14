import type { PlayerId } from '../core/types';

export interface CardHit {
  cardIndex: number;
  /** 터치 지점이 카드의 어느 존에 속하는지로 결정된 소유자 후보 */
  playerId: PlayerId;
}

/**
 * 화면 좌표 → 카드/플레이어 변환.
 * 중립 띠, 카드 사이 간격, 보드 바깥은 모두 null 을 돌려준다.
 * InputGovernor 가 DOM 을 직접 뒤지지 않도록 이 인터페이스로 분리한다.
 */
export interface HitTester {
  hitTest(clientX: number, clientY: number): CardHit | null;
}
