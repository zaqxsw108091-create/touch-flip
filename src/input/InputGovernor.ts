import type { GameConfig, PointerKind } from '../config';
import type { PlayerId, TapEvent, TapResult } from '../core/types';
import type { HitTester } from './HitTester';

/**
 * PointerEvent 중 우리가 실제로 쓰는 필드만 추린 구조.
 * 이 인터페이스 덕분에 jsdom 없이 순수 객체로 유닛 테스트가 가능하다.
 */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  width?: number;
  height?: number;
  /** DOMHighResTimeStamp. rAF 시각이 아니라 이 값으로 판정한다 */
  timeStamp: number;
}

export type RejectCode =
  | 'disabled'
  | 'pointer-type'
  | 'touch-size'
  | 'no-hit'
  | 'max-pointers'
  | 'cooldown'
  | 'card-lockout'
  | 'state';

export interface GovernorOutcome {
  emitted: boolean;
  reject?: RejectCode;
  tap?: TapEvent;
  result?: TapResult;
}

export interface GovernorStats {
  received: number;
  emitted: number;
  accepted: number;
  rejected: Record<RejectCode, number>;
}

const EMPTY_REJECTS = (): Record<RejectCode, number> => ({
  disabled: 0,
  'pointer-type': 0,
  'touch-size': 0,
  'no-hit': 0,
  'max-pointers': 0,
  cooldown: 0,
  'card-lockout': 0,
  state: 0,
});

/**
 * 게임 입력의 유일한 진입점.
 *
 * 게임 로직이 pointer 이벤트를 직접 구독하는 코드가 하나라도 생기면
 * 공정성 보장이 무너지므로, 카드 탭은 반드시 이 클래스를 거친다.
 *
 * 여기서 거르는 것: 포인터 종류 / 접촉 크기 / 동시 포인터 수 / 플레이어 쿨다운 / 카드 락아웃.
 * 여기서 거르지 않는 것: 소유권 규칙, 페이즈, 부정 출발 페널티 — 그것은 GameState 의 몫이다.
 */
export class InputGovernor {
  private readonly cfg: GameConfig;
  private readonly hitTester: HitTester;
  private readonly onTap: (tap: TapEvent) => TapResult;

  private enabled = true;
  /** pointerId → 현재 화면에 닿아 있는 유효 포인터 */
  private readonly activePointers = new Map<number, ActivePointer>();
  private readonly lastTapAt: Record<PlayerId, number> = { 1: -Infinity, 2: -Infinity };
  private readonly cardLockedUntil: number[];

  private boardEl: HTMLElement | null = null;
  private readonly detachers: Array<() => void> = [];
  private readonly readyControls: ReadyControl[] = [];

  readonly stats: GovernorStats = {
    received: 0,
    emitted: 0,
    accepted: 0,
    rejected: EMPTY_REJECTS(),
  };

  constructor(cfg: GameConfig, hitTester: HitTester, onTap: (tap: TapEvent) => TapResult) {
    this.cfg = cfg;
    this.hitTester = hitTester;
    this.onTap = onTap;
    this.cardLockedUntil = new Array<number>(cfg.board.CARD_COUNT).fill(-Infinity);
  }

  // ------------------------------------------------------------ 판정 (DOM 무관)

  /**
   * 포인터 다운 하나를 판정한다. 모든 필터를 통과하면 onTap 으로 방출한다.
   * @param fallbackNow event.timeStamp 가 신뢰할 수 없을 때 쓸 대체 시각
   */
  handlePointerDown(pointer: PointerLike, fallbackNow?: number): GovernorOutcome {
    this.stats.received += 1;

    if (!this.enabled) return this.rejectWith('disabled');

    if (!this.isAllowedPointerType(pointer.pointerType)) return this.rejectWith('pointer-type');

    // 손바닥/팔뚝으로 여러 카드를 한 번에 덮는 것을 막는다.
    // width/height 가 0 으로 오는 브라우저가 있으므로 0 은 '알 수 없음'으로 보고 통과시킨다.
    const size = Math.max(pointer.width ?? 0, pointer.height ?? 0);
    if (size > this.cfg.input.MAX_TOUCH_SIZE_PX) return this.rejectWith('touch-size');

    const hit = this.hitTester.hitTest(pointer.clientX, pointer.clientY);
    if (!hit) return this.rejectWith('no-hit');

    const { cardIndex, playerId } = hit;
    const t = this.normalizeTimestamp(pointer.timeStamp, fallbackNow);

    // pointerup 이 유실된 포인터를 먼저 정리한다.
    // 이게 없으면 이벤트 하나를 놓친 플레이어가 남은 판 내내 입력 불가가 된다.
    this.evictStalePointers(t);

    // 동시 포인터 수 제한. 손가락 5개로 5배 속도를 내는 것을 막는다.
    const existing = this.activePointers.get(pointer.pointerId);
    if (existing) {
      existing.lastSeen = t;
    } else {
      if (this.countPointers(playerId) >= this.cfg.input.MAX_POINTERS_PER_PLAYER) {
        return this.rejectWith('max-pointers');
      }
      this.activePointers.set(pointer.pointerId, { player: playerId, lastSeen: t });
    }

    return this.judge(playerId, cardIndex, t);
  }

