import type { GameConfig } from '../config';
import { rankRecords, type MatchRecord } from '../core/Records';
import type { AppSettings } from '../core/Settings';
import type { MatchOptions, OpponentKind } from '../core/types';
import { RemoteSession } from '../net/RemoteSession';

export interface SetupHandlers {
  /** 2인 로컬 / NPC */
  onStartLocal: (options: MatchOptions) => void;
  /** 온라인. 상대까지 들어와 양쪽이 준비된 세션을 넘긴다 */
  onStartOnline: (options: MatchOptions, session: RemoteSession) => void;
}

type Step = 'device' | 'mode' | 'opponent' | 'npc' | 'time' | 'online';

/**
 * 시작 설정 마법사: 기기 → 싱글/멀티 → (NPC 단계 | 상대 방식) → (온라인 방) → 라운드 시간 → 시작.
 *
 * 싱글플레이(NPC)는 서버가 전혀 필요 없다 — 이 기기만 인터넷에 연결돼 있으면 된다.
 * 멀티플레이(2인 로컬/온라인)만 별도 요구사항이 붙는다(온라인은 서버 필요).
 *
 * 전부 <button> 이라 Tab / Enter 만으로 조작된다. 게임 규칙과는 무관한 순수 UI 계층이다.
 */
export class SetupScreen {
  private readonly cfg: GameConfig;
  private readonly root: HTMLElement;
  private options!: MatchOptions;
  private handlers!: SetupHandlers;
  private records: MatchRecord[] = [];
  private settings: AppSettings = { mute: false, reducedMotion: false };
  private onSettingsChange: (settings: AppSettings) => void = () => {};
  private step: Step = 'device';
  private pendingSession: RemoteSession | null = null;

  constructor(root: HTMLElement, cfg: GameConfig) {
    this.root = root;
    this.cfg = cfg;
  }

  /**
   * records: 싱글플레이 개인 최고기록(이 기기 안에만 저장됨). 없으면 빈 목록.
   * settings/onSettingsChange: 음소거·모션감소. 여기서 바로 켜고 끌 수 있고,
   * 누르는 즉시 onSettingsChange 로 알려 저장 + 실행 중인 세션에 반영한다.
   */
  mount(
    initial: MatchOptions,
    handlers: SetupHandlers,
    records: MatchRecord[] = [],
    settings: AppSettings = { mute: false, reducedMotion: false },
    onSettingsChange: (settings: AppSettings) => void = () => {},
  ): void {
    this.options = { ...initial };
    this.handlers = handlers;
    this.records = records;
    this.settings = { ...settings };
    this.onSettingsChange = onSettingsChange;
    this.step = 'device';
    this.root.dataset['screen'] = 'setup';
    this.render();
  }

  unmount(): void {
    // 로비에서 상대를 기다리던 세션은 게임으로 넘어갔거나 취소된 것이므로 여기서는 끊지 않는다
    this.root.innerHTML = '';
    delete this.root.dataset['screen'];
  }

  /** 로비에서 대기 중이던 연결을 취소한다 (뒤로 가기 / 화면 이탈) */
  cancelPending(): void {
    this.pendingSession?.destroy();
    this.pendingSession = null;
  }

  // ------------------------------------------------------------ 렌더

  private render(): void {
    this.root.dataset['device'] = this.options.deviceMode;
    this.root.innerHTML = '';

    const page = el('div', 'setup');
    page.append(this.buildHeader());

    switch (this.step) {
      case 'device':
        page.append(this.buildDeviceStep());
        break;
      case 'mode':
        page.append(this.buildModeStep());
        break;
      case 'opponent':
        page.append(this.buildOpponentStep());
        break;
      case 'npc':
        page.append(this.buildNpcStep());
        break;
      case 'time':
        page.append(this.buildTimeStep());
        break;
      case 'online':
        page.append(this.buildOnlineStep());
        break;
      default:
        break;
    }

    const hint = el('p', 'setup__hint');
    hint.textContent = '키보드: Tab 이동 · Enter 선택 · Backspace 뒤로';
    page.append(hint);
    this.root.append(page);

    const first = page.querySelector<HTMLElement>('.setup__choice, .setup__start, input');
    first?.focus();
  }

