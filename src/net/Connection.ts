import { isServerMessage, type ClientMessage, type ServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'lost';

export interface ConnectionOptions {
  /** 끊긴 뒤 이 시간 안에는 계속 재접속을 시도한다(ms). 서버의 유예 시간과 같아야 한다 */
  reconnectWindowMs: number;
  /** 재접속 시도 간격(ms) */
  retryIntervalMs: number;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** 재접속에 성공했을 때 (join 을 다시 보내야 한다) */
  onReopen?: () => void;
}

/**
 * WebSocket 얇은 래퍼. 자동 재접속과 타입 안전한 send 만 담당한다.
 * 게임 규칙·상태는 전혀 모른다.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private _status: ConnectionStatus = 'closed';
  private intentionalClose = false;
  private everOpened = false;
  private lostAt = 0;
  private retryTimer: number | null = null;

  constructor(
    private readonly url: string,
    private readonly opts: ConnectionOptions,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  open(): void {
    this.intentionalClose = false;
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting');
    this.dial();
  }

  close(): void {
    this.intentionalClose = true;
    this.clearRetry();
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }

  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  // ------------------------------------------------------------ 내부

  private dial(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const wasReconnect = this.everOpened;
      this.everOpened = true;
      this.setStatus('open');
      if (wasReconnect) this.opts.onReopen?.();
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      if (isServerMessage(parsed)) this.opts.onMessage(parsed);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.intentionalClose) return;
      if (this._status !== 'reconnecting') this.lostAt = performance.now();
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose 가 뒤따라오므로 여기서는 아무것도 하지 않는다 */
    };
  }

  private scheduleRetry(): void {
    if (this.intentionalClose) return;
    if (this._status !== 'reconnecting') {
      this.lostAt = performance.now();
      this.setStatus('reconnecting');
    }
    if (performance.now() - this.lostAt > this.opts.reconnectWindowMs) {
      this.setStatus('lost');
      return;
    }
    this.clearRetry();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.intentionalClose) this.dial();
    }, this.opts.retryIntervalMs);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.opts.onStatus(status);
  }
}
