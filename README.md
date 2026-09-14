# Touch Flip

한 화면에서 마주 앉아 하는 **2인 터치 카드 뒤집기 대전**.
5x5 = 25장의 카드를 더 많이 자기 색으로 뒤집는 쪽이 이긴다.

> 설계 원칙: **기기 성능 차이가 승부에 영향을 주면 안 된다. 오직 손가락 속도만이 결과를 결정한다.**

## 빠른 시작

```bash
npm install
npm run dev
```

터미널에 뜨는 `Network:` 주소로 **같은 Wi-Fi 의 태블릿에서 접속**해서 두 명이 플레이한다.
데스크톱에서 혼자 확인하려면 `?debug=mouse` 를 붙인다 — 자세한 절차는
[docs/TESTING.md](docs/TESTING.md).

온라인 멀티(기기 2대)는 서버가 필요하다 (JDK 25):

```bash
cd server && ./gradlew bootRun
```

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (`--host` 포함) |
| `npm run test` | 유닛 테스트 75개 |
| `npm run build` | 타입 검사(strict) + 프로덕션 번들 |
| `npm run preview` | 빌드 결과 확인 |
| `npm run icons` | PWA 아이콘 PNG 재생성 (public/ 에 커밋되어 있어 평소엔 불필요) |
| `cd server && ./gradlew bootRun` | 온라인 대전 서버 (8080) |
| `cd server && ./gradlew test` | 서버 테스트 40개 |

## 시작 설정

접속하면 단계식으로 **기기(태블릿/폰) → 상대(2인 로컬 / 온라인 멀티 / NPC 1~5단계) → 라운드 시간(30초/1분/2분)** 을 고른다.
2인 로컬이 기본이고, 상대가 없을 때 NPC 가 상대 역할을 한다. NPC 는 사람과 같은
입력 관문(쿨다운·락아웃)을 지나므로 사람이 물리적으로 못 내는 속도는 내지 못한다.
온라인 멀티는 한쪽이 방을 만들어 6자리 코드를 상대에게 알려주면 된다.

## 조작

- **준비**: 양쪽이 각자의 준비 버튼을 **누르고 있어야** 3-2-1 카운트다운이 시작된다.
  카운트다운 중 보드를 건드리면 부정 출발로 0.5초 입력 정지.
- **카드**: 아래쪽 절반 → 파랑(P1), 위쪽 절반 → 분홍(P2), 가운데 띠 → 무효.
  상대 색 카드도 뺏을 수 있다.
- **키보드**: `F` 홀드 = P1 준비, `J` 홀드 = P2 준비, `Space` 홀드 = 양쪽 동시(혼자 테스트용),
  `R` = 매치 재시작.
- 3판 2선승. 라운드마다 보드가 180도 회전한다. `Esc` = 시작 설정으로.

## 구조

```
src/
  config.ts              모든 튜닝 상수 (여기 말고 다른 데 숫자를 박지 않는다)
  main.ts                조립 + 메인 루프 + 키보드
  core/
    types.ts
    GameState.ts         게임 규칙. DOM 의존 없음, 시각은 전부 주입받는다
    NpcPlayer.ts         NPC 의사결정. DOM·시계 의존 없음, 난수 주입
  input/
    HitTester.ts         좌표 → 카드/존 인터페이스
    InputGovernor.ts     게임 입력의 유일한 진입점. 공정성 필터 전부
  net/
    protocol.ts          서버 메시지 타입 (server/…/Messages.java 와 대응)
    Connection.ts        WebSocket 래퍼, 5초 안 자동 재접속
    RemoteState.ts       서버 상태 거울. 타이머 보간만, 규칙 없음
    RemoteSession.ts     온라인 한 판 (방·토큰·상태). GameState 없음
  render/
    BoardGeometry.ts     카드 사각형 캐시 (HitTester 구현)
    Renderer.ts          스냅샷 → DOM. 규칙 없음
    SetupScreen.ts       시작 설정 화면
  styles.css
tests/                   GameState / InputGovernor / NpcPlayer / RemoteState 유닛 테스트
server/                  Spring Boot 4 · 순수 WebSocket · 서버 권위 (v2)
  src/main/java/touchflip/
    core/GameState.java  TS GameState 의 1:1 포팅 + forfeit
    core/ServerInputGovernor.java  서버 측 쿨다운·락아웃
    room/Room.java       방 = 세션 2 + GameState + 타이머. synchronized
    net/GameWebSocketHandler.java  세션 ↔ 방 라우팅
  src/test/java/touchflip/  GameStateTest(TS 테스트 포팅) · RoomTest
```