  private buildHeader(): HTMLElement {
    const header = el('header', 'setup__header');
    const title = el('h1', 'setup__title');
    title.textContent = 'Touch Flip';

    const tagline = el('p', 'setup__tagline');
    tagline.textContent = '5x5 카드를 눌러 내 색으로 바꾸는 대전 — 시간이 끝나면 더 많이 가진 쪽이 승리';

    const crumbs = el('div', 'setup__crumbs');
    const parts: string[] = [];
    if (this.step !== 'device') parts.push(deviceLabel(this.options.deviceMode));
    if (this.step !== 'device' && this.step !== 'mode') {
      parts.push(this.options.opponent === 'npc' ? '싱글플레이' : '멀티플레이');
    }
    if ((this.step === 'time' || this.step === 'online') && this.options.opponent !== 'npc') {
      parts.push(opponentLabel(this.options.opponent));
    }
    if (this.step === 'time' && this.options.opponent === 'npc') {
      const tier = this.cfg.npc.tiers.find((t) => t.id === this.options.npcTier);
      if (tier) parts.push(`${tier.id}단계 ${tier.name}`);
    }
    crumbs.textContent = parts.join(' › ');

    header.append(title, tagline, crumbs);
    if (this.step !== 'device') {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'setup__back';
      back.textContent = '← 뒤로';
      back.addEventListener('click', () => this.goBack());
      header.append(back);
    }
    header.append(this.buildSettingsToggles());
    return header;
  }

  /** 음소거 / 모션감소. 누르는 즉시 저장 + 실행 중인 세션에도 반영된다 */
  private buildSettingsToggles(): HTMLElement {
    const row = el('div', 'setup__toggles');

    const sound = document.createElement('button');
    sound.type = 'button';
    sound.className = 'setup__toggle';
    sound.setAttribute('aria-pressed', String(this.settings.mute));
    sound.textContent = this.settings.mute ? '🔇 소리 꺼짐' : '🔊 소리 켜짐';
    sound.addEventListener('click', () => {
      this.settings = { ...this.settings, mute: !this.settings.mute };
      this.onSettingsChange({ ...this.settings });
      this.render();
    });

    const motion = document.createElement('button');
    motion.type = 'button';
    motion.className = 'setup__toggle';
    motion.setAttribute('aria-pressed', String(this.settings.reducedMotion));
    motion.textContent = this.settings.reducedMotion ? '🧘 모션 감소' : '🎬 모션 보통';
    motion.addEventListener('click', () => {
      this.settings = { ...this.settings, reducedMotion: !this.settings.reducedMotion };
      this.onSettingsChange({ ...this.settings });
      this.render();
    });

    row.append(sound, motion);
    return row;
  }

  private buildDeviceStep(): HTMLElement {
    const section = this.section('어떤 기기로 하나요?');
    section.append(
      this.choice('태블릿', `카드 ${this.cfg.device.tablet.CARD_PHYSICAL_SIZE_MM}mm · 마주 앉아 2인 대전에 적합`, () => {
        this.options.deviceMode = 'tablet';
        this.go('mode');
      }),
      this.choice('폰', `카드 ${this.cfg.device.phone.CARD_PHYSICAL_SIZE_MM}mm · 한 손 화면, 싱글·온라인에 적합`, () => {
        this.options.deviceMode = 'phone';
        this.go('mode');
      }),
      this.choice('컴퓨터', `카드 ${this.cfg.device.computer.CARD_PHYSICAL_SIZE_MM}mm · 마우스로 플레이, 터치스크린 없어도 됨`, () => {
        this.options.deviceMode = 'computer';
        this.go('mode');
      }),
    );
    return section;
  }

  private buildModeStep(): HTMLElement {
    const section = this.section('싱글플레이인가요, 멀티플레이인가요?');
    section.append(
      this.choice('싱글플레이', '혼자서 NPC 와 대전. 이 기기만 인터넷에 연결돼 있으면 됩니다', () => {
        this.options.opponent = 'npc';
        this.go('npc');
      }),
      this.choice('멀티플레이', '다른 사람과 대전 — 한 화면 2인, 또는 기기 2대로 온라인', () => {
        this.go('opponent');
      }),
    );
    return section;
  }

  private buildOpponentStep(): HTMLElement {
    const section = this.section('어떤 멀티플레이인가요?');
    section.append(
      this.choice('2인 로컬', '한 화면에서 마주 앉아 대전', () => {
        this.options.opponent = 'local';
        this.go('time');
      }),
      this.choice('온라인 멀티', '기기 2대, 방 코드로 연결 (같은 Wi-Fi 권장)', () => {
        this.options.opponent = 'online';
        this.go('online');
      }),
    );
    return section;
  }

