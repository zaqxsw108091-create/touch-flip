package touchflip.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 게임 규칙의 유일한 소유자. 클라이언트 src/core/GameState.ts 의 1:1 포팅.
 *
 * 절대 규칙:
 * - 시계·IO·네트워크에 의존하지 않는다. 모든 시각은 인자로 주입받는다.
 * - 입력은 ServerInputGovernor 를 통과한 TapEvent 만 받는다.
 * - 스레드 안전하지 않다. Room 이 자기 락 안에서만 호출한다.
 */
public final class GameState {
    private final GameRules rules;

    private Phase phase = Phase.IDLE;
    private int[] board;
    private int round = 1;
    private final Map<PlayerId, Integer> roundWins = new EnumMap<>(PlayerId.class);
    private final Map<PlayerId, Boolean> ready = new EnumMap<>(PlayerId.class);
    private final Map<PlayerId, Integer> fouls = new EnumMap<>(PlayerId.class);
    private final Map<PlayerId, Long> penaltyUntil = new EnumMap<>(PlayerId.class);

    private long countdownEndsAt;
    private long roundStartAt;
    private long roundEndsAt;

    private RoundResult lastRound;
    private PlayerId matchWinner;
    private long revision;

    private final List<Consumer<GameEvent>> listeners = new ArrayList<>();

    public GameState(GameRules rules) {
        this.rules = rules;
        this.board = new int[rules.cardCount()];
        for (PlayerId p : PlayerId.values()) {
            roundWins.put(p, 0);
            ready.put(p, false);
            fouls.put(p, 0);
            penaltyUntil.put(p, 0L);
        }
    }

    // ---------------------------------------------------------------- 읽기

    public Phase phase() { return phase; }
    public int[] board() { return board.clone(); }
    public int round() { return round; }
    public int roundWins(PlayerId p) { return roundWins.get(p); }
    public int orientation() { return round % 2 == 1 ? 0 : 180; }
    public PlayerId matchWinner() { return matchWinner; }
    public long roundDurationMs() { return rules.roundDurationMs(); }
    public long revision() { return revision; }
    public boolean isReady(PlayerId p) { return ready.get(p); }
    public int fouls(PlayerId p) { return fouls.get(p); }
    public RoundResult lastRound() { return lastRound; }

    public int cardCount(PlayerId p) {
        int n = 0;
        for (int owner : board) if (owner == p.number) n++;
        return n;
    }

    public long penaltyUntil(PlayerId p) { return penaltyUntil.get(p); }

    public long remainingMs(long now) {
        return switch (phase) {
            case PLAYING -> Math.max(0, roundEndsAt - now);
            case COUNTDOWN -> Math.max(0, countdownEndsAt - now);
            case IDLE -> rules.roundDurationMs();
            default -> 0;
        };
    }

    public Snapshot snapshot(long now) {
        long remaining = remainingMs(now);
        List<Integer> boardList = new ArrayList<>(board.length);
        for (int owner : board) boardList.add(owner);
        return new Snapshot(
                phase.wire,
                boardList,
                round,
                rules.roundsToWin() * 2 - 1,
                orientation(),
                new int[] {cardCount(PlayerId.P1), cardCount(PlayerId.P2)},
                new int[] {roundWins.get(PlayerId.P1), roundWins.get(PlayerId.P2)},
                new boolean[] {ready.get(PlayerId.P1), ready.get(PlayerId.P2)},
                new int[] {fouls.get(PlayerId.P1), fouls.get(PlayerId.P2)},
                new long[] {penaltyUntil.get(PlayerId.P1), penaltyUntil.get(PlayerId.P2)},
                rules.roundDurationMs(),
                remaining,
                phase == Phase.COUNTDOWN ? (int) Math.max(1, Math.ceil(remaining / 1000.0)) : 0,
                Snapshot.RoundResultWire.of(lastRound),
                matchWinner == null ? null : matchWinner.number,
                revision);
    }

    // ---------------------------------------------------------------- 쓰기

