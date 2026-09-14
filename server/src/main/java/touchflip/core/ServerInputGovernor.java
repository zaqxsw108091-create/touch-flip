package touchflip.core;

import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;

/**
 * 서버 측 최종 입력 관문. 클라이언트 InputGovernor 의 쿨다운·락아웃 부분과 같다.
 *
 * 클라이언트 필터(포인터 종류·접촉 크기·동시 포인터 수)는 물리 입력이라 클라에서만 걸 수 있지만,
 * 쿨다운과 락아웃은 변조된 클라이언트가 우회할 수 있으므로 서버가 다시 건다.
 * Room 의 락 안에서만 호출된다.
 */
public final class ServerInputGovernor {
    public enum Reject { COOLDOWN, CARD_LOCKOUT, STATE }

    public record Outcome(boolean emitted, Reject reject, TapResult result) {}

    private final GameRules rules;
    private final GameState state;
    private final Map<PlayerId, Long> lastTapAt = new EnumMap<>(PlayerId.class);
    private final long[] cardLockedUntil;

    public ServerInputGovernor(GameRules rules, GameState state) {
        this.rules = rules;
        this.state = state;
        this.cardLockedUntil = new long[rules.cardCount()];
        resetRuntime();
    }

    public Outcome submit(PlayerId player, int cardIndex, long t) {
        if (t - lastTapAt.get(player) < rules.playerCooldownMs()) return new Outcome(false, Reject.COOLDOWN, null);
        if (cardIndex >= 0 && cardIndex < cardLockedUntil.length && t < cardLockedUntil[cardIndex]) {
            return new Outcome(false, Reject.CARD_LOCKOUT, null);
        }

        TapResult result = state.applyTap(new TapEvent(player, cardIndex, t));
        // 필터를 통과한 탭은 GameState 가 거부해도 쿨다운을 소모한다 (자기 카드 연타 우회 방지)
        lastTapAt.put(player, t);

        if (result.accepted()) {
            cardLockedUntil[cardIndex] = t + rules.cardLockoutMs();
            return new Outcome(true, null, result);
        }
        return new Outcome(true, Reject.STATE, result);
    }

    /** 라운드 경계에서 호출. 이전 라운드의 쿨다운/락아웃이 새지 않게 한다. */
    public void resetRuntime() {
        for (PlayerId p : PlayerId.values()) lastTapAt.put(p, Long.MIN_VALUE / 2);
        Arrays.fill(cardLockedUntil, Long.MIN_VALUE / 2);
    }
}