  private buildNpcStep(): HTMLElement {
    const section = this.section('어떤 NPC 와 하나요?');
    for (const tier of this.cfg.npc.tiers) {
      section.append(
        this.choice(
          `${tier.id}단계 · ${tier.name}`,
          `초당 약 ${tier.tapsPerSec}회 · 정확도 ${Math.round(tier.accuracy * 100)}% · 뺏기 ${Math.round(tier.stealBias * 100)}%`,
          () => {
            this.options.npcTier = tier.id;
            this.go('time');
          },
          tier.id === this.options.npcTier,
        ),
      );
    }
    const records = this.buildRecordsPanel();
    if (records) section.append(records);
    return section;
  }

  /** 개인 최고기록(이 기기 안에만 저장) 상위 5개. 기록이 없으면 아무것도 그리지 않는다 */
  private buildRecordsPanel(): HTMLElement | null {
    const ranked = rankRecords(this.records).slice(0, 5);
    if (ranked.length === 0) return null;

    const panel = el('div', 'setup__records');
    const title = el('h3', 'setup__records-title');
    title.textContent = '내 최고 기록 (이 기기 안에만 저장됨)';
    const list = document.createElement('ol');
    list.className = 'setup__records-list';
    for (const r of ranked) {
      const tier = this.cfg.npc.tiers.find((t) => t.id === r.npcTier);
      const li = document.createElement('li');
      const label = tier ? `${tier.id}단계 ${tier.name}` : `${r.npcTier}단계`;
      li.textContent = `${r.result === 'win' ? '승리' : '패배'} · ${label} · ${r.myRoundWins}:${r.npcRoundWins} · ${formatDuration(r.roundDurationMs)}`;
      list.append(li);
    }
    panel.append(title, list);
    return panel;
  }

  private buildTimeStep(): HTMLElement {
    const section = this.section('라운드 시간');
    section.append(this.timePicker());

    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'setup__start';
    start.textContent = '시작';
    start.addEventListener('click', () => this.handlers.onStartLocal({ ...this.options }));
    section.append(start);
    return section;
  }

