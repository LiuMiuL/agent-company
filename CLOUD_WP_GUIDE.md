# 클라우드 워드프레스 자동 발행 가이드

GitHub Actions 에서 **글을 만들고 `manyinfo.net` 워드프레스에 올리는** 방법입니다.
내 PC 가 꺼져 있어도, 폰에서도 실행할 수 있습니다.

- 스크립트: `scripts/wp-publish.mjs` (의존성 없음 — `pnpm install` 없이 돕니다)
- 워크플로우: `.github/workflows/wp-publish.yml` (이름: **WP Auto Publish**)
- 기본 상태는 **`draft`(임시저장)** 입니다. 워드프레스 관리자에서 확인한 뒤 직접 발행하세요.

```
[Run workflow]
   topic · category · status · generate_image
        │
        ▼
  LLM 글 생성 (Anthropic 또는 OpenAI)
        │  제목 · 요약 · HTML · 태그 · 이미지 프롬프트
        ▼
  HTML 정리 (허용 태그만 · script/이벤트 속성 제거)
        │
        ▼
  카테고리 매칭 (이름·슬러그·ID)  →  (선택) 대문 이미지 생성·업로드
        │
        ▼
  /wp/v2/posts  →  draft 로 저장
        │
        ▼
  Actions Summary + 결과 JSON 아티팩트
```

---

## 1. 한 번만 하면 되는 설정

### 1-1. 워드프레스 응용 프로그램 비밀번호 발급

1. `https://manyinfo.net/wp-admin` 에 로그인 (계정 `admin`)
2. **프로필** (`/wp-admin/profile.php`) 맨 아래 **응용 프로그램 비밀번호**
3. 이름에 `github-actions` 를 적고 **새 응용 프로그램 비밀번호 추가**
4. 화면에 나온 `xxxx xxxx xxxx xxxx xxxx xxxx` 를 복사 — **이 화면을 닫으면 다시 볼 수 없습니다**

> 기존 `pickle-rest` 비밀번호를 그대로 써도 되지만, 용도를 나눠 두면 문제가 생겼을 때
> GitHub 쪽만 폐기할 수 있어서 새로 만드는 편이 안전합니다.

### 1-2. GitHub Secrets 등록

저장소 → **Settings → Secrets and variables → Actions → New repository secret**

| 이름 | 필수 | 값 |
| --- | --- | --- |
| `WP_USER` | ✅ | 워드프레스 아이디 (`admin`) |
| `WP_APP_PASSWORD` | ✅ | 1-1 에서 발급한 응용 프로그램 비밀번호 (공백 포함 그대로) |
| `ANTHROPIC_API_KEY` | 택1 | Anthropic API 키 |
| `OPENAI_API_KEY` | 택1 | OpenAI API 키 — **대문 이미지도 이 키로 만듭니다** |

> LLM 키는 둘 중 **하나만** 있어도 됩니다. 둘 다 있으면 `LLM_PROVIDER=auto` 가
> Anthropic 을 먼저 씁니다. 이미지까지 원하면 `OPENAI_API_KEY` 도 넣으세요.

### 1-3. (선택) Variables

같은 화면의 **Variables** 탭. 없으면 아래 기본값으로 동작합니다.

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `WP_URL` | `https://manyinfo.net` | 사이트 주소 (끝 `/` 없이) |
| `LLM_PROVIDER` | `auto` | `auto` · `anthropic` · `openai` |
| `WP_TOPIC` | (없음) | 정기 실행 때 쓸 고정 주제 |
| `WP_CATEGORY` | (없음) | 정기 실행 때 쓸 카테고리 |
| `CATEGORY_FALLBACK` | `일상·잡담` | 카테고리를 못 찾았을 때 쓸 곳 |
| `SITE_NAME` | `Many_Info` | 글 프롬프트에 들어가는 사이트 이름 |

---

## 2. 실행하기

1. 저장소 → **Actions** 탭
2. 왼쪽에서 **WP Auto Publish** 선택
3. **Run workflow** (오른쪽)
4. 입력 채우고 초록색 **Run workflow**

| 입력 | 설명 |
| --- | --- |
| **topic** (필수) | 글 주제. 예: `11월 말에 챙기면 좋은 생활 혜택` |
| **category** | 목록에서 고르거나, `지정 안 함 (기본 카테고리)` 선택 |
| **status** | `draft`(기본) 또는 `publish` — `publish` 는 **바로 공개**됩니다 |
| **generate_image** | 대문 이미지 생성 여부 (기본 `true`, `OPENAI_API_KEY` 필요) |
| **dry_run** | `true` 면 워드프레스에 **아무것도 쓰지 않고** 결과만 확인 |

끝나면 **Summary** 화면에 제목·글 ID·카테고리·이미지·확인이 필요한 항목이 나옵니다.
`draft` 글로 바로 가는 링크도 함께 표시됩니다. (`/wp-admin/post.php?post=<ID>&action=edit`)

---

## 3. 로컬에서 먼저 확인하기

```bash
cp .env.example .env          # 값 채우기 (커밋 금지)
pnpm wp:test                  # 순수 함수 테스트 (네트워크 없음)

# .env 를 읽어서 미리보기 (워드프레스에 쓰지 않음)
DRY_RUN=true pnpm wp:publish:env

# .env 를 읽어서 실제 실행 (draft 권장)
pnpm wp:publish:env
```

