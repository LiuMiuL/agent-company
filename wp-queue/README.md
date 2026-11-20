# wp-queue — 폰 클로드가 쓰는 글을 워드프레스로 보내는 큐

여기에 `wp-queue/2026-11-20-글-슬러그.json` 처럼 **JSON 파일 하나를 만들어 `main` 에 커밋·푸시하면**,
GitHub Actions(`WP Auto Publish`)가 그 파일을 `manyinfo.net` 워드프레스에 **임시저장(draft)** 으로 올립니다.

- **LLM API 키가 필요 없습니다.** 글은 이미 JSON 안에 있으니까요. (Anthropic·OpenAI 호출 없음, 비용 0원)
- 필요한 건 워드프레스 업로드용 비밀값 두 개뿐입니다: `WP_USER` · `WP_APP_PASSWORD`
- 워크플로우는 **이번 푸시에서 추가·수정된 `wp-queue/*.json` 만** 골라 올립니다. 다른 파일을 고쳐도 다시 올라가지 않습니다.
- 하위 폴더(`wp-queue/examples/…`)는 대상이 아닙니다. 예시 파일을 그냥 둘 수 있는 이유입니다.

```
폰 클로드(Claude 앱 · Claude Code)
   │  JSON 작성 (제목·본문 HTML·태그·카테고리)
   ▼
wp-queue/2026-11-20-주제.json  ──commit & push──▶  main
                                                  │
                                    GitHub Actions (WP Auto Publish)
                                                  │  이번 푸시에서 바뀐 JSON 만
                                                  ▼
                                    /wp/v2/posts  →  draft
                                                  │
                                                  ▼
                                    Actions Summary + 글 편집 링크
```

---

## 1. 한 번만 하면 되는 설정

저장소 → **Settings → Secrets and variables → Actions**

| 이름 | 필수 | 값 |
| --- | --- | --- |
| `WP_USER` | ✅ | 워드프레스 아이디 (`admin`) |
| `WP_APP_PASSWORD` | ✅ | manyinfo.net 관리자 → 프로필 → **응용 프로그램 비밀번호** (`xxxx xxxx …` 공백 그대로) |
| `ANTHROPIC_API_KEY` · `OPENAI_API_KEY` | ❌ | 이 큐 경로에서는 **필요 없습니다.** Actions 화면에서 `topic` 으로 새 글을 만들 때만 씁니다. |

> 발급 절차는 [CLOUD_WP_GUIDE.md](../CLOUD_WP_GUIDE.md) 1-1 과 같습니다. 동작 확인은
> Actions → **WP Auto Publish** → **Run workflow** 에서 `dry_run` 을 켜고 한 번 돌려 보세요.

---

## 2. 파일 이름

```
wp-queue/2026-11-20-연말-정산-환급.json
wp-queue/2026-11-21-치이카와-팝업-후기.json
```

- `wp-queue/` **바로 아래**에 두어야 합니다. 하위 폴더는 무시됩니다.
- 확장자는 `.json`. 날짜와 슬러그를 붙이면 나중에 찾기 쉽습니다.
- **한 파일 = 한 글.** 같은 파일을 고쳐서 다시 푸시하면 **새 글이 하나 더 생깁니다**(수정이 아니라 재업로드).
  이미 올라간 글을 고칠 때는 워드프레스 관리자에서 고치세요.
- 올린 뒤 파일은 지워도 됩니다. 삭제는 아무것도 올리지 않습니다.
- 파일 하나가 실패해도 같은 푸시의 다른 파일은 계속 올라갑니다. 실패한 파일은 Actions 로그에 `::error::` 로 표시됩니다.

---

## 3. JSON 스키마

필수는 **`title`, `content_html`** 두 개입니다. 나머지는 비워도 스크립트가 채웁니다.

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `title` | string | ✅ | 글 제목. 90자까지만 남습니다. |
| `content_html` | string | ✅ | 본문 HTML 조각. `html` 이나 `content` 라는 이름도 받습니다. 마크다운으로 보내도 HTML 로 변환합니다. |
| `slug` | string | | 주소 조각. `2026-11-20-refund` → `manyinfo.net/2026-11-20-refund/`. 비우면 워드프레스가 제목으로 만듭니다. |
| `excerpt` | string | | 목록에 보이는 요약. 비우면 본문 앞부분에서 150자. |
| `category` | string | | 카테고리 이름·슬러그·ID. 아래 목록 참고. 비우면 사이트 기본값. |
| `tags` | string[] | | 태그 최대 6개. 없는 태그는 워드프레스에 새로 만듭니다. |
| `summary_points` | string[] | | 3개를 넣으면 본문 맨 앞에 **3줄 요약 박스**를 만들어 줍니다. 본문에 이미 `summary-box` 가 있으면 건드리지 않습니다. |
| `needs_fact_check` | boolean | | `true` 면 Actions Summary 에 "확인 필요"로 표시됩니다. |
| `fact_check_notes` | string[] | | 확인이 필요한 항목 목록. Summary 에 그대로 나옵니다. |
| `image_prompt` | string | | 대문 이미지 프롬프트. 이미지 생성은 기본으로 꺼져 있습니다(`OPENAI_API_KEY` + 변수 설정 필요). |
| `image_alt` | string | | 대문 이미지 대체 텍스트. |
| `status` | string | | `draft`(기본) · `pending` · `private` · `publish`. **비우면 draft.** `publish` 는 바로 공개되니 정말 필요할 때만. |

