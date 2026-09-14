package touchflip.core;

/** 1 = 파랑(아래쪽), 2 = 분홍(위쪽). 온라인에서는 입장 순서. */
public enum PlayerId {
    P1(1),
    P2(2);

    public final int number;

    PlayerId(int number) {
        this.number = number;
    }

    public PlayerId other() {
        return this == P1 ? P2 : P1;
    }

    public static PlayerId of(int number) {
        return number == 1 ? P1 : P2;
    }
}
