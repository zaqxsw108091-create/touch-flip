package touchflip.core;

/** 판정 시각(ms). v2 에서는 서버 도착 시각, v3 에서는 클라이언트가 보낸 보정 시각. */
public record TapEvent(PlayerId player, int cardIndex, long timestamp) {}
