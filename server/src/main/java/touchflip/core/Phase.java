package touchflip.core;

public enum Phase {
    IDLE("idle"),
    COUNTDOWN("countdown"),
    PLAYING("playing"),
    ROUND_END("roundEnd"),
    MATCH_END("matchEnd");

    /** 클라이언트(TypeScript) 와 같은 문자열 */
    public final String wire;

    Phase(String wire) {
        this.wire = wire;
    }
}
