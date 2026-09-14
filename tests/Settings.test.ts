import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from '../src/core/Settings';

describe('parseSettings — 손상/빈 값 방어', () => {
  it('null/undefined/빈 문자열은 기본값', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS);
  });

  it('JSON 이 아니면 기본값 (게임이 멈추지 않는다)', () => {
    expect(parseSettings('{깨진 JSON')).toEqual(DEFAULT_SETTINGS);
  });

  it('객체가 아닌 JSON 이면 기본값', () => {
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('[1,2]')).toEqual({ mute: DEFAULT_SETTINGS.mute, reducedMotion: DEFAULT_SETTINGS.reducedMotion });
  });

  it('정상 값은 그대로 읽힌다', () => {
    expect(parseSettings(JSON.stringify({ mute: true, reducedMotion: true }))).toEqual({ mute: true, reducedMotion: true });
  });

  it('일부 필드만 있거나 타입이 틀리면 그 필드만 기본값으로 채운다', () => {
    expect(parseSettings(JSON.stringify({ mute: true }))).toEqual({ mute: true, reducedMotion: false });
    expect(parseSettings(JSON.stringify({ mute: 'yes', reducedMotion: true }))).toEqual({ mute: false, reducedMotion: true });
  });
});
