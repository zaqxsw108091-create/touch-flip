package touchflip.room;

/** 서버 단조 시계(ms). 테스트에서는 가짜로 바꿔 끼운다. */
@FunctionalInterface
public interface RoomClock {
    long now();

    /** System.nanoTime 기반. 벽시계 조정에 영향받지 않는다. */
    static RoomClock system() {
        final long origin = System.nanoTime();
        return () -> (System.nanoTime() - origin) / 1_000_000L;
    }
}
