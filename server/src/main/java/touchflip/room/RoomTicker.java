package touchflip.room;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** 모든 방을 주기적으로 진행시킨다. 판정 시각은 틱이 아니라 메시지 도착 시각이므로 틱 주기는 화면 갱신용이다. */
@Component
public class RoomTicker {
    static final long TICK_MS = 50;

    private final RoomRegistry registry;

    public RoomTicker(RoomRegistry registry) {
        this.registry = registry;
    }

    @Scheduled(fixedRate = TICK_MS)
    public void tick() {
        registry.tickAll();
    }
}
