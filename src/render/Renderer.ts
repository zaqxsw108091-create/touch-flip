import type { GameConfig, ZoneMode } from '../config';
import type { CardOwner, GameEvent, MatchOptions, PlayerId, Snapshot } from '../core/types';
import type { GovernorStats } from '../input/InputGovernor';

const READY_KEY: Record<PlayerId, string> = { 1: 'F', 2: 'J' };
const PLAYER_COLOR: Record<PlayerId, string> = { 1: '파랑', 2: '분홍' };

export interface RendererOptions {
  match: MatchOptions;
  /** 화면에 표시할 이름. NPC 모드에서는 P2 가 NPC 단계 이름 */
  names: Record<PlayerId, string>;
  zoneMode: ZoneMode;
  /** 아래쪽 HUD 에 놓을 플레이어. 온라인에서 내가 P2 면 2 */
  bottomPlayer?: PlayerId;
  /** 준비 버튼을 눌러 조작할 수 있는 플레이어. 온라인에서는 나 하나 */
  controllable?: PlayerId[];
}

/**
 * GameState 스냅샷을 DOM 에 반영하는 계층.
 *
 * 여기에는 게임 규칙이 없다. 무엇이 보이는지만 결정한다.
 * 카드 뒤집기 연출은 순수 시각 효과이며, 상태는 이미 반영된 뒤에 재생된다.
 */
export class Renderer {
  private readonly cfg: GameConfig;
  private readonly root: HTMLElement;
  private readonly opts: RendererOptions;

  private boardEl!: HTMLElement;
  private overlayEl!: HTMLElement;
  private menuEl!: HTMLButtonElement;
  private pauseEl!: HTMLButtonElement;
  private bannerEl!: HTMLElement;
  private statsEl: HTMLElement | null = null;
  private readonly cards: HTMLElement[] = [];
  private readonly readyButtons = {} as Record<PlayerId, HTMLButtonElement>;
  private readonly scoreEls = {} as Record<PlayerId, HTMLElement>;
  private readonly pipEls = {} as Record<PlayerId, HTMLElement>;
  private readonly timerEls = {} as Record<PlayerId, HTMLElement>;
  private readonly hudEls = {} as Record<PlayerId, HTMLElement>;
  private readonly overlayPanels: HTMLElement[] = [];
  private timerBarEl!: HTMLElement;

  /** cardIndex → slot. orientation 이 바뀌면 다시 계산된다 */
  private slotForCard: number[] = [];
  private prevOwners: CardOwner[] = [];
  private prevOrientation: 0 | 180 = 0;
  private prevRevision = -1;
  private prevTimerText = '';
  private prevCountdownValue = -1;
  private prevPaused = false;
  private reducedMotion = false;
  private boardDirty = true;
  private foulUntil: Record<PlayerId, number> = { 1: 0, 2: 0 };
  private layoutListener: (() => void) | null = null;

  constructor(root: HTMLElement, cfg: GameConfig, opts: RendererOptions) {
    this.root = root;
    this.cfg = cfg;
    this.opts = opts;
  }

  // ------------------------------------------------------------ 마운트

  mount(): void {
    const { COLS, ROWS, CARD_COUNT, NEUTRAL_BAND_RATIO } = this.cfg.board;
    const device = this.cfg.device[this.opts.match.deviceMode];

    // 튜닝 상수는 config 가 유일한 출처다. CSS 에 숫자를 박지 않고 여기서 변수로 내려준다.
    const style = this.root.style;
    style.setProperty('--card-mm', `${device.CARD_PHYSICAL_SIZE_MM}mm`);
    style.setProperty('--gap-mm', `${device.CARD_GAP_MM}mm`);
    style.setProperty('--cols', String(COLS));
    style.setProperty('--rows', String(ROWS));
    style.setProperty('--band-ratio', String(NEUTRAL_BAND_RATIO));
    style.setProperty('--flip-ms', `${this.cfg.ui.FLIP_ANIM_MS}ms`);

    this.root.dataset['device'] = this.opts.match.deviceMode;
    this.root.dataset['opponent'] = this.opts.match.opponent;
    this.root.dataset['zone'] = this.opts.zoneMode;
    this.root.dataset['screen'] = 'game';

    const bottom = this.opts.bottomPlayer ?? 1;
    const top: PlayerId = bottom === 1 ? 2 : 1;
    this.root.dataset['bottom'] = String(bottom);

    this.root.innerHTML = '';
    this.root.append(
      this.buildHud(top),
      this.buildStage(CARD_COUNT),
      this.buildHud(bottom),
      this.buildStatsPanel(),
    );

    this.slotForCard = new Array<number>(CARD_COUNT).fill(0).map((_, i) => i);
    this.prevOwners = new Array<CardOwner>(CARD_COUNT).fill(0);
  }

