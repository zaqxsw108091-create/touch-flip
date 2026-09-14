package touchflip.core;

import java.util.List;

/** 클라이언트 Snapshot 과 같은 모양. state 메시지로 그대로 직렬화된다. */
public record Snapshot(
        String phase,
        List<Integer> board,
        int round,
        int maxRounds,
        int orientation,
        int[] counts,
        int[] roundWins,
        boolean[] ready,
        int[] fouls,
        long[] penaltyUntil,
        long roundDurationMs,
        long remainingMs,
        int countdownValue,
        RoundResultWire lastRound,
        Integer matchWinner,
        long revision) {

    public record RoundResultWire(int round, Integer winner, int[] counts) {
        static RoundResultWire of(RoundResult r) {
            if (r == null) return null;
            return new RoundResultWire(r.round(), r.winner() == null ? null : r.winner().number,
                    new int[] {r.p1Count(), r.p2Count()});
        }
    }
}
