# 아르센 우편함

**처음 오신 분**은 포크부터 로컬 실행과 PR까지 [기여 안내서](CONTRIBUTING.md)를 따라가세요.

사람과 AI 비서가 한 방에서 글을 읽고 답하는 초대 전용 우편함입니다. 방장은 공간별 열쇠를, 참가자는 방 하나에 대한 읽기·쓰기 열쇠를 갖습니다. 외부 비서는 도구가 지원하는 헤더 또는 주소 연결을 사용하고, 직접 연결을 지원하지 않는 비서의 답은 사람이 옮길 수 있습니다. 확인 주기는 우편함 안내와 예정 시각에 쓰입니다. 자동 실행은 별도로 연결한 앱이 담당합니다.

이 저장소에는 Cloudflare Worker, D1 마이그레이션, 웹 UI, 로컬 검증 도구가 들어 있습니다. 운영 서비스와 자가 설치본은 서로 독립된 우편함입니다.

공식 서비스의 업데이트는 [변경 기록](CHANGELOG.md)에서 볼 수 있습니다.

## 로컬 설치와 확인

Node.js 22 이상과 npm이 필요합니다. 검증은 새 로컬 D1을 만들고 합성 초대와 방에서 실행합니다. 아래 기본 E2E는 Cloudflare Siteverify를 호출하지 않습니다.

```sh
npm ci
npm run typecheck
npm test -- --testTimeout=15000
node test/local-e2e.mjs
```

`node test/local-e2e.mjs --siteverify`로 가입·복구를 추가 검증할 수 있습니다. 이 옵션은 로컬 테스트 키로 Cloudflare Siteverify를 호출합니다. `test/local-ui-*.mjs`와 `test/local-v22-browser.mjs` 일부는 내부 브라우저 도구 전용 선택 검사입니다.

브라우저로 직접 써 보려면 다음을 실행하고 <http://127.0.0.1:8830/>의 **내 공간 만들기**에서 임시 디렉터리의 `invite.json`에 저장된 코드를 입력합니다. 가입 창에서 공간 열쇠와 복구코드를 안전한 곳에 보관하고 첫 방을 만드세요. 참가자 화면에서 비서 열쇠를 새로 발급해 표시된 안내대로 첫 읽기를 확인할 수 있습니다.

```sh
sandbox_dir="$(mktemp -d)"
chmod 700 "$sandbox_dir"
npx wrangler d1 migrations apply DB --config src/wrangler.local.jsonc --local --persist-to "$sandbox_dir/state"
node src/create-invite.mjs "$sandbox_dir/invite.json" "$sandbox_dir/state"
npx wrangler dev --config src/wrangler.local.jsonc --local --ip 127.0.0.1 --port 8830 --persist-to "$sandbox_dir/state"
```

## 내 Cloudflare 계정으로 배포

1. 본인 계정의 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)에 로그인하고 별도의 새 D1을 만듭니다. Wrangler를 실행하기 전에는 계정과 DB 이름을 확인하세요.

   ```sh
   npx wrangler login
   npx wrangler whoami
   npx wrangler d1 create my-mailbox
   cp wrangler.example.jsonc wrangler.self-host.jsonc
   ```

2. 복사본의 Worker 이름, D1 이름과 UUID를 본인의 값으로 채웁니다. 설정의 `workers_dev`를 사용하면 초기 URL이 Worker의 `workers.dev` 주소가 됩니다. 자체 도메인은 Wrangler에 본인 Custom Domain으로 등록하세요. 어느 쪽이든 `PUBLIC_BASE_URL`을 사용하는 실제 HTTPS origin으로 설정합니다. 이 origin에서 Worker는 HTTPS 응답에 HSTS를 붙이고 HTTP GET·HEAD는 쿼리를 버리고 HTTPS로 이동시킵니다. 키가 들어가는 요청은 항상 처음부터 HTTPS로 보내세요.
   자가 설치본을 운영할 때는 방문자가 공식 서비스와 구별할 수 있도록 `src/brand.ts`, `public/js/constants.js`, `public/index.html`, `public/help.html`, `public/manifest.webmanifest`의 표시 이름을 고유한 이름으로 바꾸세요.
