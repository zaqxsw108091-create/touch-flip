package touchflip.room;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static touchflip.core.PlayerId.P1;
import static touchflip.core.PlayerId.P2;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import touchflip.core.GameRules;
import touchflip.core.Phase;
import touchflip.core.ServerInputGovernor;
import touchflip.net.Messages;

class RoomTest {
    static final GameRules R = GameRules.DEFAULT;

    /** 손으로 돌리는 시계 */
    static final class FakeClock implements RoomClock {
        long t = 1_000;

        @Override
        public long now() {
            return t;
        }

        void advance(long ms) {
            t += ms;
        }
    }

    /** 받은 메시지를 쌓아 두는 Outbox */
    static final class Inbox implements Room.Outbox {
        final List<Messages.Outbound> messages = new ArrayList<>();

        @Override
        public void send(Messages.Outbound message) {
            messages.add(message);
        }

        <T> T last(Class<T> type) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                if (type.isInstance(messages.get(i))) return type.cast(messages.get(i));
            }
            return null;
        }

        long count(Class<?> type) {
            return messages.stream().filter(type::isInstance).count();
        }
    }

    FakeClock clock;
    Room room;
    Inbox a;
    Inbox b;

    @BeforeEach
    void setUp() {
        clock = new FakeClock();
        room = new Room("123456", R, clock);
        a = new Inbox();
        b = new Inbox();
    }

    /** 양쪽 입장 → 준비 → 카운트다운 종료 */
    void startPlaying() {
        room.join(a, null);
        room.join(b, null);
        room.ready(P1, true);
        room.ready(P2, true);
        clock.advance(R.countdownMs());
        room.tick();
        assertEquals(Phase.PLAYING, room.state().phase());
    }

    @Test
    void 첫_입장은_P1_두번째는_P2_세번째는_거부() {
        Room.JoinResult r1 = room.join(a, null);
        Room.JoinResult r2 = room.join(b, null);
        assertEquals(P1, r1.player());
        assertEquals(P2, r2.player());
        assertNull(room.join(new Inbox(), null));
    }

    @Test
    void 입장하면_joined와_state를_받고_상대에게_opponentJoined가_간다() {
        room.join(a, null);
        Messages.Joined joined = a.last(Messages.Joined.class);
        assertEquals(1, joined.playerId());
        assertEquals("123456", joined.roomCode());
        assertFalse(joined.opponentPresent());
        assertNotNull(a.last(Messages.State.class));

        room.join(b, null);
        assertNotNull(a.last(Messages.OpponentJoined.class));
        assertTrue(b.last(Messages.Joined.class).opponentPresent());
    }

    @Test
    void 양쪽_준비면_카운트다운_상태가_브로드캐스트된다() {
        room.join(a, null);
        room.join(b, null);
        room.ready(P1, true);
        assertEquals("idle", b.last(Messages.State.class).snapshot().phase());
        room.ready(P2, true);
        assertEquals("countdown", a.last(Messages.State.class).snapshot().phase());
        assertEquals("countdown", b.last(Messages.State.class).snapshot().phase());
    }

    @Test
    void 탭은_서버_도착_시각으로_판정되고_양쪽에_반영된다() {
        startPlaying();
        clock.advance(10);
        ServerInputGovernor.Outcome out = room.tap(P1, 7);
        assertTrue(out.result().accepted());
        assertEquals(1, a.last(Messages.State.class).snapshot().board().get(7));
        assertEquals(1, b.last(Messages.State.class).snapshot().board().get(7));
        assertTrue(a.last(Messages.TapAck.class).accepted());
    }

    @Test
    void 서버도_쿨다운과_락아웃을_건다() {
        startPlaying();
        clock.advance(10);
        room.tap(P1, 7);
        clock.advance(R.playerCooldownMs() - 1);
        assertEquals(ServerInputGovernor.Reject.COOLDOWN, room.tap(P1, 8).reject());
        clock.advance(1);
        assertTrue(room.tap(P1, 8).result().accepted());

        // 방금 뒤집힌 7번은 상대가 락아웃 안에 못 뺏는다
        assertEquals(ServerInputGovernor.Reject.CARD_LOCKOUT, room.tap(P2, 7).reject());
        clock.advance(R.cardLockoutMs());
        assertTrue(room.tap(P2, 7).result().accepted());
    }

    @Test
    void 두_클라이언트의_탭이_같은_틱_안에_와도_먼저_처리된_쪽이_가져간다() {
        startPlaying();
        clock.advance(10);
        assertTrue(room.tap(P2, 3).result().accepted());
        assertEquals(ServerInputGovernor.Reject.CARD_LOCKOUT, room.tap(P1, 3).reject());
        assertEquals(2, room.state().board()[3]);
    }

    @Test
    void 끊기면_상대에게_opponentLeft가_가고_준비가_풀린다() {
        room.join(a, null);
        room.join(b, null);
        room.ready(P1, true);
        room.ready(P2, true);
        assertEquals(Phase.COUNTDOWN, room.state().phase());

        room.disconnect(P2);
        assertEquals(R.reconnectGraceMs(), a.last(Messages.OpponentLeft.class).graceMs());
        assertEquals(Phase.IDLE, room.state().phase()); // 카운트다운 취소
    }

    @Test
    void 유예_안에_같은_토큰으로_돌아오면_이어서_한다() {
        startPlaying();
        String token = b.last(Messages.Joined.class).token();
        room.disconnect(P2);
        clock.advance(R.reconnectGraceMs() - 1);
        room.tick();
        assertFalse(room.isClosed());

        Inbox b2 = new Inbox();
        Room.JoinResult back = room.join(b2, token);
        assertTrue(back.reconnected());
        assertEquals(P2, back.player());
        assertEquals("playing", b2.last(Messages.State.class).snapshot().phase());
        assertNotNull(a.last(Messages.OpponentBack.class));

        clock.advance(R.reconnectGraceMs() * 2);
        room.tick();
        assertFalse(room.isClosed());
    }

    @Test
    void 유예를_넘기면_상대_부전승() {
        startPlaying();
        room.disconnect(P2);
        clock.advance(R.reconnectGraceMs());
        room.tick();
        assertTrue(room.isClosed());
        assertEquals(Phase.MATCH_END, room.state().phase());
        assertEquals(P1, room.state().matchWinner());
        assertEquals(1, a.last(Messages.State.class).snapshot().matchWinner());
    }

    @Test
    void 잘못된_토큰은_새_자리로_들어간다() {
        room.join(a, null);
        Room.JoinResult r = room.join(b, "no-such-token");
        assertFalse(r.reconnected());
        assertEquals(P2, r.player());
    }

    @Test
    void 상태가_안_바뀌면_하트비트_간격으로만_state를_보낸다() {
        room.join(a, null);
        long before = a.count(Messages.State.class);
        room.tick();
        assertEquals(before, a.count(Messages.State.class));
        clock.advance(Room.HEARTBEAT_MS);
        room.tick();
        assertEquals(before + 1, a.count(Messages.State.class));
    }

    @Test
    void 라운드는_서버_틱이_끝낸다() {
        startPlaying();
        clock.advance(R.roundDurationMs() - 1);
        room.tick();
        assertEquals(Phase.PLAYING, room.state().phase());
        clock.advance(1);
        room.tick();
        assertEquals(Phase.ROUND_END, room.state().phase());
        assertEquals("roundEnd", b.last(Messages.State.class).snapshot().phase());
    }

    @Test
    void 레지스트리는_6자리_코드를_만들고_닫힌_방을_치운다() {
        RoomRegistry registry = new RoomRegistry(R, clock);
        Room r = registry.create(60_000L);
        assertEquals(6, r.code().length());
        assertEquals(60_000, r.rules().roundDurationMs());
        assertEquals(R.roundDurationMs(), registry.create(999L).rules().roundDurationMs()); // 허용 목록 밖
        assertEquals(r, registry.find(r.code()));

        r.join(a, null);
        r.disconnect(P1);
        clock.advance(R.reconnectGraceMs());
        registry.tickAll();
        assertNull(registry.find(r.code()));
    }
}