  /**
   * 물리 입력이 아닌 탭(NPC)의 진입점.
   *
   * 포인터 종류·접촉 크기·동시 포인터 수는 물리 필터라 적용하지 않지만,
   * 쿨다운과 카드 락아웃은 사람과 똑같이 적용한다. NPC 가 아무리 강해도
   * 사람이 물리적으로 낼 수 있는 상한(1000 / PLAYER_COOLDOWN_MS 탭/초)을 넘지 못한다.
   */
  submitTap(playerId: PlayerId, cardIndex: number, timestamp: number): GovernorOutcome {
    this.stats.received += 1;
    if (!this.enabled) return this.rejectWith('disabled');
    return this.judge(playerId, cardIndex, timestamp);
  }

  /** 쿨다운 → 락아웃 → 방출. 사람과 NPC 가 공유하는 마지막 관문 */
  private judge(playerId: PlayerId, cardIndex: number, t: number): GovernorOutcome {
    if (t - this.lastTapAt[playerId] < this.cfg.input.PLAYER_COOLDOWN_MS) {
      return this.rejectWith('cooldown');
    }

    const lockedUntil = this.cardLockedUntil[cardIndex] ?? -Infinity;
    if (t < lockedUntil) return this.rejectWith('card-lockout');

    const tap: TapEvent = { playerId, cardIndex, timestamp: t };
    const result = this.onTap(tap);

    this.stats.emitted += 1;
    // 필터를 통과한 탭은 GameState 가 거부하더라도 쿨다운을 소모한다.
    // 그렇지 않으면 자기 카드를 연타해 쿨다운을 우회할 수 있다.
    this.lastTapAt[playerId] = t;

    if (result.accepted) {
      this.stats.accepted += 1;
      this.cardLockedUntil[cardIndex] = t + this.cfg.input.CARD_LOCKOUT_MS;
      return { emitted: true, tap, result };
    }

    this.stats.rejected.state += 1;
    return { emitted: true, reject: 'state', tap, result };
  }

  handlePointerUp(pointer: Pick<PointerLike, 'pointerId'>): void {
    this.activePointers.delete(pointer.pointerId);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.activePointers.clear();
  }

  /**
   * 라운드 경계에서 호출. 이전 라운드의 쿨다운/락아웃이 다음 라운드로 새지 않게 한다.
   * activePointers 는 건드리지 않는다. 화면에 실제로 닿아 있는 손가락은 라운드가 바뀌어도 그대로다.
   */
  resetRuntime(): void {
    this.lastTapAt[1] = -Infinity;
    this.lastTapAt[2] = -Infinity;
    this.cardLockedUntil.fill(-Infinity);
  }

  resetStats(): void {
    this.stats.received = 0;
    this.stats.emitted = 0;
    this.stats.accepted = 0;
    Object.assign(this.stats.rejected, EMPTY_REJECTS());
  }

  countPointers(player: PlayerId): number {
    let n = 0;
    for (const entry of this.activePointers.values()) if (entry.player === player) n += 1;
    return n;
  }

  private evictStalePointers(now: number): void {
    const limit = this.cfg.input.POINTER_STALE_MS;
    for (const [id, entry] of this.activePointers) {
      if (now - entry.lastSeen > limit) this.activePointers.delete(id);
    }
  }

  // ------------------------------------------------------------ DOM 연결

