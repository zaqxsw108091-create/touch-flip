/**
 * 매치 승/패 효과음. Web Audio 로 직접 합성한다 — 오디오 파일도 외부 라이브러리도 없다.
 *
 * 효과가 붙는 사건은 "매치 종료" 하나뿐이다(이겼는지 졌는지에 따라 다른 톤).
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