> `pnpm wp:publish` 는 셸에 export 된 환경변수만 읽습니다. `.env` 파일을 쓰려면
> `pnpm wp:publish:env` 를 쓰세요. `pnpm wp:publish:dry` 는 `DRY_RUN=true` 만 붙인
> 짧은 명령입니다(환경변수는 미리 export).

LLM 키 없이 파이프라인만 확인하려면 예시 글을 넣습니다.

```bash
DRY_RUN=true \
ARTICLE_JSON=scripts/fixtures/wp-article-sample.json \
TOPIC="예시 주제" CATEGORY="할인정보" \
node scripts/wp-publish.mjs
```

결과는 `out/wp-publish/<시각>/` 에 `result.json` · `article.html` · `summary.md` 로 남습니다.
(`out/` 은 `.gitignore` 에 있습니다.)

---

## 4. 동작 세부

### 카테고리

- 입력값이 **ID**(`15`), **이름**(`할인정보`), **슬러그**(`discount-info`) 어느 쪽이어도 찾습니다.
- `게임·리뷰 > 니케` 처럼 상위를 함께 적으면 마지막 조각(`니케`)을 씁니다.
- 띄어쓰기·가운뎃점 차이는 무시합니다 (`AI·개발` → `AI·개발 일지`).
- 못 찾으면 `CATEGORY_FALLBACK`(기본 `일상·잡담`)으로 올리고 **Summary 에 경고**를 남깁니다.
  실패로 멈추게 하려면 `STRICT_CATEGORY=true`.

### 대문 이미지

- `generate_image=true` **그리고** `OPENAI_API_KEY` 가 있을 때만 만듭니다.
- 기본 모델 `gpt-image-1`, 1536×1024, `medium`, WebP. `/wp/v2/media` 에 올리고
  글의 `featured_media` 로 연결합니다.
- 이미지 생성이 실패해도 **글은 올라갑니다** (이미지 없이). 이유는 Summary 에 적힙니다.
- 이미지 안에 글자·로고·얼굴을 넣지 말라고 프롬프트에 적어 두었습니다.

### 글 스타일

- 가벼운 존댓말, 짧은 문단, 소제목 3~5개, **3줄 요약 박스**, 비교 표 또는 체크리스트.
- 이모티콘은 글 전체 3~5개로 제한합니다.
- 작성자의 개인정보(이름·주소·직장·학교·계정·구매 이력)를 쓰지 말라고 프롬프트에 명시했습니다.

### 사실 확인

클라우드 LLM 에는 **검색 도구가 없습니다.** 그래서 프롬프트가 최신 가격·날짜·통계를
지어내지 말라고 막고, 확인이 필요한 항목을 `fact_check_notes` 로 돌려주게 했습니다.
Summary 의 **확인이 필요한 항목**을 보고 초안을 검수하세요.

### HTML 정리

LLM 이 뭘 보내든 `script` · `style` · `iframe` · `img` · `on*` 속성 · `javascript:` 링크는
버립니다. 남는 태그는 `h2/h3/p/ul/ol/li/strong/em/blockquote/table/a/div.summary-box` 등입니다.
LLM 이 마크다운을 보내면 HTML 로 변환합니다.

---

## 5. 정기 실행 (선택)

`.github/workflows/wp-publish.yml` 의 `schedule:` 주석을 풀고,
저장소 Variables 에 `WP_TOPIC`(과 원하면 `WP_CATEGORY`)을 넣습니다.

```yaml
schedule:
  - cron: '0 23 * * *'   # UTC 23:00 = 다음 날 08:00 KST
```

정기 실행은 입력값이 없으므로 `status` 는 자동으로 `draft`, `generate_image` 는 `true` 가 됩니다.

---

## 6. 문제가 생기면

| 증상 | 원인 · 해결 |
| --- | --- |
| `워드프레스 인증 실패(401)` | `WP_USER`/`WP_APP_PASSWORD` 확인. 비밀번호를 재발급했다면 Secret 도 갱신 |
| `403` + `rest_cannot_create` | 계정 권한 부족. `admin` 계정인지 확인 |
| `404 rest_no_route` | 보안 플러그인이 REST 를 막았거나 주소가 다름. `https://manyinfo.net/wp-json/wp/v2/posts` 가 열리는지 확인 |
| 카테고리를 못 찾음 | Summary 의 사용 가능 목록 확인. 또는 ID 로 입력 |
| `LLM 응답에서 JSON 을 찾지 못했습니다` | 모델이 형식을 어김. 다시 실행하거나 `OPENAI_MODEL`/`ANTHROPIC_MODEL` 변경 |
| 이미지가 없음 | `OPENAI_API_KEY` 없는 경우가 대부분. Summary 의 이유 확인 |
| 워크플로우가 안 보임 | Actions 탭에서 워크플로우 파일이 `main` 에 있는지 확인 (머지 전 브랜치면 안 보임) |

---

## 7. 보안·비용

- 비밀번호·API 키는 **GitHub Secrets** 에만 둡니다. 저장소 파일·로그에 남기지 않습니다.
- 스크립트는 키를 출력하지 않습니다. 실패 메시지에도 값이 들어가지 않습니다.
- 응용 프로그램 비밀번호는 워드프레스 프로필에서 **언제든 폐기**할 수 있습니다.
- LLM·이미지 호출은 **호출한 만큼 과금**됩니다. `dry_run` 은 LLM 은 부르되
  워드프레스 쓰기와 이미지 생성은 하지 않습니다(이미지 비용 절약).
- `publish` 는 즉시 공개됩니다. 처음에는 `draft` 로 돌려 본문을 확인하세요.
