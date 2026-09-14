import type { GameConfig } from '../config';
import type { GameEvent, PlayerId, Snapshot, TapEvent, TapResult } from '../core/types';
import { Connection, type ConnectionStatus } from './Connection';
import type { ServerMessage } from './protocol';
import { RemoteState } from './RemoteState';

export type RemoteSessionStatus =
  | 'connecting'
  | 'waiting' // 방에 들어갔고 상대를 기다리는 중
  | 'ready' // 둘 다 있음
  | 'opponentLeft' // 상대 끊김, 유예 중
  | 'reconnecting' // 내 연결 끊김, 재접속 중
  | 'lost' // 재접속 실패
  | 'error';

export interface RemoteSessionListener {
  onStatus: (status: RemoteSessionStatus, detail?: string) => void;
  onJoined: (info: { playerId: PlayerId; roomCode: string; roundDurationMs: number }) => void;
  onEvent: (event: GameEvent) => void;
}

/**
 * 온라인 한 판. 서버가 유일한 권위이며 여기에는 GameState 가 없다.
 *
 * - 카드 탭: InputGovernor 를 통과한 탭만 서버로 보낸다 (규칙 2 유지).
 *   서버가 최종 판정하고, 클라이언트 락아웃은 같은 카드 연타를 미리 걸러주는 용도다.
 * - 준비: held 를 그대로 보낸다.
 * - 재접속: 끊기면 5초 안에 같은 token 으로 다시 join 한다.
 */
export class RemoteSession {
  readonly state: RemoteState;
  private readonly connection: Connection;
  private playerId: PlayerId | null = null;
  private roomCode: string | null = null;
  private token: string | null = null;
  private opponentPresent = false;
  private _status: RemoteSessionStatus = 'connecting';
  private readonly joinRequest: { roomCode?: string; roundDurationMs?: number };

  constructor(
    cfg: GameConfig,
    serverUrl: string,
    joinRequest: { roomCode?: string; roundDurationMs?: number },
    private listener: RemoteSessionListener,
  ) {
    this.joinRequest = joinRequest;
    this.state = new RemoteState(joinRequest.roundDurationMs ?? cfg.match.ROUND_DURATION_MS);
    this.connection = new Connection(serverUrl, {
      reconnectWindowMs: cfg.online.RECONNECT_GRACE_MS,
      retryIntervalMs: cfg.online.RETRY_INTERVAL_MS,
      onMessage: (m) => this.onMessage(m),
      onStatus: (s) => this.onConnection(s),
      onReopen: () => this.sendJoin(),
    });
  }

  get me(): PlayerId | null {
    return this.playerId;
  }

  get status(): RemoteSessionStatus {
    return this._status;
  }

  get code(): string | null {
    return this.roomCode;
  }

  get bothPresent(): boolean {
    return this.playerId !== null && this.opponentPresent;
  }

  start(): void {
    this.connection.open();
  }

  /** 로비에서 게임 화면으로 넘어갈 때 리스너를 갈아 끼운다 */
  rebind(listener: RemoteSessionListener): void {
    this.listener = listener;
  }

  destroy(): void {
    this.connection.close();
  }

  /** InputGovernor 의 onTap 자리. 서버로 보내고, 로컬 락아웃을 위해 낙관적으로 accepted 를 돌려준다 */
  submitTap(tap: TapEvent): TapResult {
    this.connection.send({ type: 'tap', cardIndex: tap.cardIndex, tapTime: tap.timestamp });
    return { accepted: true, cardIndex: tap.cardIndex, playerId: tap.playerId, owner: tap.playerId, previousOwner: 0 };
  }

  setReady(held: boolean): void {
    this.connection.send({ type: 'ready', held });
  }

  snapshot(now: number): Snapshot {
    return this.state.snapshot(now);
  }

  // ------------------------------------------------------------ 내부

  private sendJoin(): void {
    const msg: { type: 'join'; roomCode?: string; token?: string; roundDurationMs?: number } = { type: 'join' };
    if (this.token && this.roomCode) {
      msg.roomCode = this.roomCode;
      msg.token = this.token;
    } else {
      if (this.joinRequest.roomCode) msg.roomCode = this.joinRequest.roomCode;
      if (this.joinRequest.roundDurationMs) msg.roundDurationMs = this.joinRequest.roundDurationMs;
    }
    this.connection.send(msg);
  }

  private onConnection(status: ConnectionStatus): void {
    switch (status) {
      case 'open':
        if (!this.token) this.sendJoin(); // 첫 접속. 재접속은 onReopen 이 처리한다
        break;
      case 'reconnecting':
        this.setStatus('reconnecting');
        break;
      case 'lost':
        this.setStatus('lost', '서버에 다시 연결하지 못했습니다');
        break;
      default:
        break;
    }
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'joined':
        this.playerId = m.playerId;
        this.roomCode = m.roomCode;
        this.token = m.token;
        this.opponentPresent = m.opponentPresent;
        this.listener.onJoined({ playerId: m.playerId, roomCode: m.roomCode, roundDurationMs: m.roundDurationMs });
        this.setStatus(m.opponentPresent ? 'ready' : 'waiting');
        break;
      case 'opponentJoined':
      case 'opponentBack':
        this.opponentPresent = true;
        this.setStatus('ready');
        break;
      case 'opponentLeft':
        this.opponentPresent = false;
        this.setStatus('opponentLeft', `상대 연결 끊김 — ${Math.round(m.graceMs / 1000)}초 기다립니다`);
        break;
      case 'state': {
        const events = this.state.apply(m.snapshot, performance.now());
        for (const e of events) this.listener.onEvent(e);
        break;
      }
      case 'error':
        this.setStatus('error', `${m.message} (${m.code})`);
        break;
      case 'tapAck':
      case 'pong':
      default:
        break;
    }
  }

  private setStatus(status: RemoteSessionStatus, detail?: string): void {
    this._status = status;
    this.listener.onStatus(status, detail);
  }
}
