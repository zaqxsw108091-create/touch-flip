# 스크린샷 넣는 법

1. 채팅에 붙여넣은 이미지를 우클릭 → **"이미지를 다른 이름으로 저장"**으로 PC에 저장한다
   (또는 Windows 캡처 도구 `Win + Shift + S`로 새로 캡처해도 된다)
2. 저장한 파일을 이 폴더(`docs/screenshots/`)에 복사해 넣는다
3. 파일명을 README.md 가 참조하는 이름과 맞춘다: `gameplay-round.png`, `gameplay-result.png`
   (이름이 다르면 README.md 상단의 `![...](docs/screenshots/파일명.png)` 부분을 그 이름으로 고치면 됨)
4. 저장이 끝나면 프로젝트 루트에서:
   ```bash
   git add docs/screenshots
   git commit -m "플레이 스크린샷 추가"
   ```
5. 나중에 `git push` 하면 GitHub 저장소에도 이미지가 올라가고, README.md 를 GitHub에서 열어보면
   그 자리에 이미지가 바로 보인다 (별도 이미지 호스팅 필요 없음 — 저장소 안 파일을 직접 참조하는 것)