  unmount(): void {
    this.root.innerHTML = '';
    delete this.root.dataset['device'];
    delete this.root.dataset['opponent'];
    delete this.root.dataset['zone'];
    delete this.root.dataset['phase'];
    delete this.root.dataset['screen'];
    delete this.root.dataset['paused'];
    this.prevPaused = false;
  }

  setLayoutListener(fn: () => void): void {
    this.layoutListener = fn;
  }

  get boardElement(): HTMLElement {
    return this.boardEl;
  }

  get cardElements(): HTMLElement[] {
    return this.cards;
  }

  get menuButton(): HTMLButtonElement {
    return this.menuEl;
  }

  /** 온라인 모드에는 없다 (서버가 시간의 유일한 권위라 클라이언트 혼자 멈출 수 없다) */
  get pauseButton(): HTMLButtonElement {
    return this.pauseEl;
  }

  readyButton(player: PlayerId): HTMLButtonElement {
    return this.readyButtons[player];
  }

  /** 연결 상태 등 한 줄 안내. null 이면 숨긴다 */
  setBanner(text: string | null, tone: 'info' | 'warn' = 'info'): void {
    this.bannerEl.hidden = text === null;
    this.bannerEl.textContent = text ?? '';
    this.bannerEl.dataset['tone'] = tone;
  }

  // ------------------------------------------------------------ 렌더

  /**
   * paused 가 true 면 board/HUD/타이머는 호출자가 넘겨준(정지 시점에 얼린) snapshot 을
   * 그대로 유지하고, 오버레이만 "일시정지" 문구로 덮는다. 실제 게임 상태 자체는
   * main.ts 가 GameState.tick() 호출을 멈춰서 정지시킨다 — 여기서는 화면만 담당한다.
   */
  render(snapshot: Snapshot, now: number, stats?: GovernorStats, paused = false): void {
    if (paused !== this.prevPaused) {
      this.prevPaused = paused;
      this.root.dataset['paused'] = String(paused);
      this.pauseEl.textContent = paused ? '계속' : '일시정지';
      this.pauseEl.setAttribute('aria-pressed', String(paused));
      if (paused) this.setOverlayText('일시정지', '다시 누르면 이어서 진행합니다 (P 또는 버튼)');
    }
    if (paused) {
      if (stats && this.statsEl) this.renderStats(stats);
      return;
    }

    this.renderTimer(snapshot);
    this.renderFoulFlash(now);

    // 카운트다운 숫자는 상태 revision 과 무관하게 시간에 따라 바뀐다
    if (snapshot.phase === 'countdown' && snapshot.countdownValue !== this.prevCountdownValue) {
      this.prevCountdownValue = snapshot.countdownValue;
      this.setOverlayText(String(snapshot.countdownValue), '보드를 건드리면 부정 출발입니다');
    }

    if (stats && this.statsEl) this.renderStats(stats);
    if (snapshot.revision === this.prevRevision) return;
    this.prevRevision = snapshot.revision;

    if (snapshot.orientation !== this.prevOrientation) {
      this.applyOrientation(snapshot.orientation);
    }

    this.renderBoard(snapshot);
    this.renderHud(snapshot);
    this.renderOverlay(snapshot);
    this.root.dataset['phase'] = snapshot.phase;
  }

