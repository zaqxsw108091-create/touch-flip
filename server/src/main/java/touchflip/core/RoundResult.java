package touchflip.core;

/** winner == null 이면 무승부 (승수 없이 재경기) */
public record RoundResult(int round, PlayerId winner, int p1Count, int p2Count) {}
