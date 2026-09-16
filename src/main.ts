import './styles.css';
import { CONFIG, type GameConfig } from './config';
import { GameState } from './core/GameState';
import { NpcPlayer } from './core/NpcPlayer';
import { addRecord, parseRecords, type MatchRecord } from './core/Records';
import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from './core/Settings';
import type { MatchOptions, PlayerId } from './core/types';
import { SoundEffects } from './audio/SoundEffects';
import { InputGovernor } from './input/InputGovernor';
import type { RemoteSession } from './net/RemoteSession';
import { BoardGeometry } from './render/BoardGeometry';
import { Renderer } from './render/Renderer';
import { SetupScreen } from './render/SetupScreen';

// ---------------------------------------------------------------- 디버그 플래그
// 배포 기본값은 터치 전용이다. ?debug=mouse 일 때만 마우스를 유효 입력으로 취급한다.
const params = new URLSearchParams(location.search);
const debugMode = params.get('debug');
CONFIG.debug.allowMouse = debugMode === 'mouse' || debugMode === 'all';
CONFIG.debug.showInputStats = debugMode !== null;

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('#app 을 찾을 수 없습니다');
const root: HTMLElement = rootEl;

// ---------------------------------------------------------------- 시작 설정 저장/복원

const DEFAULT_OPTIONS: MatchOptions = {
  deviceMode: 'tablet',
  opponent: 'local',
  npcTier: CONFIG.npc.tiers[0]?.id ?? 1,
  roundDurationMs: CONFIG.match.ROUND_DURATION_MS,
  serverUrl: '',
};