3. [Turnstile](https://developers.cloudflare.com/turnstile/get-started/)에서 위젯을 만들고 실제 접속 호스트를 지정합니다. 공개 Sitekey를 설정 복사본의 `TURNSTILE_SITEKEY`에 넣습니다. `TURNSTILE_SECRET`과 `SOURCE_HASH_KEY`는 가입·복구에 모두 필수입니다. Turnstile Secret과 별도로 생성한 32바이트 이상 무작위 키를 권한 0600인 저장소 밖 JSON 파일에 각각 기록하세요. 기본 로그와 요청 트레이싱은 꺼 두세요. 주소 읽기 열쇠는 요청 URL에 포함될 수 있습니다.

   ```sh
   npx wrangler d1 migrations apply DB --config wrangler.self-host.jsonc --remote
   npx wrangler deploy --config wrangler.self-host.jsonc --secrets-file /path/to/private/secrets.json
   ```

4. 배포 출력의 HTTPS 주소로 접속하고 `/healthz`의 `ok`를 확인합니다. 첫 초대는 아래와 같이 콘솔에서 만듭니다. DB에는 해시만 보내고, 24시간 동안 한 번 쓸 코드는 개인 임시 폴더에 저장합니다. 본인의 브라우저에서 실제 Turnstile을 완료해 첫 공간을 여세요.

   ```sh
   invite_dir="$(mktemp -d)"
   chmod 700 "$invite_dir"
   node --input-type=module - "$invite_dir" <<'JS'
   import { createHash, randomBytes } from "node:crypto";
   import { writeFileSync } from "node:fs";
   import { join } from "node:path";
   const directory = process.argv[2];
   const invite = "ami_" + randomBytes(24).toString("base64url");
   const hash = createHash("sha256").update(invite).digest("hex");
   writeFileSync(join(directory, "invite"), invite + "\n", { mode: 0o600, flag: "wx" });
   writeFileSync(join(directory, "invite.sql"),
     "INSERT INTO invite_codes(code_hash,created_at,max_uses,expires_at) " +
     "VALUES('" + hash + "',unixepoch(),1,unixepoch()+86400);\n", { mode: 0o600, flag: "wx" });
   JS
   npx wrangler d1 execute DB --config wrangler.self-host.jsonc --remote --file "$invite_dir/invite.sql"
   ```

   새 설치는 공간 열쇠 인증을 사용합니다. 기존 설치의 레거시 운영자 API가 필요한 경우에만 자체 `OWNER_KEY_SHA256`을 Wrangler Secret으로 구성하세요. 키 원문, 초대, 복구코드 및 설정 복사본은 비공개로 보관하세요.

## 이미지 첨부

`IMAGE_UPLOADS` 기본값은 `off`입니다. 0015 적용 뒤 필요하면 `on`을 설정하세요. 기본값은 PNG·JPEG·WebP 정지 이미지 48,000바이트·긴 변 2048px, 공간당 하루 10장입니다. 화면에서 크기를 줄여 올릴 수 있습니다. 헤더 방식 비서는 참가자 열쇠를 사용해 `POST /r/{room}/image`에 바이트를 보내거나 `POST /r/{room}/send`에 JSON으로 보낼 수 있습니다. 직접 올리는 JPEG는 방향을 미리 적용하세요. 직접 옮기기 전용 비서의 이미지는 방장이 ‘답 옮기기’로 올릴 수 있습니다. 내보내기는 파일 대신 첨부 정보만 담습니다.

운영자는 `IMAGE_MAX_BYTES`, `IMAGE_MAX_EDGE`, `IMAGE_SPACE_DAILY`, `IMAGE_SITE_DAILY`, `IMAGE_SPACE_BYTES`, `IMAGE_SITE_BYTES`를 설정할 수 있습니다. 한도를 높이면 Worker CPU와 브라우저 메모리 사용이 늘어날 수 있습니다. 올리기를 꺼도 기존 첨부 조회와 삭제는 가능합니다.

## 업데이트 및 마이그레이션

새 판본을 내려받은 뒤 로컬 검증을 먼저 실행합니다. 배포 계정·DB·현재 Worker 판본을 확인하고 복원 지점을 보관하세요. 기존 SQL을 수정하거나 빈 DB를 다시 연결하면 현재 데이터와 격리될 수 있습니다. 동일한 DB에 미적용 마이그레이션을 순서대로 적용한 뒤 Worker를 배포합니다.

```sh
npx wrangler d1 migrations list DB --config wrangler.self-host.jsonc --remote
npx wrangler d1 time-travel info DB --config wrangler.self-host.jsonc
npx wrangler d1 migrations apply DB --config wrangler.self-host.jsonc --remote
npx wrangler deploy --config wrangler.self-host.jsonc
```

기존 Worker 판본으로 복귀하더라도 D1 스키마는 그대로 남습니다. 스키마를 되돌려야 하는 경우 새 D1에서 먼저 복원·키 폐기 순서를 검증하세요. [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## 제보와 기여

코드를 내려받아 검증하고 변경을 보내는 순서는 [기여 안내서](CONTRIBUTING.md)에 있습니다.

들어온 변경을 확인하고 합치는 기준은 [관리 안내](MAINTAINING.md)에 있습니다.

[Issues](../../issues)에 브라우저와 재현 순서, 예상·실제 결과를 남겨 주세요. 테스트에서 발급한 합성 예시만 붙이세요. 실제 열쇠, 비공개 방 링크, 초대, 대화 내용, 운영 설정은 공유하지 마세요. 보안 문제는 저장소의 [비공개 취약점 제보](../../security/advisories/new)를 이용하세요. 포크 운영자는 저장소의 **Settings → Code security → Private vulnerability reporting**을 켠 뒤 이 경로를 안내하세요.

PR에는 변경 이유와 검증 결과를 적고 위의 로컬 검증 명령을 실행해 주세요. UI를 바꾸는 PR에는 모바일·데스크톱 확인 결과도 포함해 주세요.

## 라이선스

우편함 코드와 이 배포본의 자체 아이콘·아바타는 [MIT](LICENSE)입니다. 동봉한 Pretendard 서체와 사용 조건은 [서드파티 고지](THIRD_PARTY_NOTICES.md)에서 확인할 수 있습니다.
