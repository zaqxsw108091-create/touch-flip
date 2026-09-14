package touchflip.room;

import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import touchflip.core.GameRules;

/** 6자리 방 코드 → Room. 스레드 안전. */
public final class RoomRegistry {
    private static final int CODE_DIGITS = 6;
    private static final int MAX_CODE_ATTEMPTS = 100;

    private final Map<String, Room> rooms = new ConcurrentHashMap<>();
    private final GameRules baseRules;
    private final RoomClock clock;
    private final SecureRandom random = new SecureRandom();

    public RoomRegistry(GameRules baseRules, RoomClock clock) {
        this.baseRules = baseRules;
        this.clock = clock;
    }

    /** 새 방. 라운드 길이는 허용 목록에 없으면 기본값으로 바꾼다. */
    public Room create(Long roundDurationMs) {
        long duration = roundDurationMs != null && baseRules.isAllowedRoundDuration(roundDurationMs)
                ? roundDurationMs
                : baseRules.roundDurationMs();
        for (int i = 0; i < MAX_CODE_ATTEMPTS; i++) {
            String code = String.format("%0" + CODE_DIGITS + "d", random.nextInt((int) Math.pow(10, CODE_DIGITS)));
            Room room = new Room(code, baseRules.withRoundDuration(duration), clock);
            if (rooms.putIfAbsent(code, room) == null) return room;
        }
        throw new IllegalStateException("방 코드를 만들 수 없습니다 (방이 너무 많음)");
    }

    public Room find(String code) {
        if (code == null) return null;
        Room room = rooms.get(code.trim());
        return room == null || room.isClosed() ? null : room;
    }

    public int size() {
        return rooms.size();
    }

    /** 모든 방을 한 틱 진행시키고 닫힌 방을 치운다. */
    public void tickAll() {
        for (Room room : rooms.values()) {
            room.tick();
            if (room.isClosed() || room.isEmpty()) rooms.remove(room.code(), room);
        }
    }
}
