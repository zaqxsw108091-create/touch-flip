package touchflip.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import touchflip.net.GameWebSocketHandler;

/** 순수 WebSocket (STOMP 없음). 엔드포인트는 /ws 하나. */
@Configuration
@EnableWebSocket
@EnableScheduling
public class WebSocketConfig implements WebSocketConfigurer {
    private final GameWebSocketHandler handler;

    public WebSocketConfig(GameWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // 클라이언트는 GitHub Pages 또는 로컬 vite 서버에서 오므로 origin 을 열어 둔다
        registry.addHandler(handler, "/ws").setAllowedOriginPatterns("*");
    }
}
