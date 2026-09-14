package touchflip.core;

public sealed interface GameEvent {
    record Flip(int cardIndex, int owner, int previousOwner, long timestamp) implements GameEvent {}
    record Foul(PlayerId player, long timestamp) implements GameEvent {}
    record Ready(PlayerId player, boolean held) implements GameEvent {}
    record PhaseChange(Phase phase, Phase previous) implements GameEvent {}
    record RoundEnd(RoundResult result) implements GameEvent {}
    record MatchEnd(PlayerId winner) implements GameEvent {}
}