모르는 필드는 경고만 남기고 무시합니다. 오타가 의심되면 Actions 로그의 `주의:` 줄을 보세요.

### 본문 HTML 규칙

- `<html>`, `<body>`, `<h1>` 은 쓰지 않습니다. 제목은 `title` 에 넣습니다.
- 쓸 수 있는 태그: `h2`, `h3`, `p`, `ul`, `ol`, `li`, `strong`, `em`, `blockquote`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `a`, `hr`, `br`, `code`, `div class="summary-box"`, `div class="tip-box"`.
- `script`, `style`, `iframe`, `img`, `on*` 속성, `javascript:` 링크, `style="…"` 인라인 스타일은 **자동으로 버려집니다.**
- 표는 첫 줄을 `<th>` 로. 요약 박스는 `<div class="summary-box">` 로 감싸면 스크립트가 예쁘게 입힙니다.
- 사진은 이 경로로 올릴 수 없습니다(이미지 태그가 제거됨). 사진이 필요하면 워드프레스 관리자에서 넣으세요.

### 카테고리 (manyinfo.net 현재 목록)

| 이름 | 슬러그 | ID |
| --- | --- | --- |
| 할인정보 | `discount-info` | 15 |
| IT·컴퓨터 꿀팁 | `it-tips` | 2 |
| AI·개발 일지 | `ai-dev` | 3 |
| 생활·행정 꿀정보 | `life-admin` | 5 |
| 금융·절약·앱테크 | `finance-saving` | 6 |
| 게임·리뷰 | `game-review` | 4 |
| 니케 | `nikke` | 12 |
| 로스트아크 | `lostark` | 13 |
| 맛집·카페 리뷰 | `food-cafe` | 7 |
| 여행·숙소·항공 | `travel` | 8 |
| 굿즈·팝업·덕질 | `goods-popup` | 9 |
| 일상·잡담 | `daily` | 10 |
| 공지·블로그 소개 | `notice` | 11 |

띄어쓰기·가운뎃점 차이는 무시하고 찾습니다(`AI·개발` → `AI·개발 일지`). 못 찾으면 `일상·잡담` 으로 올라가고 Summary 에 경고가 남습니다.

---

## 4. 글쓰기 규칙 (이 블로그의 톤)

1. **가벼운 존댓말.** 안내문이 아니라 사람이 말하듯. 문단은 2~4문장으로 짧게.
2. **3줄 요약 → 소제목 3~5개 → 비교 표나 체크리스트 1개 → 마무리.**
3. 이모티콘은 글 전체에서 3~5개만.
4. **확인되지 않은 가격·날짜·통계·정책을 단정하지 않습니다.** 최신 정보는 "공식 페이지에서 확인하세요"로 쓰고, 확인이 필요한 항목은 `fact_check_notes` 에 적습니다.
5. **개인정보 금지.** 작성자의 이름·나이·주소·직장·학교·계정·가족·연인·구매 이력을 쓰지 않습니다. 없는 경험담을 만들지 않습니다.
6. 낚시성 제목 금지. 핵심 키워드를 앞쪽에, 60자 안쪽으로.

---

## 5. 폰 클로드에 붙여넣는 프롬프트

Claude 앱(또는 Claude Code)에서 GitHub 저장소 `LiuMiuL/agent-company` 에 파일을 만들 수 있게 연결해 두고,
아래를 그대로 붙여넣은 뒤 주제만 바꾸세요.

