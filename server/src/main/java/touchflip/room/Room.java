package touchflip.room;

import java.util.EnumMap;
import java.util.Map;
import java.util.UUID;
import touchflip.core.GameEvent;
import touchflip.core.GameRules;
import touchflip.core.GameState;
import touchflip.core.Phase;
import touchflip.core.PlayerId;
import touchflip.core.ServerInputGovernor;
import touchflip.net.Messages;

/**
 * 방 하나 = 플레이어 2명 + GameState + 입력 관문 + 타이머.
 *
 * 모든 public 메서드는 synchronized 다. 두 클라이언트의 탭이 동시에 도착해도
 * 이 락 안에서 순서대로 처리되므로 GameState 는 스레드를 몰라도 된다.
 * 네트워크는 Outbox 인터페이스 뒤에 숨긴다 — 테스트에서는 리스트에 쌓는다.
 */
public final class Room {
    /** 플레이어 한 명에게 메시지를 보내는 통로. 연결이 끊기면 null 로 바뀐다. */
    public interface Outbox {
        void send(Messages.Outbound message);
    }

    public record JoinResult(PlayerId player, String token, boolean reconnected) {}

    private static final class Player {
        final String token = UUID.randomUUID().toString();
        Outbox out;
        /** 0 = 연결 중. 그 외 = 끊긴 시각 */
        long disconnectedAt;
    }

    private final String code;
    private final GameRules rules;
    private final RoomClock clock;
    private final GameState state;
    private final ServerInputGovernor governor;
    private final Map<PlayerId, Player> players = new EnumMap<>(PlayerId.class);

    private long lastBroadcastRevision = -1;
    private long lastBroadcastAt = Long.MIN_VALUE / 2;
    private boolean closed;

    /** 상태가 안 바뀌어도 이 간격마다 타이머 동기화용 state 를 보낸다 */
    static final long HEARTBEAT_MS = 500;

    public Room(String code, GameRules rules, RoomClock clock) {
        this.code = code;
        this.rules = rules;
        this.clock = clock;
        this.state = new GameState(rules);
        this.governor = new ServerInputGovernor(rules, state);
        state.subscribe(this::onEvent);
    }

    public String code() { return code; }
    public GameRules rules() { return rules; }
    public synchronized boolean isClosed() { return closed; }
    public synchronized GameState state() { return state; }

    public synchronized boolean isEmpty() {
        return players.isEmpty();
    }

    // ------------------------------------------------------------ 입장 / 이탈

    /**
     * 입장. token 이 있고 일치하는 자리가 있으면 재접속으로 처리한다.
     * 자리가 없으면 null.
     */
    public synchronized JoinResult join(Outbox out, String token) {
        if (closed) return null;
        long now = clock.now();

        if (token != null) {
            for (Map.Entry<PlayerId, Player> e : players.entrySet()) {
                Player p = e.getValue();
                if (p.token.equals(token)) {
                    p.out = out;
                    p.disconnectedAt = 0;
                    sendTo(e.getKey().other(), Messages.OpponentBack.INSTANCE);
                    sendJoined(e.getKey());
                    return new JoinResult(e.getKey(), p.token, true);
                }
            }
        }

        PlayerId slot = players.containsKey(PlayerId.P1) ? (players.containsKey(PlayerId.P2) ? null : PlayerId.P2) : PlayerId.P1;
        if (slot == null) return null;

        Player p = new Player();
        p.out = out;
        players.put(slot, p);
        sendJoined(slot);
        sendTo(slot.other(), Messages.OpponentJoined.INSTANCE);
        broadcastState(now, true);
        return new JoinResult(slot, p.token, false);
    }

    /** 연결 끊김. 유예 시간 안에 같은 token 으로 돌아오면 이어서 한다. */
    public synchronized void disconnect(PlayerId player) {
        Player p = players.get(player);
        if (p == null) return;
        p.out = null;
        p.disconnectedAt = clock.now();
        // 준비를 누른 채 끊겼으면 놓은 것으로 본다 (카운트다운 취소)
        state.setReady(player, false, p.disconnectedAt);
        sendTo(player.other(), Messages.OpponentLeft.of(rules.reconnectGraceMs()));
        broadcastState(p.disconnectedAt, false);
    }

    // ------------------------------------------------------------ 입력

    public synchronized void ready(PlayerId player, boolean held) {
        if (closed) return;
        long now = clock.now();
        state.setReady(player, held, now);
        broadcastState(now, false);
    }

    /**
     * 탭. v2 의 판정 시각은 서버 도착 시각이다 — 핑이 낮은 쪽이 유리해지는 것을 알면서 감수한다.
     * v3 에서 클라이언트 보정 시각 + 판정 윈도우로 교체한다 (GAME_SPEC 8절).
     */
    public synchronized ServerInputGovernor.Outcome tap(PlayerId player, int cardIndex) {
        long now = clock.now();
        if (closed) return new ServerInputGovernor.Outcome(false, ServerInputGovernor.Reject.STATE, null);
        ServerInputGovernor.Outcome outcome = governor.submit(player, cardIndex, now);
        if (outcome.emitted()) {
            sendTo(player, Messages.TapAck.of(cardIndex, outcome.result().accepted(), outcome.result().reason()));
        }
        broadcastState(now, false);
        return outcome;
    }

    public synchronized void ping(PlayerId player, Double clientTime) {
        sendTo(player, Messages.Pong.of(clientTime, clock.now()));
    }

    // ------------------------------------------------------------ 틱

    /** 주기적으로 호출. 페이즈 전이, 부전승 판정, 하트비트. */
    public synchronized void tick() {
        if (closed) return;
        long now = clock.now();
        state.tick(now);

        for (Map.Entry<PlayerId, Player> e : players.entrySet()) {
            Player p = e.getValue();
            if (p.disconnectedAt == 0) continue;
            if (now - p.disconnectedAt < rules.reconnectGraceMs()) continue;

            // 유예 시간 초과. 상대가 남아 있으면 부전승, 아니면 그냥 방을 닫는다.
            Player other = players.get(e.getKey().other());
            if (other != null && other.disconnectedAt == 0 && state.phase() != Phase.MATCH_END) {
                state.forfeit(e.getKey().other());
            }
            closed = true;
            break;
        }
        broadcastState(now, false);
    }

    // ------------------------------------------------------------ 내부

    private void onEvent(GameEvent event) {
        if (event instanceof GameEvent.PhaseChange pc
                && (pc.phase() == Phase.COUNTDOWN || pc.phase() == Phase.PLAYING)) {
            governor.resetRuntime();
        }
    }

    private void sendJoined(PlayerId player) {
        Player p = players.get(player);
        Player other = players.get(player.other());
        boolean opponentPresent = other != null && other.disconnectedAt == 0;
        sendTo(player, Messages.Joined.of(player.number, code, p.token, opponentPresent, rules.roundDurationMs()));
        sendTo(player, Messages.State.of(clock.now(), state.snapshot(clock.now())));
    }

    private void broadcastState(long now, boolean force) {
        boolean changed = state.revision() != lastBroadcastRevision;
        boolean heartbeat = now - lastBroadcastAt >= HEARTBEAT_MS;
        if (!force && !changed && !heartbeat) return;
        lastBroadcastRevision = state.revision();
        lastBroadcastAt = now;
        Messages.State msg = Messages.State.of(now, state.snapshot(now));
        for (PlayerId id : players.keySet()) sendTo(id, msg);
    }

    private void sendTo(PlayerId player, Messages.Outbound message) {
        Player p = players.get(player);
        if (p == null || p.out == null) return;
        p.out.send(message);
    }
}