데이터 흐름은 한 방향이다.

```
pointerdown ─▶ InputGovernor ─▶ TapEvent ─▶ GameState ─▶ Snapshot ─▶ Renderer ─▶ DOM
               (공정성 필터)                  (규칙)                    (그리기만)
```

## 공정성을 위해 한 선택들

| 선택 | 이유 |
|---|---|
| 판정 시각에 `event.timeStamp` 사용 | `requestAnimationFrame` 기준으로 판정하면 120Hz 기기가 60Hz 기기보다 유리해진다 |
| 라운드 종료 시각은 카운트다운 **예정** 종료 시각 기준 | rAF 호출이 늦은 기기에서 라운드가 길어지지 않는다 |
| 라운드 종료 시각 이후 timestamp 의 탭은 tick 전에도 거부 | 프레임 경계에서 한 번 더 먹는 일이 없다 |
| 입력이 `InputGovernor` 하나만 지나가게 격리 | 게임 로직이 pointer 이벤트를 직접 구독하기 시작하면 나머지 보장이 전부 무의미해진다 |
| GameState 가 거부한 탭도 쿨다운을 소모 | 자기 카드 연타로 쿨다운을 우회하는 구멍을 막는다 |
| 온라인: 서버가 유일한 권위, 클라이언트에 `GameState` 없음 | 두 기기의 상태가 갈라질 수 없다 |
| 온라인: 서버가 쿨다운·락아웃을 다시 건다 | 변조된 클라이언트가 클라 필터를 우회해도 서버에서 막힌다 |
| 온라인: 라운드 종료는 서버만 선언, 클라는 남은 시간을 보간만 | 클라 시계 오차가 승부에 못 끼어든다 |
| NPC 탭도 `InputGovernor.submitTap` 을 거쳐 쿨다운·락아웃 적용 | NPC 가 사람의 물리적 상한(초당 20탭)을 넘을 수 없다 |
| NPC 탭 시각 = 예약 시각 (프레임 시각 아님) | 규칙 5 를 NPC 에도 똑같이 적용한다 |
| 탭마다 보드 위치를 확인해 어긋나면 카드 사각형 재측정 | HUD 높이가 바뀌어 보드가 밀려도 중립 띠 판정이 어긋나지 않는다 |
| 오래된 포인터 자동 만료 (`POINTER_STALE_MS`) | `pointerup` 하나를 놓치면 해당 플레이어가 남은 판 내내 입력 불가가 되는 것을 막는다 |
| 카드 크기를 화면 비례가 아닌 물리 크기(16mm)로 고정 | 화면이 클수록 손 이동 거리가 늘어 오히려 불리해진다 |
| 180도 회전을 CSS transform 이 아니라 슬롯 매핑으로 구현 | transform 으로 돌리면 카드의 상/하 존까지 뒤집혀 "아래쪽 = P1" 규칙이 깨진다 |
| 햅틱 미사용 | 기기별 진동 반응 편차가 크다 |

튜닝 상수는 전부 [`src/config.ts`](src/config.ts) 한 곳에 있다.

## 배포 (GitHub Pages)

```bash
npm run build
```

`vite.config.ts` 의 `base: './'` 때문에 `dist/` 를 어느 서브경로에 올려도 그대로 동작한다.
`dist/` 내용을 `gh-pages` 브랜치나 Pages 소스 디렉터리에 올리면 끝이다.
PWA 매니페스트와 서비스 워커가 포함되어 있어 태블릿 홈화면에 추가하면 전체화면으로 실행된다.

## 문서

- [docs/GAME_SPEC.md](docs/GAME_SPEC.md) — 게임 규칙, 입력 공정성 상수, 네트워크 프로토콜
- [docs/ROADMAP.md](docs/ROADMAP.md) — 단계별 작업 목록 (v1 · v1.5 · v2 완료, 실기기 테스트만 남음)
- [docs/TESTING.md](docs/TESTING.md) — 검증 체크리스트

## 다음 단계

v3 — 지연 보상. v2 는 판정 시각이 서버 도착 시각이라 핑이 낮은 쪽이 유리하다.
시계 동기화(ping 20회, Cristian) + 120ms 판정 윈도우 + 클라이언트 예측/롤백 + 타임스탬프 검증으로
"먼저 누른 쪽이 이긴다"를 네트워크 위에서도 지킨다. 프로토콜의 `tapTime` / `serverTime` 필드는 이미 자리를 잡아 두었다.
