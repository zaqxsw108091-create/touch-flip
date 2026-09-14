package touchflip.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static touchflip.core.PlayerId.P1;
import static touchflip.core.PlayerId.P2;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * 클라이언트 tests/GameState.test.ts 의 포팅. 두 구현이 같은 답을 내야 한다.
 */
class GameStateTest {
    static final GameRules R = GameRules.DEFAULT;

    /** 양쪽 준비 → 카운트다운 종료까지 진행시키고 라운드 시작 시각을 돌려준다 */
    static long startRound(GameState s, long at) {
        s.setReady(P1, true, at);
        s.setReady(P2, true, at);
        long startAt = at + R.countdownMs();
        s.tick(startAt);
        return startAt;
    }

    static TapResult tap(GameState s, PlayerId p, int card, long t) {
        return s.applyTap(new TapEvent(p, card, t));
    }

    @Nested
    class 초기_상태 {
        @Test
        void 전부_중립이고_idle() {
            GameState s = new GameState(R);
            assertEquals(Phase.IDLE, s.phase());
            assertEquals(25, s.board().length);
            for (int o : s.board()) assertEquals(0, o);
            assertEquals(0, s.cardCount(P1));
        }
    }

    @Nested
    class 준비와_카운트다운 {
        GameState s;

        @BeforeEach
        void setUp() {
            s = new GameState(R);
        }

        @Test
        void 한쪽만_준비해서는_시작하지_않는다() {
            s.setReady(P1, true, 0);
            assertEquals(Phase.IDLE, s.phase());
        }

        @Test
        void 양쪽_준비면_카운트다운() {
            s.setReady(P1, true, 0);
            s.setReady(P2, true, 0);
            assertEquals(Phase.COUNTDOWN, s.phase());
            assertEquals(3, s.snapshot(0).countdownValue());
            assertEquals(2, s.snapshot(1_500).countdownValue());
        }

        @Test
        void 카운트다운_중_손을_떼면_취소() {
            s.setReady(P1, true, 0);
            s.setReady(P2, true, 0);
            s.setReady(P2, false, 500);
            assertEquals(Phase.IDLE, s.phase());
            s.tick(10_000);
            assertEquals(Phase.IDLE, s.phase());
        }

        @Test
        void 카운트다운이_끝나면_playing() {
            long startAt = startRound(s, 1_000);
            assertEquals(Phase.PLAYING, s.phase());
            assertEquals(R.roundDurationMs(), s.remainingMs(startAt));
            assertEquals(R.roundDurationMs() - 10_000, s.remainingMs(startAt + 10_000));
        }

        @Test
        void 틱이_늦어도_라운드가_길어지지_않는다() {
            s.setReady(P1, true, 0);
            s.setReady(P2, true, 0);
            s.tick(R.countdownMs() + 200);
            assertEquals(0, s.remainingMs(R.countdownMs() + R.roundDurationMs()));
        }
    }

    @Nested
    class 카드_소유권 {
        GameState s;
        long startAt;

        @BeforeEach
        void setUp() {
            s = new GameState(R);
            startAt = startRound(s, 1_000);
        }

        @Test
        void 중립_카드를_누르면_자기_색() {
            TapResult r = tap(s, P1, 7, startAt + 10);
            assertTrue(r.accepted());
            assertEquals(0, r.previousOwner());
            assertEquals(1, s.board()[7]);
        }

        @Test
        void 상대_카드도_뺏는다() {
            tap(s, P1, 7, startAt + 10);
            TapResult steal = tap(s, P2, 7, startAt + 20);
            assertTrue(steal.accepted());
            assertEquals(1, steal.previousOwner());
            assertEquals(2, s.board()[7]);
            assertEquals(0, s.cardCount(P1));
        }

        @Test
        void 자기_카드면_거부() {
            tap(s, P1, 7, startAt + 10);
            TapResult again = tap(s, P1, 7, startAt + 20);
            assertFalse(again.accepted());
            assertEquals("already-owned", again.reason());
        }

        @Test
        void 범위_밖_인덱스_거부() {
            assertEquals("out-of-range", tap(s, P1, 25, startAt + 10).reason());
            assertEquals("out-of-range", tap(s, P1, -1, startAt + 10).reason());
        }

        @Test
        void 라운드_종료_시각_이후_탭은_tick_전에도_거부() {
            long endAt = startAt + R.roundDurationMs();
            TapResult late = tap(s, P1, 3, endAt + 1);
            assertFalse(late.accepted());
            assertEquals("not-playing", late.reason());
            assertEquals(0, s.board()[3]);
        }

        @Test
        void 라운드_시작_이전_탭도_거부() {
            assertEquals("not-playing", tap(s, P1, 3, startAt - 1).reason());
        }

        @Test
        void flip_이벤트를_방출한다() {
            List<GameEvent> events = new ArrayList<>();
            s.subscribe(events::add);
            tap(s, P2, 12, startAt + 5);
            assertTrue(events.contains(new GameEvent.Flip(12, 2, 0, startAt + 5)));
        }
    }

    @Nested
    class 부정_출발 {
        GameState s;

        @BeforeEach
        void setUp() {
            s = new GameState(R);
            s.setReady(P1, true, 0);
            s.setReady(P2, true, 0);
        }

        @Test
        void 카운트다운_중_탭은_파울() {
            TapResult r = tap(s, P1, 4, 1_000);
            assertFalse(r.accepted());
            assertEquals("foul", r.reason());
            assertEquals(0, s.board()[4]);
            assertEquals(1, s.fouls(P1));
        }

