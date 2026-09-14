package touchflip.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import touchflip.core.GameRules;
import touchflip.room.RoomClock;
import touchflip.room.RoomRegistry;

/** 게임 도메인 빈. WebSocketConfig 와 분리해 핸들러 ↔ 설정 순환 참조를 피한다. */
@Configuration
public class GameBeans {
    @Bean
    public GameRules gameRules() {
        return GameRules.DEFAULT;
    }

    @Bean
    public RoomClock roomClock() {
        return RoomClock.system();
    }

    @Bean
    public RoomRegistry roomRegistry(GameRules rules, RoomClock clock) {
        return new RoomRegistry(rules, clock);
    }
}
