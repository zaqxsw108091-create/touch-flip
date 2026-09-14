package touchflip.net;

import touchflip.core.Snapshot;

/**
 * WebSocket 프로토콜 (docs/GAME_SPEC.md 7절). JSON 필드명이 클라이언트 src/net/protocol.ts 와 같아야 한다.
 * tapTime / clientTime 은 v3 (시계 동기화) 용으로 미리 자리를 잡아 둔다. v2 서버는 읽지 않는다.
 */
public final class Messages {
    private Messages() {}

    /** 클라이언트 → 서버. 한 record 에 모든 필드를 두고 type 으로 분기한다 (없는 필드는 null). */
    public record Inbound(
            String type,
            String roomCode,
            String token,
            Long roundDurationMs,
            Boolean held,
            Integer cardIndex,
            Double tapTime,
            Double clientTime) {}

    // ------------------------------------------------------------ 서버 → 클라이언트

    public interface Outbound {
        String type();
    }

    public record Joined(String type, int playerId, String roomCode, String token, boolean opponentPresent,
                         long roundDurationMs) implements Outbound {
        public static Joined of(int playerId, String roomCode, String token, boolean opponentPresent, long roundDurationMs) {
            return new Joined("joined", playerId, roomCode, token, opponentPresent, roundDurationMs);
        }
    }

    public record OpponentJoined(String type) implements Outbound {
        public static final OpponentJoined INSTANCE = new OpponentJoined("opponentJoined");
    }

    public record OpponentLeft(String type, long graceMs) implements Outbound {
        public static OpponentLeft of(long graceMs) {
            return new OpponentLeft("opponentLeft", graceMs);
        }
    }

    public record OpponentBack(String type) implements Outbound {
        public static final OpponentBack INSTANCE = new OpponentBack("opponentBack");
    }

    public record State(String type, long serverTime, Snapshot snapshot) implements Outbound {
        public static State of(long serverTime, Snapshot snapshot) {
            return new State("state", serverTime, snapshot);
        }
    }

    /** 자기 탭에 대한 판정 결과. 통계·디버그용이며 화면은 state 로만 그린다. */
    public record TapAck(String type, int cardIndex, boolean accepted, String reason) implements Outbound {
        public static TapAck of(int cardIndex, boolean accepted, String reason) {
            return new TapAck("tapAck", cardIndex, accepted, reason);
        }
    }

    public record Pong(String type, Double clientTime, long serverTime) implements Outbound {
        public static Pong of(Double clientTime, long serverTime) {
            return new Pong("pong", clientTime, serverTime);
        }
    }

    public record Error(String type, String code, String message) implements Outbound {
        public static Error of(String code, String message) {
            return new Error("error", code, message);
        }
    }
}
