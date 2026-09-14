/**
 * 음소거 / 모션 감소 설정. localStorage 에 저장되고(개인 최고기록과 마찬가지로
 * 이 기기 안에만 남는다), 손상되거나 비어 있어도 항상 기본값으로 안전하게 시작한다.
 *
 * DOM 에 의존하지 않는다 — 실제 저장은 main.ts 가 loadOptions() 와 같은 패턴으로 담당한다.
 */
export interface AppSettings {
  mute: boolean;
  reducedMotion: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = { mute: false, reducedMotion: false };

export function parseSettings(raw: string | null | undefined): AppSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const p = parsed as Record<string, unknown>;
    return {
      mute: typeof p['mute'] === 'boolean' ? p['mute'] : DEFAULT_SETTINGS.mute,
      reducedMotion: typeof p['reducedMotion'] === 'boolean' ? p['reducedMotion'] : DEFAULT_SETTINGS.reducedMotion,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