function loadOptions(): MatchOptions {
  try {
    const raw = localStorage.getItem(CONFIG.ui.OPTIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<MatchOptions>;
    const merged: MatchOptions = { ...DEFAULT_OPTIONS, ...parsed };
    // 저장된 값이 현재 config 와 어긋나면 기본값으로 되돌린다
    if (!CONFIG.match.ROUND_DURATION_OPTIONS_MS.includes(merged.roundDurationMs)) {
      merged.roundDurationMs = DEFAULT_OPTIONS.roundDurationMs;
    }
    if (!CONFIG.npc.tiers.some((t) => t.id === merged.npcTier)) merged.npcTier = DEFAULT_OPTIONS.npcTier;
    if (merged.deviceMode !== 'phone' && merged.deviceMode !== 'tablet' && merged.deviceMode !== 'computer') {
      merged.deviceMode = 'tablet';
    }
    if (merged.opponent !== 'npc' && merged.opponent !== 'local' && merged.opponent !== 'online') merged.opponent = 'local';
    if (typeof merged.serverUrl !== 'string') merged.serverUrl = '';
    return merged;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function saveOptions(options: MatchOptions): void {
  try {
    localStorage.setItem(CONFIG.ui.OPTIONS_STORAGE_KEY, JSON.stringify(options));
  } catch {
    /* 저장이 안 돼도 게임은 된다 */
  }
}

// ---------------------------------------------------------------- 싱글플레이 개인 최고기록
// 서버 없음. 이 기기의 localStorage 에만 남는다. loadOptions() 와 같은 방어 패턴:
// 값이 비어있거나 손상돼도 게임은 절대 멈추지 않고 빈 기록으로 시작한다.

function loadRecords(): MatchRecord[] {
  try {
    return parseRecords(localStorage.getItem(CONFIG.ui.RECORDS_STORAGE_KEY));
  } catch {
    return [];
  }
}

function saveRecords(records: MatchRecord[]): void {
  try {
    localStorage.setItem(CONFIG.ui.RECORDS_STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* 저장이 안 돼도 게임은 된다 */
  }
}

/** NPC 매치가 끝날 때마다 호출. 온라인/2인 로컬에서는 부르지 않는다(개인 기록은 싱글플레이 전용) */
function recordNpcMatch(npcTier: number, roundDurationMs: number, winner: PlayerId, roundWins: Record<PlayerId, number>): void {
  const record: MatchRecord = {
    npcTier,
    roundDurationMs,
    result: winner === 1 ? 'win' : 'loss',
    myRoundWins: roundWins[1],
    npcRoundWins: roundWins[2],
    at: Date.now(),
  };
  saveRecords(addRecord(loadRecords(), record, CONFIG.ui.MAX_RECORDS));
}

// ---------------------------------------------------------------- 음소거 / 모션 감소
// loadOptions() 와 같은 방어 패턴: 손상되거나 비어 있어도 항상 기본값으로 시작한다.

function loadSettings(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(CONFIG.ui.SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(CONFIG.ui.SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 저장이 안 돼도 게임은 된다 */
  }
}

let currentSettings: AppSettings = loadSettings();
const sound = new SoundEffects();
sound.setMuted(currentSettings.mute);

/** 설정 화면에서 토글을 누르는 즉시 호출된다 — 저장하고, 지금 실행 중인 세션에도 곧바로 반영한다 */
function applySettings(next: AppSettings): void {
  currentSettings = next;
  saveSettings(next);
  sound.setMuted(next.mute);
  session?.renderer.setReducedMotion(next.reducedMotion);
}

// ---------------------------------------------------------------- 게임 세션

/** 한 판의 조립체. 설정 화면으로 돌아가면 통째로 버리고 다시 만든다. */
interface Session {
  options: MatchOptions;
  /** 로컬/NPC 세션에만 있다. 온라인은 서버가 상태를 소유한다 */
  state: GameState | null;
  remote: RemoteSession | null;
  governor: InputGovernor;
  geometry: BoardGeometry;
  renderer: Renderer;
  npc: NpcPlayer | null;
  /** 이 기기에서 조작하는 플레이어 */
  controllable: PlayerId[];
  setReady: (player: PlayerId, held: boolean) => void;
  /** 온라인은 지원하지 않는다(서버가 시간의 유일한 권위) — 그런 세션은 항상 no-op */
  setPaused: (paused: boolean, now: number) => void;
  isPaused: () => boolean;
  step: (now: number) => void;
  destroy: () => void;
}

let session: Session | null = null;
const setup = new SetupScreen(root, CONFIG);

/** 라운드가 끝나 준비 상태가 초기화되면, 아직 눌려 있는 준비 입력을 다음 프레임에 다시 반영한다 */
let needsReadyResync = false;
const heldKeys = new Set<string>();

/**
 * 기기로 "컴퓨터"를 고르면 마우스도 정식 입력으로 허용한다.
 *
 * 원래 마우스는 터치 전용 공정성 때문에 `?debug=mouse` 로만 켜지는 개발자용 우회로였다.
 * 하지만 터치스크린이 없는 일반 PC/노트북에서도 이 게임을 플레이할 수 있어야 하므로,
 * "컴퓨터" 기기를 명시적으로 고른 경우에는 이걸 숨겨진 우회로가 아니라 정식 기능으로 켠다.
 * CONFIG 자체는 건드리지 않고, 이 세션에서만 쓸 얕은 복사본을 만든다.
 */
function effectiveConfigFor(options: MatchOptions): GameConfig {
  if (options.deviceMode !== 'computer') return CONFIG;
  if (CONFIG.input.ALLOWED_POINTER_TYPES.includes('mouse')) return CONFIG; // ?debug=mouse 등으로 이미 허용됨
  return {
    ...CONFIG,
    input: { ...CONFIG.input, ALLOWED_POINTER_TYPES: [...CONFIG.input.ALLOWED_POINTER_TYPES, 'mouse'] },
  };
}

function createSession(options: MatchOptions): Session {
  const cfg = effectiveConfigFor(options);
  const isNpc = options.opponent === 'npc';
  const tier = cfg.npc.tiers.find((t) => t.id === options.npcTier) ?? cfg.npc.tiers[0];
  if (isNpc && !tier) throw new Error('NPC 단계가 config 에 하나도 없습니다');

  const zoneMode = isNpc ? cfg.npc.NPC_ZONE_MODE : 'split';
  const names: Record<PlayerId, string> = {
    1: '플레이어 1',
    2: isNpc && tier ? `NPC ${tier.name}` : '플레이어 2',
  };

  const state = new GameState(cfg, { roundDurationMs: options.roundDurationMs });
  const renderer = new Renderer(root, cfg, { match: options, names, zoneMode });
  renderer.mount();
  renderer.setReducedMotion(currentSettings.reducedMotion);

  const geometry = new BoardGeometry(cfg, renderer.cardElements, renderer.boardElement, zoneMode, 1);
  const governor = new InputGovernor(cfg, geometry, (tap) => state.applyTap(tap));
  const stopObserving = geometry.observe();
  renderer.setLayoutListener(() => geometry.measure());

  governor.attachBoard(renderer.boardElement);
  governor.attachReadyControl(renderer.readyButton(1), 1, setReady);
  if (!isNpc) governor.attachReadyControl(renderer.readyButton(2), 2, setReady);

  const npc = isNpc && tier ? new NpcPlayer(cfg, tier, 2) : null;

  // ------------------------------------------------------------ 일시정지
  // GameState 는 시간을 스스로 재지 않으므로, 정지 동안 tick()/applyTap() 을 아예
  // 호출하지 않다가 재개 시 실제 정지 시간만큼 extendDeadlines() 로 보정한다.
  // 화면은 정지 시점의 snapshot 을 그대로 얼려서 보여준다 (renderer 의 paused=true 경로).
  let paused = false;
  let pausedAt = 0;
  let frozenSnapshot: ReturnType<typeof state.snapshot> | null = null;

  const setPaused = (next: boolean, now: number): void => {
    if (next === paused) return;
    if (next && state.phase !== 'countdown' && state.phase !== 'playing') return; // 멈출 게 없다
    paused = next;
    if (next) {
      pausedAt = now;
      frozenSnapshot = state.snapshot(now);
      governor.setEnabled(false);
    } else {
      state.extendDeadlines(now - pausedAt);
      frozenSnapshot = null;
      governor.setEnabled(true);
    }
  };

  const unsubscribe = state.subscribe((event) => {
    renderer.handleEvent(event, performance.now());
    if (event.type === 'foul') sound.playFoul();
    if (event.type === 'matchEnd') {
      sound.play(event.winner === 1 ? 'win' : 'loss');
      if (isNpc && tier) {
        const snap = state.snapshot(performance.now());
        recordNpcMatch(tier.id, options.roundDurationMs, event.winner, snap.roundWins);
      }
    }
    if (event.type !== 'phase') return;
    if (event.phase === 'playing' && event.previous === 'countdown') sound.playCountdownGo();
    // 라운드가 새로 시작될 때 이전 라운드의 쿨다운/락아웃 잔재를 지운다
    if (event.phase === 'countdown' || event.phase === 'playing') governor.resetRuntime();
    if (event.phase === 'roundEnd' || event.phase === 'matchEnd') needsReadyResync = true;
  });

  const onMenu = (): void => showSetup();
  renderer.menuButton.addEventListener('click', onMenu);

  const onPauseClick = (): void => setPaused(!paused, performance.now());
  renderer.pauseButton.addEventListener('click', onPauseClick);

  // 3·2·1 은 discrete 이벤트가 없다 — 화면에 보이는 숫자가 바뀌는 순간을 직접 감지해 한 번만 울린다
  let prevCountdownTick = 0;

  const step = (now: number): void => {
    if (paused) {
      renderer.render(frozenSnapshot ?? state.snapshot(now), now, governor.stats, true);
      return;
    }
    if (needsReadyResync) {
      // 상태 변경 리스너 안에서 곧바로 되먹임하지 않고 다음 프레임에 처리한다
      needsReadyResync = false;
      governor.resyncReady();
      applyHeldKeys();
    }
    state.tick(now);

    if (npc) {
      // NPC 의 탭 timestamp 는 예약 시각이며, 사람과 같은 관문(쿨다운·락아웃)을 지난다
      for (const action of npc.update(state.snapshot(now), now)) {
        if (action.kind === 'ready') state.setReady(npc.playerId, action.held, now);
        else governor.submitTap(npc.playerId, action.cardIndex, action.timestamp);
      }
    }

    const snap = state.snapshot(now);
    if (snap.phase === 'countdown') {
      if (snap.countdownValue !== prevCountdownTick) {
        prevCountdownTick = snap.countdownValue;
        sound.playCountdownTick();
      }
    } else if (prevCountdownTick !== 0) {
      prevCountdownTick = 0;
    }

    renderer.render(snap, now, governor.stats);
  };

  const destroy = (): void => {
    unsubscribe();
    stopObserving();
    governor.detach();
    renderer.menuButton.removeEventListener('click', onMenu);
    renderer.pauseButton.removeEventListener('click', onPauseClick);
    renderer.unmount();
    needsReadyResync = false;
  };

  const controllable: PlayerId[] = isNpc ? [1] : [1, 2];
  return {
    options,
    state,
    remote: null,
    governor,
    geometry,
    renderer,
    npc,
    controllable,
    setReady: (player, held) => state.setReady(player, held, performance.now()),
    setPaused,
    isPaused: () => paused,
    step,
    destroy,
  };
}

/** 온라인 세션. GameState 없이 서버 스냅샷만 그린다. 입력은 여전히 InputGovernor 를 거쳐 서버로 간다. */
function createOnlineSession(options: MatchOptions, remote: RemoteSession): Session {
  const cfg = effectiveConfigFor(options);
  const me = remote.me ?? 1;
  const other: PlayerId = me === 1 ? 2 : 1;
  const names = { 1: '', 2: '' } as Record<PlayerId, string>;
  names[me] = '나';
  names[other] = '상대';

  const renderer = new Renderer(root, cfg, {
    match: options,
    names,
    zoneMode: 'full',
    bottomPlayer: me,
    controllable: [me],
  });
  renderer.mount();
  renderer.setReducedMotion(currentSettings.reducedMotion);

  const geometry = new BoardGeometry(cfg, renderer.cardElements, renderer.boardElement, 'full', me);
  const governor = new InputGovernor(cfg, geometry, (tap) => remote.submitTap(tap));
  const stopObserving = geometry.observe();
  renderer.setLayoutListener(() => geometry.measure());

  governor.attachBoard(renderer.boardElement);
  governor.attachReadyControl(renderer.readyButton(me), me, (_p, held) => remote.setReady(held));

  remote.rebind({
    onJoined: () => {
      /* 재접속 완료. state 가 곧 따라온다 */
    },
    onStatus: (status, detail) => {
      switch (status) {
        case 'ready':
          renderer.setBanner(null);
          break;
        case 'waiting':
        case 'opponentLeft':
          renderer.setBanner(detail ?? '상대를 기다리는 중…', 'warn');
          break;
        case 'reconnecting':
          renderer.setBanner('연결이 끊겨 다시 연결하는 중…', 'warn');
          break;
        case 'lost':
        case 'error':
          renderer.setBanner(detail ?? '연결이 끊겼습니다. Esc 로 설정으로 돌아가세요', 'warn');
          break;
        default:
          break;
      }
    },
    onEvent: (event) => {
      renderer.handleEvent(event, performance.now());
      if (event.type === 'foul') sound.playFoul();
      if (event.type === 'matchEnd') sound.play(event.winner === me ? 'win' : 'loss');
      if (event.type !== 'phase') return;
      if (event.phase === 'playing' && event.previous === 'countdown') sound.playCountdownGo();
      if (event.phase === 'countdown' || event.phase === 'playing') governor.resetRuntime();
      if (event.phase === 'roundEnd' || event.phase === 'matchEnd') needsReadyResync = true;
    },
  });

  const onMenu = (): void => showSetup();
  renderer.menuButton.addEventListener('click', onMenu);

  // 3·2·1 은 discrete 이벤트가 없다 — 화면에 보이는 숫자가 바뀌는 순간을 직접 감지해 한 번만 울린다
  let prevCountdownTick = 0;

  const step = (now: number): void => {
    if (needsReadyResync) {
      needsReadyResync = false;
      governor.resyncReady();
      applyHeldKeys();
    }
    const snap = remote.snapshot(now);
    if (snap.phase === 'countdown') {
      if (snap.countdownValue !== prevCountdownTick) {
        prevCountdownTick = snap.countdownValue;
        sound.playCountdownTick();
      }
    } else if (prevCountdownTick !== 0) {
      prevCountdownTick = 0;
    }
    renderer.render(snap, now, governor.stats);
  };

  const destroy = (): void => {
    stopObserving();
    governor.detach();
    renderer.menuButton.removeEventListener('click', onMenu);
    renderer.unmount();
    remote.destroy();
    needsReadyResync = false;
  };

  return {
    options,
    state: null,
    remote,
    governor,
    geometry,
    renderer,
    npc: null,
    controllable: [me],
    setReady: (player, held) => {
      if (player === me) remote.setReady(held);
    },
    setPaused: () => {
      /* 온라인은 서버가 시간의 유일한 권위라 클라이언트 혼자 멈출 수 없다 */
    },
    isPaused: () => false,
    step,
    destroy,
  };
}

function startGame(options: MatchOptions): void {
  saveOptions(options);
  session?.destroy();
  setup.unmount();
  session = createSession(options);
  session.step(performance.now());
  exposeDebug();
}

function startOnlineGame(options: MatchOptions, remote: RemoteSession): void {
  saveOptions(options);
  session?.destroy();
  setup.unmount();
  session = createOnlineSession(options, remote);
  session.step(performance.now());
  exposeDebug();
}

function showSetup(): void {
  const last = session?.options ?? loadOptions();
  session?.destroy();
  session = null;
  heldKeys.clear();
  setup.mount(last, { onStartLocal: startGame, onStartOnline: startOnlineGame }, loadRecords(), currentSettings, applySettings);
  exposeDebug();
}

function setReady(player: PlayerId, held: boolean): void {
  if (session?.isPaused()) return; // 정지 중에는 준비 홀드를 놓아도 카운트다운이 취소되면 안 된다
  session?.setReady(player, held);
}

/** 키보드 홀드 → 준비. F = 이 기기의 첫 번째 플레이어, J = 두 번째(로컬 2인만), Space = 조작 가능한 전원 */
function applyHeldKeys(): void {
  if (!session) return;
  const [first, second] = session.controllable;
  for (const key of heldKeys) {
    if (key === 'f' && first !== undefined) setReady(first, true);
    else if (key === 'j' && second !== undefined) setReady(second, true);
    else if (key === ' ') for (const p of session.controllable) setReady(p, true);
  }
}

// ---------------------------------------------------------------- 키보드 조작
// 접근성 요구사항: 준비 / 시작 / 재시작이 키보드만으로 가능해야 한다.
// F = P1 준비 홀드, J = P2 준비 홀드, Space = 양쪽 동시 홀드(혼자 테스트용), R = 재시작, Esc = 설정

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (!session) {
    // 설정 화면: Backspace = 뒤로 (입력창 안에서는 글자 지우기)
    if (key === 'backspace' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      setup.goBack();
    }
    return;
  }
  if (e.repeat) return;

  if (key === 'escape') {
    showSetup();
    return;
  }
  if (key === 'r' && session.state) {
    // 온라인은 서버가 권위라 로컬에서 재시작할 수 없다
    session.state.resetMatch(performance.now());
    session.npc?.reset();
    session.setPaused(false, performance.now()); // 재시작했는데 정지 상태로 남지 않게
    return;
  }
  if (key === 'p') {
    // 온라인 세션은 setPaused 가 no-op 이라 아무 일도 없다
    session.setPaused(!session.isPaused(), performance.now());
    return;
  }
  if (key !== 'f' && key !== 'j' && key !== ' ') return;

  const [first, second] = session.controllable;
  if (key === 'j' && second === undefined) return;

  e.preventDefault();
  if (heldKeys.has(key)) return;
  heldKeys.add(key);

  if (key === 'f' && first !== undefined) setReady(first, true);
  else if (key === 'j' && second !== undefined) setReady(second, true);
  else if (key === ' ') for (const p of session.controllable) setReady(p, true);
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (!heldKeys.delete(key)) return;
  if (!session) return;

  const [first, second] = session.controllable;
  if (key === 'f' && first !== undefined) setReady(first, false);
  else if (key === 'j' && second !== undefined) setReady(second, false);
  else if (key === ' ') for (const p of session.controllable) setReady(p, false);
});

// 창에서 포커스가 빠지면 누르고 있던 키가 영원히 눌린 상태로 남는다
window.addEventListener('blur', () => {
  heldKeys.clear();
  if (!session) return;
  for (const p of session.controllable) setReady(p, false);
});

// ---------------------------------------------------------------- 브라우저 기본 제스처 차단
// 더블탭 확대 / 스크롤 / 컨텍스트 메뉴 / iOS 핀치줌을 모두 막는다.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    // 설정 화면은 세로로 길 수 있어 스크롤을 허용한다. 게임 화면만 막는다.
    if (session && e.cancelable) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('selectstart', (e) => {
  if (session) e.preventDefault();
});

// ---------------------------------------------------------------- 메인 루프
// rAF 는 화면 갱신과 페이즈 전이만 구동한다. 탭 판정 시각은 event.timeStamp 이며
// 이 루프의 주기와 무관하다. (120Hz 기기가 유리해지면 안 된다)
function frame(now: number): void {
  session?.step(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

showSetup();

// ---------------------------------------------------------------- 디버그 노출
// ?debug 로 들어왔을 때만 콘솔에서 내부 상태를 들여다볼 수 있게 노출한다.
// 배포 기본 경로에서는 아무것도 전역에 남기지 않는다.
function exposeDebug(): void {
  if (debugMode === null) return;
  (window as unknown as Record<string, unknown>)['__touchFlip'] = {
    config: CONFIG,
    sound,
    get settings() {
      return currentSettings;
    },
    get session() {
      return session;
    },
    startGame,
    showSetup,
    get state() {
      return session?.state;
    },
    get governor() {
      return session?.governor;
    },
    get npc() {
      return session?.npc;
    },
    get remote() {
      return session?.remote;
    },
    setup,
    step: (now: number) => session?.step(now),
  };
}

// ---------------------------------------------------------------- PWA
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 오프라인 캐시는 없어도 게임은 동작한다 */
    });
  });
}
