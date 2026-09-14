package touchflip.core;

/** reason: null | not-playing | penalty | already-owned | foul | out-of-range (TS 와 동일 문자열) */
public record TapResult(boolean accepted, int cardIndex, PlayerId player, int owner, int previousOwner, String reason) {

    static TapResult reject(TapEvent tap, int previousOwner, String reason) {
        return new TapResult(false, tap.cardIndex(), tap.player(), previousOwner, previousOwner, reason);
    }
}