    public Runnable subscribe(Consumer<GameEvent> listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    /** 준비 홀드 상태 변경. 양쪽이 동시에 누르고 있어야 카운트다운, 하나라도 놓으면 취소. */
    public void setReady(PlayerId player, boolean held, long now) {
        if (ready.get(player) == held) return;
        ready.put(player, held);
        emit(new GameEvent.Ready(player, held));

        if (!held) {
            if (phase == Phase.COUNTDOWN) abortCountdown();
            bump();
            return;
        }

        if (ready.get(PlayerId.P1) && ready.get(PlayerId.P2)) {
            switch (phase) {
                case IDLE -> beginCountdown(now);
                case ROUND_END -> {
                    // 무승부 라운드는 승수를 주지 않았으므로 같은 라운드 번호로 재경기한다
                    if (lastRound != null && lastRound.winner() != null) round += 1;
                    beginCountdown(now);
                }
                case MATCH_END -> {
                    resetMatch();
                    ready.put(PlayerId.P1, true);
                    ready.put(PlayerId.P2, true);
                    beginCountdown(now);
                }
                default -> { }
            }
        }
        bump();
    }

    /**
     * 유효 탭 처리. 카운트다운 중 탭은 부정 출발로 기록하고 거부한다.
     * 라운드 종료 시각 이후의 timestamp 는 tick 이 아직 안 돌았더라도 거부한다.
     */
    public TapResult applyTap(TapEvent tap) {
        int i = tap.cardIndex();
        if (i < 0 || i >= board.length) {
            return new TapResult(false, i, tap.player(), 0, 0, "out-of-range");
        }
        int previousOwner = board[i];
        PlayerId p = tap.player();
        long t = tap.timestamp();

        if (phase == Phase.COUNTDOWN) {
            fouls.put(p, fouls.get(p) + 1);
            emit(new GameEvent.Foul(p, t));
            bump();
            return TapResult.reject(tap, previousOwner, "foul");
        }
        if (phase != Phase.PLAYING) return TapResult.reject(tap, previousOwner, "not-playing");
        if (t < roundStartAt || t >= roundEndsAt) return TapResult.reject(tap, previousOwner, "not-playing");
        if (t < penaltyUntil.get(p)) return TapResult.reject(tap, previousOwner, "penalty");
        if (previousOwner == p.number) return TapResult.reject(tap, previousOwner, "already-owned");

        board[i] = p.number;
        emit(new GameEvent.Flip(i, p.number, previousOwner, t));
        bump();
        return new TapResult(true, i, p, p.number, previousOwner, null);
    }

    /** 페이즈 전이. 매 틱 호출. */
    public void tick(long now) {
        if (phase == Phase.COUNTDOWN && now >= countdownEndsAt) {
            startRound();
            return;
        }
        if (phase == Phase.PLAYING && now >= roundEndsAt) endRound();
    }

    /** 서버 전용: 상대가 이탈했을 때 부전승 처리 */
    public void forfeit(PlayerId winner) {
        Phase previous = phase;
        matchWinner = winner;
        phase = Phase.MATCH_END;
        ready.put(PlayerId.P1, false);
        ready.put(PlayerId.P2, false);
        emit(new GameEvent.PhaseChange(Phase.MATCH_END, previous));
        emit(new GameEvent.MatchEnd(winner));
        bump();
    }

    public void resetMatch() {
        Phase previous = phase;
        phase = Phase.IDLE;
        board = new int[rules.cardCount()];
        round = 1;
        for (PlayerId p : PlayerId.values()) {
            roundWins.put(p, 0);
            ready.put(p, false);
            fouls.put(p, 0);
            penaltyUntil.put(p, 0L);
        }
        countdownEndsAt = roundStartAt = roundEndsAt = 0;
        lastRound = null;
        matchWinner = null;
        if (previous != Phase.IDLE) emit(new GameEvent.PhaseChange(Phase.IDLE, previous));
        bump();
    }

    // ---------------------------------------------------------------- 내부

    private void beginCountdown(long now) {
        Phase previous = phase;
        board = new int[rules.cardCount()];
        for (PlayerId p : PlayerId.values()) {
            fouls.put(p, 0);
            penaltyUntil.put(p, 0L);
        }
        countdownEndsAt = now + rules.countdownMs();
        phase = Phase.COUNTDOWN;
        emit(new GameEvent.PhaseChange(Phase.COUNTDOWN, previous));
    }

    private void abortCountdown() {
        Phase previous = phase;
        phase = Phase.IDLE;
        countdownEndsAt = 0;
        for (PlayerId p : PlayerId.values()) fouls.put(p, 0);
        emit(new GameEvent.PhaseChange(Phase.IDLE, previous));
    }

    private void startRound() {
        Phase previous = phase;
        // now 가 아니라 예정된 카운트다운 종료 시각 기준. 틱이 늦어도 라운드가 길어지지 않는다.
        roundStartAt = countdownEndsAt;
        roundEndsAt = roundStartAt + rules.roundDurationMs();
        phase = Phase.PLAYING;

        for (PlayerId p : PlayerId.values()) {
            int n = fouls.get(p);
            if (n <= 0) continue;
            long amount = rules.stackFalseStartPenalty() ? rules.falseStartPenaltyMs() * n : rules.falseStartPenaltyMs();
            penaltyUntil.put(p, roundStartAt + amount);
        }
        emit(new GameEvent.PhaseChange(Phase.PLAYING, previous));
        bump();
    }

    private void endRound() {
        Phase previous = phase;
        int c1 = cardCount(PlayerId.P1);
        int c2 = cardCount(PlayerId.P2);
        PlayerId winner = c1 == c2 ? null : (c1 > c2 ? PlayerId.P1 : PlayerId.P2);

        lastRound = new RoundResult(round, winner, c1, c2);
        ready.put(PlayerId.P1, false);
        ready.put(PlayerId.P2, false);
        if (winner != null) roundWins.put(winner, roundWins.get(winner) + 1);

        if (winner != null && roundWins.get(winner) >= rules.roundsToWin()) {
            matchWinner = winner;
            phase = Phase.MATCH_END;
            emit(new GameEvent.RoundEnd(lastRound));
            emit(new GameEvent.PhaseChange(Phase.MATCH_END, previous));
            emit(new GameEvent.MatchEnd(winner));
        } else {
            phase = Phase.ROUND_END;
            emit(new GameEvent.RoundEnd(lastRound));
            emit(new GameEvent.PhaseChange(Phase.ROUND_END, previous));
        }
        bump();
    }

    private void emit(GameEvent event) {
        for (Consumer<GameEvent> l : List.copyOf(listeners)) l.accept(event);
    }

    private void bump() { revision++; }

    @Override
    public String toString() {
        return "GameState{phase=" + phase + ", round=" + round + ", board=" + Arrays.toString(board) + "}";
    }
}