  attachBoard(board: HTMLElement): void {
    this.boardEl = board;

    const down = (e: Event): void => {
      const pe = e as PointerEvent;
      e.preventDefault();
      this.handlePointerDown(toPointerLike(pe), performance.now());
    };
    const up = (e: Event): void => {
      this.handlePointerUp({ pointerId: (e as PointerEvent).pointerId });
    };

    board.addEventListener('pointerdown', down, { passive: false });
    // pointerup/cancel 은 보드 밖에서 손을 떼는 경우까지 잡아야 하므로 window 에 건다
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    this.detachers.push(() => {
      board.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    });
  }

  /**
   * 준비 버튼 홀드. 카드 탭이 아니라 UI 조작이므로 공정성 필터(쿨다운/포인터 수)를 적용하지 않고,
   * 마우스·펜도 허용한다. 다만 pointer 이벤트 처리를 이 클래스 밖으로 흘리지 않기 위해 여기 둔다.
   */
  attachReadyControl(
    el: HTMLElement,
    player: PlayerId,
    onChange: (player: PlayerId, held: boolean) => void,
  ): void {
    const control: ReadyControl = { player, onChange, heldPointer: null };
    this.readyControls.push(control);

    const down = (e: Event): void => {
      const pe = e as PointerEvent;
      e.preventDefault();
      if (control.heldPointer !== null) return;
      control.heldPointer = pe.pointerId;
      el.setAttribute('aria-pressed', 'true');
      onChange(player, true);
    };
    const release = (e: Event): void => {
      const pe = e as PointerEvent;
      if (control.heldPointer === null || control.heldPointer !== pe.pointerId) return;
      control.heldPointer = null;
      el.setAttribute('aria-pressed', 'false');
      onChange(player, false);
    };

    el.addEventListener('pointerdown', down, { passive: false });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);

    this.detachers.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('pointerleave', release);
    });
  }

  /**
   * 아직 손가락이 올라가 있는 준비 버튼의 상태를 다시 알린다.
   *
   * GameState 는 라운드가 끝나면 준비 상태를 초기화한다. 그런데 버튼을 계속 누르고 있던
   * 플레이어는 pointerdown 이 이미 지나갔으므로 다시 알릴 기회가 없어, 손을 뗐다 다시
   * 누르기 전까지 영원히 준비되지 않은 상태로 남는다. 그 desync 를 없앤다.
   */
  resyncReady(): void {
    for (const control of this.readyControls) {
      if (control.heldPointer !== null) control.onChange(control.player, true);
    }
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
    this.boardEl = null;
    this.activePointers.clear();
  }

  get attachedBoard(): HTMLElement | null {
    return this.boardEl;
  }

  // ------------------------------------------------------------ 내부

  private isAllowedPointerType(type: string): boolean {
    if (this.cfg.input.ALLOWED_POINTER_TYPES.includes(type as PointerKind)) return true;
    // 데스크톱 개발용 탈출구. URL ?debug=mouse 일 때만 켜지며 배포 기본값은 false 다.
    return this.cfg.debug.allowMouse && type === 'mouse';
  }

  /**
   * 일부 환경에서 timeStamp 가 epoch(ms) 이거나 0 으로 오는 경우가 있다.
   * 그대로 쓰면 쿨다운/락아웃 계산이 통째로 깨지므로 방어한다.
   */
  private normalizeTimestamp(ts: number, fallback?: number): number {
    if (!Number.isFinite(ts) || ts <= 0 || ts > 1e12) {
      return fallback ?? ts;
    }
    return ts;
  }

  private rejectWith(code: RejectCode): GovernorOutcome {
    this.stats.rejected[code] += 1;
    return { emitted: false, reject: code };
  }
}

interface ActivePointer {
  player: PlayerId;
  /** 마지막으로 이 포인터를 본 시각. 오래되면 유실된 것으로 보고 제거한다 */
  lastSeen: number;
}

interface ReadyControl {
  player: PlayerId;
  onChange: (player: PlayerId, held: boolean) => void;
  heldPointer: number | null;
}

function toPointerLike(e: PointerEvent): PointerLike {
  return {
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    clientX: e.clientX,
    clientY: e.clientY,
    width: e.width,
    height: e.height,
    timeStamp: e.timeStamp,
  };
}
