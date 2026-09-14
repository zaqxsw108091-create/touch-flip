package touchflip.net;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.ObjectMapper;
import touchflip.core.PlayerId;
import touchflip.room.Room;
import touchflip.room.RoomRegistry;

/**
 * 세션 ↔ 방 라우팅. 게임 규칙은 전혀 모른다 — 메시지를 풀어 Room 에 넘기고 결과를 돌려보낼 뿐이다.
 */
@Component
public class GameWebSocketHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(GameWebSocketHandler.class);
    private static final int SEND_TIMEOUT_MS = 1_000;
    private static final int SEND_BUFFER_BYTES = 256 * 1024;

    /** 세션 하나의 상태 */
    private static final class Link {
        final WebSocketSession session;
        Room room;
        PlayerId player;

        Link(WebSocketSession session) {
            this.session = session;
        }
    }

    private final RoomRegistry registry;
    private final ObjectMapper json;
    private final Map<String, Link> links = new ConcurrentHashMap<>();

    public GameWebSocketHandler(RoomRegistry registry, ObjectMapper json) {
        this.registry = registry;
        this.json = json;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        // 여러 스레드(틱 + 핸들러)가 같은 세션에 보내므로 직렬화 데코레이터로 감싼다
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, SEND_TIMEOUT_MS, SEND_BUFFER_BYTES);
        links.put(raw.getId(), new Link(session));
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) {
        Link link = links.get(raw.getId());
        if (link == null) return;

        Messages.Inbound in;
        try {
            in = json.readValue(message.getPayload(), Messages.Inbound.class);
        } catch (RuntimeException e) {
            send(link, Messages.Error.of("bad-json", "메시지를 해석할 수 없습니다"));
            return;
        }
        if (in.type() == null) {
            send(link, Messages.Error.of("bad-type", "type 이 없습니다"));
            return;
        }

        switch (in.type()) {
            case "join" -> handleJoin(link, in);
            case "ready" -> withRoom(link, (room, player) -> room.ready(player, Boolean.TRUE.equals(in.held())));
            case "tap" -> withRoom(link, (room, player) -> {
                if (in.cardIndex() == null) {
                    send(link, Messages.Error.of("bad-tap", "cardIndex 가 없습니다"));
                    return;
                }
                room.tap(player, in.cardIndex());
            });
            case "ping" -> withRoom(link, (room, player) -> room.ping(player, in.clientTime()));
            default -> send(link, Messages.Error.of("unknown-type", "알 수 없는 type: " + in.type()));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        Link link = links.remove(raw.getId());
        if (link == null || link.room == null) return;
        link.room.disconnect(link.player);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.debug("전송 오류 {}: {}", session.getId(), exception.toString());
    }

    // ------------------------------------------------------------ 내부

    private void handleJoin(Link link, Messages.Inbound in) {
        if (link.room != null) {
            send(link, Messages.Error.of("already-joined", "이미 방에 들어가 있습니다"));
            return;
        }

        Room room = in.roomCode() == null || in.roomCode().isBlank()
                ? registry.create(in.roundDurationMs())
                : registry.find(in.roomCode());
        if (room == null) {
            send(link, Messages.Error.of("room-not-found", "방을 찾을 수 없습니다"));
            return;
        }

        Room.JoinResult result = room.join(msg -> send(link, msg), in.token());
        if (result == null) {
            send(link, Messages.Error.of("room-full", "방이 가득 찼습니다"));
            return;
        }
        link.room = room;
        link.player = result.player();
        log.info("방 {} 에 P{} {}", room.code(), result.player().number, result.reconnected() ? "재접속" : "입장");
    }

    private interface RoomAction {
        void run(Room room, PlayerId player);
    }

    private void withRoom(Link link, RoomAction action) {
        if (link.room == null) {
            send(link, Messages.Error.of("not-joined", "먼저 방에 들어가야 합니다"));
            return;
        }
        action.run(link.room, link.player);
    }

    private void send(Link link, Messages.Outbound message) {
        if (!link.session.isOpen()) return;
        try {
            link.session.sendMessage(new TextMessage(json.writeValueAsString(message)));
        } catch (IOException | RuntimeException e) {
            log.debug("전송 실패 {}: {}", link.session.getId(), e.toString());
        }
    }
}