  /** 상태 변화 이벤트 → 순수 시각 효과. 게임 상태를 되돌리거나 지연시키지 않는다. */
  handleEvent(event: GameEvent, now: number): void {
    switch (event.type) {
      case 'flip': {
        const slot = this.slotForCard[event.cardIndex];
        const el = slot === undefined ? undefined : this.cards[slot];
        if (el) {
          // 색은 render() 에서 즉시 반영되고, 이 애니메이션은 그 위에 얹히는 장식이다.
          el.dataset['owner'] = String(event.owner);
          this.playFlip(el);
        }
        break;
      }
      case 'foul':
        this.foulUntil[event.playerId] = now + this.cfg.ui.FOUL_FLASH_MS;
        this.hudEls[event.playerId].dataset['foul'] = 'true';
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ 내부: 빌드

  private buildHud(player: PlayerId): HTMLElement {
    const isNpc = this.opts.match.opponent === 'npc' && player === 2;
    const controllable = (this.opts.controllable ?? [1, 2]).includes(player);
    const hud = el('section', `hud hud--p${player}`);
    hud.dataset['player'] = String(player);
    hud.setAttribute('aria-label', `${this.opts.names[player]} 정보`);

    const info = el('div', 'hud__info');
    const label = el('div', 'hud__label');
    label.textContent = `${this.opts.names[player]} · ${PLAYER_COLOR[player]}`;
    const score = el('div', 'hud__score');
    score.textContent = '0';
    const pips = el('div', 'hud__pips');
    info.append(label, score, pips);

    const center = el('div', 'hud__center');
    const timer = el('div', 'hud__timer');
    timer.textContent = (this.opts.match.roundDurationMs / 1000).toFixed(1);
    const foul = el('div', 'hud__foul');
    foul.textContent = '부정 출발! 0.5초 정지';
    center.append(timer, foul);

    const ready = document.createElement('button');
    ready.className = 'ready';
    ready.type = 'button';
    ready.setAttribute('aria-pressed', 'false');
    const text = el('span', 'ready__text');
    const key = el('span', 'ready__key');
    if (isNpc) {
      // NPC 는 사람이 준비를 누르면 스스로 준비한다. 버튼은 상태 표시용
      ready.disabled = true;
      text.textContent = 'NPC';
      key.textContent = '자동 준비';
    } else if (!controllable) {
      // 온라인 상대. 상대 기기의 준비 상태를 보여주기만 한다
      ready.disabled = true;
      text.textContent = '상대';
      key.textContent = '준비 대기';
    } else {
      text.textContent = '준비';
      const isOnline = this.opts.match.opponent === 'online';
      key.textContent = `${isOnline ? 'F' : READY_KEY[player]} 키`;
    }
    ready.append(text, key);

    hud.append(info, center, ready);

    this.readyButtons[player] = ready;
    this.scoreEls[player] = score;
    this.pipEls[player] = pips;
    this.timerEls[player] = timer;
    this.hudEls[player] = hud;
    return hud;
  }

  private buildStage(cardCount: number): HTMLElement {
    const stage = el('main', 'stage');

    const board = el('div', 'board');
    board.id = 'board';
    board.dataset['orientation'] = '0';
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-label', '5x5 카드 보드');

    for (let slot = 0; slot < cardCount; slot += 1) {
      const card = el('div', 'card');
      card.dataset['slot'] = String(slot);
      card.dataset['card'] = String(slot);
      card.dataset['owner'] = '0';
      card.append(
        el('div', 'card__face'),
        el('div', 'card__zone card__zone--p2'),
        el('div', 'card__band'),
        el('div', 'card__zone card__zone--p1'),
      );
      board.append(card);
      this.cards.push(card);
    }

    const bar = el('div', 'timerbar');
    bar.style.setProperty('--p', '1');
    this.timerBarEl = bar;

    const overlay = el('div', 'overlay');
    overlay.setAttribute('aria-live', 'polite');
    for (const flipped of [true, false]) {
      const panel = el('div', `overlay__panel${flipped ? ' overlay__panel--flipped' : ''}`);
      panel.append(el('div', 'overlay__big'), el('div', 'overlay__sub'));
      overlay.append(panel);
      this.overlayPanels.push(panel);
    }

    const banner = el('div', 'banner');
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    this.bannerEl = banner;

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'menu-btn';
    menu.textContent = '설정';
    menu.setAttribute('aria-label', '시작 설정으로 돌아가기 (Esc)');
    this.menuEl = menu;

    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'pause-btn';
    pause.textContent = '일시정지';
    pause.setAttribute('aria-pressed', 'false');
    pause.setAttribute('aria-label', '일시정지 (P)');
    // 온라인은 서버가 시간의 유일한 권위라 클라이언트 혼자 멈출 방법이 없다
    pause.hidden = this.opts.match.opponent === 'online';
    this.pauseEl = pause;

    stage.append(bar, board, overlay, banner, menu, pause);
    this.boardEl = board;
    this.overlayEl = overlay;
    return stage;
  }

  private buildStatsPanel(): HTMLElement {
    const panel = el('div', 'stats');
    if (this.cfg.debug.showInputStats) {
      this.statsEl = panel;
    } else {
      panel.hidden = true;
    }
    return panel;
  }

  // ------------------------------------------------------------ 내부: 렌더

  private applyOrientation(orientation: 0 | 180): void {
    const count = this.cfg.board.CARD_COUNT;
    for (let slot = 0; slot < count; slot += 1) {
      // 180도 회전 = 슬롯 순서를 뒤집는 것. CSS transform 으로 돌리면
      // 카드의 상/하 존까지 뒤집혀 "아래쪽 = P1" 규칙이 깨진다.
      const cardIndex = orientation === 180 ? count - 1 - slot : slot;
      const card = this.cards[slot];
      if (!card) continue;
      card.dataset['card'] = String(cardIndex);
      this.slotForCard[cardIndex] = slot;
    }
    this.boardEl.dataset['orientation'] = String(orientation);
    this.prevOrientation = orientation;
    this.boardDirty = true; // 슬롯 매핑이 바뀌었으므로 전체 재도색
    this.layoutListener?.();
  }

  private renderBoard(snapshot: Snapshot): void {
    for (let cardIndex = 0; cardIndex < snapshot.board.length; cardIndex += 1) {
      const owner = snapshot.board[cardIndex] ?? 0;
      if (!this.boardDirty && owner === this.prevOwners[cardIndex]) continue;
      this.prevOwners[cardIndex] = owner;
      const slot = this.slotForCard[cardIndex];
      const card = slot === undefined ? undefined : this.cards[slot];
      if (card) card.dataset['owner'] = String(owner);
    }
    this.boardDirty = false;
  }

  private renderHud(snapshot: Snapshot): void {
    for (const player of [1, 2] as PlayerId[]) {
      this.scoreEls[player].textContent = String(snapshot.counts[player]);
      this.pipEls[player].textContent = pips(snapshot.roundWins[player], this.cfg.match.ROUNDS_TO_WIN);
      this.readyButtons[player].setAttribute('aria-pressed', String(snapshot.ready[player]));
      this.readyButtons[player].dataset['held'] = String(snapshot.ready[player]);
      this.hudEls[player].dataset['leading'] = String(
        snapshot.counts[player] > snapshot.counts[other(player)],
      );
    }
  }

  private renderTimer(snapshot: Snapshot): void {
    const total =
      snapshot.phase === 'countdown' ? this.cfg.match.COUNTDOWN_MS : snapshot.roundDurationMs;
    const remaining = snapshot.remainingMs;
    const text = (remaining / 1000).toFixed(1);
    if (text !== this.prevTimerText) {
      this.prevTimerText = text;
      this.timerEls[1].textContent = text;
      this.timerEls[2].textContent = text;
    }
    this.timerBarEl.style.setProperty('--p', String(total > 0 ? remaining / total : 0));
    this.timerBarEl.dataset['warn'] = String(
      snapshot.phase === 'playing' && remaining <= this.cfg.ui.TIMER_WARN_MS,
    );
  }

  private renderFoulFlash(now: number): void {
    for (const player of [1, 2] as PlayerId[]) {
      if (this.foulUntil[player] !== 0 && now >= this.foulUntil[player]) {
        this.foulUntil[player] = 0;
        this.hudEls[player].dataset['foul'] = 'false';
      }
    }
  }

  private renderOverlay(snapshot: Snapshot): void {
    const names = this.opts.names;
    const isNpc = this.opts.match.opponent === 'npc';
    switch (snapshot.phase) {
      case 'idle': {
        // 규칙 + 조작 + 시작 방법을 한 화면에서 순서대로 보여준다 (게임 규칙/핵심 조작이
        // 화면에 드러나야 한다는 요구사항 — 문서를 뒤지지 않고 여기서 다 알 수 있어야 한다)
        const rule = '카드를 눌러 내 색으로 바꾸세요. 시간 종료 시 더 많이 가진 쪽이 승리합니다.';
        const start = isNpc
          ? '준비 버튼을 누르고 있으면 NPC 도 준비합니다 (키보드 F 또는 Space)'
          : this.opts.match.opponent === 'online'
            ? '양쪽 기기에서 모두 준비 버튼을 누르고 있으면 시작합니다 (키보드 F)'
            : '양쪽 모두 준비 버튼을 누르고 있으면 시작합니다 (키보드 F / J, 혼자 테스트는 Space)';
        this.setOverlayText('준비', `${rule} · ${start}`);
        break;
      }
      case 'countdown':
        this.setOverlayText(String(snapshot.countdownValue), '보드를 건드리면 부정 출발입니다');
        break;
      case 'playing':
        this.setOverlayText('', '');
        break;
      case 'roundEnd': {
        const r = snapshot.lastRound;
        if (!r) break;
        const title =
          r.winner == null ? `라운드 ${r.round} 무승부` : `라운드 ${r.round} — ${names[r.winner]} 승`;
        const sub =
          `${r.counts[1]} : ${r.counts[2]}` +
          (r.winner == null ? ' · 승수 없이 재경기' : '') +
          ' · 준비를 눌러 다음 라운드';
        this.setOverlayText(title, sub);
        break;
      }
      case 'matchEnd': {
        const winner = snapshot.matchWinner;
        const title = winner ? `${names[winner]} 매치 승리` : '매치 종료';
        const r = snapshot.lastRound;
        // 라운드 전적(2:0)만으로는 마지막 라운드가 몇 장 대 몇 장으로 갈렸는지 알 수 없다.
        // 승부를 가른 마지막 라운드의 실제 카드 스코어를 같이 보여준다.
        const finalScore = r ? ` · 마지막 라운드 ${r.counts[1]}:${r.counts[2]}` : '';
        this.setOverlayText(
          title,
          `라운드 전적 ${snapshot.roundWins[1]}:${snapshot.roundWins[2]}${finalScore} · 준비를 누르거나 R 로 재시작 · Esc 설정`,
        );
        break;
      }
      default:
        break;
    }
    this.overlayEl.dataset['phase'] = snapshot.phase;
  }

  private setOverlayText(big: string, sub: string): void {
    for (const panel of this.overlayPanels) {
      const bigEl = panel.querySelector('.overlay__big');
      const subEl = panel.querySelector('.overlay__sub');
      if (bigEl) bigEl.textContent = big;
      if (subEl) subEl.textContent = sub;
    }
  }

  private renderStats(stats: GovernorStats): void {
    if (!this.statsEl) return;
    const r = stats.rejected;
    this.statsEl.textContent =
      `입력 ${stats.received} · 방출 ${stats.emitted} · 반영 ${stats.accepted} | ` +
      `타입 ${r['pointer-type']} · 크기 ${r['touch-size']} · 중립/바깥 ${r['no-hit']} · ` +
      `포인터초과 ${r['max-pointers']} · 쿨다운 ${r.cooldown} · 락아웃 ${r['card-lockout']} · 상태거부 ${r.state}`;
  }

  /** 앱 설정(모션 감소) 또는 OS 설정(prefers-reduced-motion) 중 하나라도 켜져 있으면 애니메이션을 끈다 */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  private playFlip(card: HTMLElement): void {
    if (this.reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Web Animations API — 클래스 토글 + 강제 리플로우 없이 매번 처음부터 재생된다.
    card.animate(
      [
        { transform: 'rotateX(0deg) scale(1)', filter: 'brightness(1.6)' },
        { transform: 'rotateX(-52deg) scale(0.92)', filter: 'brightness(1.25)' },
        { transform: 'rotateX(0deg) scale(1)', filter: 'brightness(1)' },
      ],
      { duration: this.cfg.ui.FLIP_ANIM_MS, easing: 'ease-out' },
    );
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function other(player: PlayerId): PlayerId {
  return player === 1 ? 2 : 1;
}

function pips(wins: number, needed: number): string {
  let s = '';
  for (let i = 0; i < needed; i += 1) s += i < wins ? '●' : '○';
  return s;
}