```text
너는 한국어 정보 블로그 'Many_Info'(manyinfo.net)에 올릴 글을 쓴다.
아래 스키마로 JSON 하나를 만들어 저장소 LiuMiuL/agent-company 의
wp-queue/<오늘 날짜 YYYY-MM-DD>-<영문 슬러그>.json 으로 커밋·푸시해라.
푸시하면 GitHub Actions 가 자동으로 워드프레스에 draft 로 올린다. LLM API 키는 필요 없다.

주제: <여기에 주제>

[스키마]
{
  "title": "60자 안쪽 제목",
  "slug": "영문-소문자-하이픈",
  "excerpt": "150자 안쪽 요약",
  "category": "할인정보 | IT·컴퓨터 꿀팁 | AI·개발 일지 | 생활·행정 꿀정보 | 금융·절약·앱테크 | 게임·리뷰 | 니케 | 로스트아크 | 맛집·카페 리뷰 | 여행·숙소·항공 | 굿즈·팝업·덕질 | 일상·잡담 | 공지·블로그 소개",
  "tags": ["태그1", "태그2", "태그3"],
  "summary_points": ["요약1", "요약2", "요약3"],
  "content_html": "<p>도입 2~3문장</p><h2>소제목</h2><p>본문</p>…",
  "fact_check_notes": ["확인이 필요한 항목"],
  "needs_fact_check": false,
  "status": "draft"
}

[규칙]
- content_html 은 HTML 조각만. h2/h3/p/ul/ol/li/strong/em/blockquote/table/thead/tbody/tr/th/td/a/hr/br/code 와 div class="summary-box" 만 쓴다.
- html/body/h1/script/style/iframe/img/인라인 style 은 쓰지 않는다. 써도 자동으로 지워진다.
- 구조: 도입 → (summary_points 로 3줄 요약이 자동 생성됨) → h2 소제목 3~5개 → 표 또는 체크리스트 1개 → 마무리.
- 가벼운 존댓말, 짧은 문단, 이모티콘 3~5개.
- 확인되지 않은 가격·날짜·통계·매장 정보를 지어내지 않는다. 필요한 건 "공식 페이지에서 확인하세요"로 쓰고 fact_check_notes 에 적는다.
- 작성자 개인정보(이름·나이·주소·직장·학교·계정·가족·연인·구매 이력)를 쓰지 않는다. 없는 경험담을 만들지 않는다.
- status 는 "draft" 로 둔다.
- 파일 하나만 만들고, 커밋 메시지는 "post: <제목>" 으로 한다. 다른 파일은 건드리지 않는다.
```

> Claude 앱에서 GitHub 쓰기 권한이 없으면, Claude 가 만들어 준 JSON 을 복사해
> GitHub 웹에서 `wp-queue/` 폴더에 **Add file → Create new file** 로 붙여넣어도 똑같이 동작합니다.

---

## 6. 예시 JSON

실제로 동작하는 전체 예시: [`examples/sample-article.json`](./examples/sample-article.json)
(하위 폴더라서 이 파일을 푸시해도 글이 올라가지 않습니다.)

```json
{
  "title": "연말정산 미리보기, 지금 챙기면 좋은 것 3가지",
  "slug": "year-end-tax-preview-checklist",
  "excerpt": "연말정산 전에 확인하면 좋은 항목을 순서대로 정리했습니다.",
  "category": "금융·절약·앱테크",
  "tags": ["연말정산", "소득공제", "절약"],
  "summary_points": ["사전 점검은 11월에", "카드·의료비는 한도부터", "증빙은 관서별로 다르다"],
  "content_html": "<p>연말정산은 1월에 몰아서 준비하면 놓치는 게 생깁니다.</p><h2>먼저 확인할 것</h2><p>...</p>",
  "fact_check_notes": ["공제 한도는 해마다 바뀌니 국세청 안내 확인"],
  "needs_fact_check": true,
  "status": "draft"
}
```

---

## 7. 올라갔는지 확인하기

1. 저장소 **Actions** 탭 → **WP Auto Publish** → 방금 실행
2. **Summary** 에 제목·상태·카테고리·태그·글 ID·**편집 링크**(`manyinfo.net/wp-admin/post.php?post=<ID>&action=edit`)가 나옵니다.
3. 워드프레스 관리자 → 글 → 임시저장에서 본문을 읽고, 고칠 게 없으면 **공개**를 누릅니다.
4. 실패했다면 로그의 `[wp-publish] 실패: …` 줄을 보세요. JSON 문법 오류는 파일 경로와 함께 표시됩니다.

### 자주 나는 실패

| 로그 | 원인 · 해결 |
| --- | --- |
| `ARTICLE_JSON(…) 을 JSON 으로 읽지 못했습니다` | 쉼표·따옴표 오류. JSON 검사기로 확인 |
| `글 본문이 없습니다` | `content_html` 이 비었거나 이름이 다름(`contents` 등) |
| `워드프레스 인증 실패(401)` | `WP_USER` / `WP_APP_PASSWORD` 확인 |
| `카테고리를 찾지 못해 … 대체` | 카테고리 이름 오타. 위 표의 이름·슬러그·ID 사용 |
| 워크플로우가 안 돌았다 | 파일이 `wp-queue/` 바로 아래 `.json` 인지, `main` 에 푸시했는지 확인 |

---

## 8. 로컬에서 먼저 확인하기 (선택)

```bash
# 워드프레스에 쓰지 않고 결과만 확인 (카테고리 조회는 공개 GET)
DRY_RUN=true ARTICLE_JSON=wp-queue/2026-11-20-글.json node scripts/wp-publish.mjs
```

`out/wp-publish/<시각>/` 에 `result.json` · `article.html` · `summary.md` 가 남습니다.