        @Test
        void 페널티는_라운드_시작부터_500ms() {
            tap(s, P1, 4, 1_000);
            long startAt = R.countdownMs();
            s.tick(startAt);
            assertEquals(startAt + R.falseStartPenaltyMs(), s.penaltyUntil(P1));
            assertEquals("penalty", tap(s, P1, 4, startAt + 499).reason());
            assertTrue(tap(s, P1, 4, startAt + 500).accepted());
        }

        @Test
        void 파울_없는_쪽은_페널티_없음() {
            tap(s, P1, 4, 1_000);
            long startAt = R.countdownMs();
            s.tick(startAt);
            assertEquals(0, s.penaltyUntil(P2));
            assertTrue(tap(s, P2, 4, startAt + 1).accepted());
        }

        @Test
        void 기본_설정에서_페널티는_누적되지_않는다() {
            tap(s, P1, 4, 500);
            tap(s, P1, 5, 900);
            long startAt = R.countdownMs();
            s.tick(startAt);
            assertEquals(startAt + R.falseStartPenaltyMs(), s.penaltyUntil(P1));
        }

        @Test
        void 카운트다운이_취소되면_파울도_지워진다() {
            tap(s, P1, 4, 1_000);
            s.setReady(P1, false, 1_100);
            assertEquals(0, s.fouls(P1));
        }
    }

    @Nested
    class 라운드와_매치 {
        GameState s;

        @BeforeEach
        void setUp() {
            s = new GameState(R);
        }

        long playRound(PlayerId winner, int cards, long at) {
            long startAt = startRound(s, at);
            for (int i = 0; i < cards; i++) tap(s, winner, i, startAt + 10 + i);
            long endAt = startAt + R.roundDurationMs();
            s.tick(endAt);
            return endAt;
        }

        @Test
        void 카드가_많은_쪽이_라운드를_가져간다() {
            playRound(P1, 3, 0);
            assertEquals(Phase.ROUND_END, s.phase());
            assertEquals(1, s.roundWins(P1));
            assertEquals(new RoundResult(1, P1, 3, 0), s.lastRound());
        }

        @Test
        void 두_라운드를_먼저_이기면_매치_종료() {
            long t = playRound(P1, 3, 0) + 100;
            playRound(P1, 4, t);
            assertEquals(Phase.MATCH_END, s.phase());
            assertEquals(P1, s.matchWinner());
        }

        @Test
        void 세_라운드까지_가는_매치() {
            long t = playRound(P1, 5, 0) + 100;
            t = playRound(P2, 5, t) + 100;
            assertEquals(1, s.roundWins(P1));
            assertEquals(1, s.roundWins(P2));
            playRound(P2, 6, t);
            assertEquals(Phase.MATCH_END, s.phase());
            assertEquals(P2, s.matchWinner());
            assertEquals(3, s.lastRound().round());
        }

        @Test
        void 무승부는_승수_없이_같은_라운드_재경기() {
            long startAt = startRound(s, 0);
            tap(s, P1, 0, startAt + 10);
            tap(s, P2, 1, startAt + 20);
            s.tick(startAt + R.roundDurationMs());
            assertNull(s.lastRound().winner());
            assertEquals(0, s.roundWins(P1));
            assertEquals(1, s.round());

            long next = startAt + R.roundDurationMs() + 100;
            s.setReady(P1, true, next);
            s.setReady(P2, true, next);
            assertEquals(1, s.round());
            assertEquals(Phase.COUNTDOWN, s.phase());
        }

        @Test
        void 라운드가_끝나면_준비가_풀린다() {
            playRound(P1, 3, 0);
            assertFalse(s.isReady(P1));
            assertFalse(s.isReady(P2));
        }

        @Test
        void 다음_라운드는_빈_보드_180도() {
            long endAt = playRound(P1, 3, 0);
            s.setReady(P1, true, endAt + 10);
            s.setReady(P2, true, endAt + 10);
            for (int o : s.board()) assertEquals(0, o);
            assertEquals(2, s.round());
            assertEquals(180, s.orientation());
        }

        @Test
        void 매치_종료_후_양쪽_준비면_새_매치() {
            long t = playRound(P1, 3, 0) + 100;
            t = playRound(P1, 4, t) + 100;
            assertEquals(Phase.MATCH_END, s.phase());
            s.setReady(P1, true, t);
            s.setReady(P2, true, t);
            assertEquals(Phase.COUNTDOWN, s.phase());
            assertEquals(1, s.round());
            assertEquals(0, s.roundWins(P1));
            assertNull(s.matchWinner());
        }

        @Test
        void 부전승() {
            startRound(s, 0);
            s.forfeit(P2);
            assertEquals(Phase.MATCH_END, s.phase());
            assertEquals(P2, s.matchWinner());
            assertEquals(2, s.snapshot(0).matchWinner());
        }

        @Test
        void 라운드_시간_옵션() {
            GameState one = new GameState(R.withRoundDuration(60_000));
            long startAt = startRound(one, 0);
            assertEquals(60_000, one.remainingMs(startAt));
            one.tick(startAt + 59_999);
            assertEquals(Phase.PLAYING, one.phase());
            one.tick(startAt + 60_000);
            assertEquals(Phase.ROUND_END, one.phase());
        }
    }
}
