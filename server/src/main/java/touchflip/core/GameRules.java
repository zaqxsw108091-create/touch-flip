package touchflip.core;

/**
 * 게임 규칙 상수. 클라이언트 src/config.ts 의 match / input / board 그룹과 값이 같아야 한다.
 * 서버가 권위이므로 여기 값이 최종이다.
 */
public record GameRules(
        int cardCount,
        long roundDurationMs,
        long countdownMs,
        int roundsToWin,
        long falseStartPenaltyMs,
        boolean stackFalseStartPenalty,
        long playerCooldownMs,
        long cardLockoutMs,
        long reconnectGraceMs,
        long[] roundDurationOptionsMs) {

    public static final GameRules DEFAULT = new GameRules(
            25,
            30_000,
            3_000,
            2,
            500,
            false,
            50,
            200,
            5_000,
            new long[] {30_000, 60_000, 120_000});

    public GameRules withRoundDuration(long ms) {
        return new GameRules(cardCount, ms, countdownMs, roundsToWin, falseStartPenaltyMs,
                stackFalseStartPenalty, playerCooldownMs, cardLockoutMs, reconnectGraceMs, roundDurationOptionsMs);
    }

    public boolean isAllowedRoundDuration(long ms) {
        for (long option : roundDurationOptionsMs) if (option == ms) return true;
        return false;
    }
}
