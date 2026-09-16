/**
 * 게임 효과음. Web Audio 로 직접 합성한다 — 오디오 파일도 외부 라이브러리도 없다.
 *
 * 전부 "짧고 정해진 사건에만" 붙는 전자음이다(카운트다운 틱/시작, 부정 출발, 매치 승/패).
 * 빗소리 같은 자연음(노이즈 필터링이 필요)과 달리, 단순한 톤이라 합성 난이도가 낮고
 * 소리 자체가 "전자음"인 게 정답이라 어색하게 들릴 위험이 없다.
 *
 * 음소거가 켜져 있으면 AudioContext 자체를 건드리지 않는다 — 켜는 순간 소리가 완전히 멈춘다.
 */
export type SoundKind = 'win' | 'loss';

export class SoundEffects {
  private ctx: AudioContext | null = null;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  play(kind: SoundKind): void {
    if (kind === 'win') this.tone(440, 880, 350, 'triangle');
    else this.tone(300, 120, 400, 'sawtooth');
  }

  /** 카운트다운 3·2·1 — 짧고 중립적인 틱. 매초 한 번만 울린다(호출 쪽에서 값 변화를 감지) */
  playCountdownTick(): void {
    this.tone(660, 660, 90, 'sine');
  }

  /** 카운트다운이 끝나고 라운드가 시작되는 순간 — 틱과 뚜렷이 구분되는 상승음 */
  playCountdownGo(): void {
    this.tone(500, 1000, 150, 'triangle');
  }

  /** 부정 출발(카운트다운 중 터치) — 매치 패배음과는 다른, 짧고 거친 경고음 */
  playFoul(): void {
    this.tone(220, 160, 140, 'square');
  }

  private tone(freqStart: number, freqEnd: number, durationMs: number, type: OscillatorType): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const duration = durationMs / 1000;

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.linearRampToValueAtTime(freqEnd, now + duration);

    // 클릭음 방지를 위해 아주 작은 값에서 시작/종료한다 (0은 exponentialRamp 에 못 쓴다)
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null; // 지원 안 하는 환경 — 소리 없이도 게임은 된다
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }
}
