import type { GameConfig, ZoneMode } from '../config';
import type { PlayerId } from '../core/types';
import type { CardHit, HitTester } from '../input/HitTester';

interface CardRect {
  cardIndex: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  height: number;
}

/**
 * 카드 DOM 의 실제 위치를 캐시해 좌표 → 카드/존 판정을 수행한다.
 *
 * elementFromPoint 를 쓰지 않는 이유: 히트 테스트가 렌더링 트리 상태에 의존하게 되고,
 * 애니메이션 중인 요소가 잡히는 등 프레임에 따라 결과가 흔들릴 수 있다.
 * 사각형 캐시는 프레임과 무관하게 항상 같은 답을 준다.
 */
export class BoardGeometry implements HitTester {
  private rects: CardRect[] = [];
  /** 마지막 측정 당시 보드의 위치. 탭마다 비교해 어긋나면 다시 잰다 */
  private measuredLeft = NaN;
  private measuredTop = NaN;
  private readonly cfg: GameConfig;
  private readonly cards: HTMLElement[];
  private readonly board: HTMLElement;
  private observer: ResizeObserver | null = null;
  private zoneMode: ZoneMode;
  /** 'full' 존 모드에서 카드 전체를 차지하는 플레이어 (사람) */
  private readonly fullZoneOwner: PlayerId;

  constructor(
    cfg: GameConfig,
    cards: HTMLElement[],
    board: HTMLElement,
    zoneMode: ZoneMode = 'split',
    fullZoneOwner: PlayerId = 1,
  ) {
    this.cfg = cfg;
    this.cards = cards;
    this.board = board;
    this.zoneMode = zoneMode;
    this.fullZoneOwner = fullZoneOwner;
  }

  setZoneMode(mode: ZoneMode): void {
    this.zoneMode = mode;
  }

  measure(): void {
    const boardRect = this.board.getBoundingClientRect();
    this.measuredLeft = boardRect.left;
    this.measuredTop = boardRect.top;
    this.rects = this.cards.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        cardIndex: Number(el.dataset['card'] ?? '-1'),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        height: r.height,
      };
    });
  }

  /** 화면 크기 변화, 방향 전환, 스크롤에 맞춰 캐시를 갱신한다 */
  observe(): () => void {
    const remeasure = (): void => this.measure();
    this.observer = new ResizeObserver(remeasure);
    this.observer.observe(this.board);
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    window.addEventListener('scroll', remeasure, { passive: true });
    this.measure();

    return () => {
      this.observer?.disconnect();
      this.observer = null;
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('orientationchange', remeasure);
      window.removeEventListener('scroll', remeasure);
    };
  }

  hitTest(clientX: number, clientY: number): CardHit | null {
    // ResizeObserver 는 보드의 크기 변화만 알려주고 위치 이동(HUD 높이 변화 등)은 알려주지 않는다.
    // 캐시가 실제와 몇 px 어긋나면 중립 띠 판정이 통째로 밀리므로, 탭마다 보드 위치를 확인한다.
    // getBoundingClientRect 한 번은 탭 한 번당 비용으로 무시할 수 있다.
    const boardRect = this.board.getBoundingClientRect();
    if (boardRect.left !== this.measuredLeft || boardRect.top !== this.measuredTop) this.measure();

    for (const rect of this.rects) {
      if (clientX < rect.left || clientX >= rect.right) continue;
      if (clientY < rect.top || clientY >= rect.bottom) continue;
      if (rect.height <= 0) return null;

      // NPC 모드: 상대가 화면 밖에 있으므로 카드를 나눌 이유가 없다. 어디를 눌러도 사람 것
      if (this.zoneMode === 'full') return { cardIndex: rect.cardIndex, playerId: this.fullZoneOwner };

      const ratio = (clientY - rect.top) / rect.height;
      const halfBand = this.cfg.board.NEUTRAL_BAND_RATIO / 2;
      // 카드 중앙의 중립 띠 — 오터치 방지용. 여기를 누르면 아무 일도 일어나지 않는다.
      if (Math.abs(ratio - 0.5) < halfBand) return null;

      const playerId: PlayerId = ratio < 0.5 ? 2 : 1; // 위쪽 = P2, 아래쪽 = P1
      return { cardIndex: rect.cardIndex, playerId };
    }
    return null;
  }
}