  private buildOnlineStep(): HTMLElement {
    const section = this.section('온라인 멀티');

    const urlLabel = el('label', 'setup__field');
    urlLabel.textContent = '서버 주소';
    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'setup__input';
    url.value = this.options.serverUrl || defaultServerUrl(this.cfg);
    url.placeholder = defaultServerUrl(this.cfg);
    url.autocapitalize = 'off';
    url.spellcheck = false;
    urlLabel.append(url);

    const status = el('p', 'setup__status');
    status.hidden = true;

    const create = el('div', 'setup__card');
    const createTitle = el('h3', '');
    createTitle.textContent = '방 만들기';
    create.append(createTitle, this.timePicker());
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'setup__start';
    createBtn.textContent = '방 만들기';
    create.append(createBtn);

    const join = el('div', 'setup__card');
    const joinTitle = el('h3', '');
    joinTitle.textContent = '방 코드로 입장';
    const code = document.createElement('input');
    code.type = 'text';
    code.inputMode = 'numeric';
    code.pattern = '[0-9]{6}';
    code.maxLength = 6;
    code.placeholder = '6자리 코드';
    code.className = 'setup__input setup__input--code';
    code.autocomplete = 'off';
    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'setup__start setup__start--secondary';
    joinBtn.textContent = '입장';
    join.append(joinTitle, code, joinBtn);

    const lobby = el('div', 'lobby');
    lobby.hidden = true;
    const lobbyCode = el('div', 'lobby__code');
    const lobbyText = el('div', 'lobby__text');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'setup__start setup__start--secondary';
    cancel.textContent = '취소';
    lobby.append(lobbyCode, lobbyText, cancel);

    const showStatus = (text: string, isError = false): void => {
      status.hidden = false;
      status.textContent = text;
      status.dataset['error'] = String(isError);
    };

    const connect = (request: { roomCode?: string; roundDurationMs?: number }): void => {
      this.cancelPending();
      this.options.serverUrl = url.value.trim();
      const serverUrl = this.options.serverUrl || defaultServerUrl(this.cfg);
      const options = { ...this.options };

      create.hidden = true;
      join.hidden = true;
      urlLabel.hidden = true;
      lobby.hidden = false;
      lobbyCode.textContent = request.roomCode ?? '······';
      lobbyText.textContent = '서버에 연결하는 중…';
      status.hidden = true;

      const session = new RemoteSession(this.cfg, serverUrl, request, {
        onJoined: ({ roomCode, playerId, roundDurationMs }) => {
          options.roundDurationMs = roundDurationMs;
          lobbyCode.textContent = roomCode;
          lobbyText.textContent = `방 코드 ${roomCode} · 나는 P${playerId} · 상대를 기다리는 중…`;
        },
        onStatus: (s, detail) => {
          if (s === 'ready' && this.pendingSession === session) {
            this.pendingSession = null;
            this.handlers.onStartOnline(options, session);
            return;
          }
          if (s === 'error' || s === 'lost') {
            showStatus(detail ?? '연결 실패', true);
            lobby.hidden = true;
            create.hidden = false;
            join.hidden = false;
            urlLabel.hidden = false;
            session.destroy();
            if (this.pendingSession === session) this.pendingSession = null;
          } else if (s === 'reconnecting') {
            lobbyText.textContent = '연결이 끊겨 다시 연결하는 중…';
          }
        },
        onEvent: () => {
          /* 로비에서는 보드를 그리지 않는다 */
        },
      });
      this.pendingSession = session;
      session.start();
    };

    createBtn.addEventListener('click', () => connect({ roundDurationMs: this.options.roundDurationMs }));
    joinBtn.addEventListener('click', () => {
      const value = code.value.trim();
      if (!/^\d{6}$/.test(value)) {
        showStatus('방 코드는 숫자 6자리입니다', true);
        code.focus();
        return;
      }
      connect({ roomCode: value });
    });
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });
    cancel.addEventListener('click', () => {
      this.cancelPending();
      this.render();
    });

    section.append(urlLabel, status, create, join, lobby);
    return section;
  }

  // ------------------------------------------------------------ 조각

  private timePicker(): HTMLElement {
    const row = el('div', 'setup__times');
    for (const ms of this.cfg.match.ROUND_DURATION_OPTIONS_MS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'setup__time';
      btn.textContent = formatDuration(ms);
      btn.setAttribute('aria-pressed', String(ms === this.options.roundDurationMs));
      btn.addEventListener('click', () => {
        this.options.roundDurationMs = ms;
        for (const sibling of row.querySelectorAll('.setup__time')) {
          sibling.setAttribute('aria-pressed', String(sibling === btn));
        }
      });
      row.append(btn);
    }
    return row;
  }

  private section(question: string): HTMLElement {
    const section = el('section', 'setup__section');
    const h2 = el('h2', 'setup__question');
    h2.textContent = question;
    section.append(h2);
    return section;
  }

  private choice(label: string, hint: string, onPick: () => void, selected = false): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'setup__choice';
    btn.setAttribute('aria-pressed', String(selected));
    const strong = el('span', 'setup__choice-label');
    strong.textContent = label;
    const small = el('span', 'setup__choice-hint');
    small.textContent = hint;
    btn.append(strong, small);
    btn.addEventListener('click', onPick);
    return btn;
  }

  private go(step: Step): void {
    this.step = step;
    this.render();
  }

  goBack(): void {
    this.cancelPending();
    switch (this.step) {
      case 'mode':
        this.go('device');
        break;
      case 'opponent':
        this.go('mode');
        break;
      case 'npc':
        this.go('mode');
        break;
      case 'online':
        this.go('opponent');
        break;
      case 'time':
        this.go(this.options.opponent === 'npc' ? 'npc' : 'opponent');
        break;
      default:
        break;
    }
  }

  get currentStep(): Step {
    return this.step;
  }
}

function deviceLabel(mode: MatchOptions['deviceMode']): string {
  switch (mode) {
    case 'phone':
      return '폰';
    case 'computer':
      return '컴퓨터';
    default:
      return '태블릿';
  }
}

function opponentLabel(kind: OpponentKind): string {
  switch (kind) {
    case 'local':
      return '2인 로컬';
    case 'online':
      return '온라인 멀티';
    case 'npc':
      return 'NPC';
    default:
      return '';
  }
}

export function defaultServerUrl(cfg: GameConfig): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname || 'localhost'}:${cfg.online.DEFAULT_PORT}${cfg.online.DEFAULT_PATH}`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s % 60 === 0) return `${s / 60}분`;
  if (s > 60) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  return `${s}초`;
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
