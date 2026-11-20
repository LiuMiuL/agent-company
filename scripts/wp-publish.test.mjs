/**
 * wp-publish.test.mjs — 클라우드 발행 스크립트의 순수 함수 검증.
 *
 *   node --test scripts/wp-publish.test.mjs
 *
 * 네트워크를 쓰지 않는다. 워드프레스 호출은 실 실행에서만 일어난다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeHtml,
  coerceToHtml,
  decorateHtml,
  extractJson,
  normalizeArticle,
  normalizeSlug,
  matchCategory,
  normalizeCategoryName,
  deriveExcerpt,
  readConfig,
  resolvePostStatus,
} from './wp-publish.mjs';

const CATEGORIES = [
  { id: 2, parent: 0, slug: 'it-tips', name: 'IT·컴퓨터 꿀팁' },
  { id: 3, parent: 0, slug: 'ai-dev', name: 'AI·개발 일지' },
  { id: 4, parent: 0, slug: 'game-review', name: '게임·리뷰' },
  { id: 12, parent: 4, slug: 'nikke', name: '니케' },
  { id: 5, parent: 0, slug: 'life-admin', name: '생활·행정 꿀정보' },
  { id: 15, parent: 0, slug: 'discount-info', name: '할인정보' },
  { id: 10, parent: 0, slug: 'daily', name: '일상·잡담' },
];

test('sanitizeHtml — 위험한 요소와 속성을 버린다', () => {
  const dirty = `
    <p onclick="steal()">안녕</p>
    <script>alert(1)</script>
    <style>body{display:none}</style>
    <iframe src="https://evil.example"></iframe>
    <a href="javascript:alert(1)">링크</a>
    <a href="https://example.com" onmouseover="x()">좋은 링크</a>
    <img src="https://example.com/a.png" alt="x">
    <h1>큰 제목</h1>
  `;
  const clean = sanitizeHtml(dirty);
  assert.ok(!/script/i.test(clean), clean);
  assert.ok(!/style=/i.test(clean), clean);
  assert.ok(!/iframe/i.test(clean), clean);
  assert.ok(!/javascript:/i.test(clean), clean);
  assert.ok(!/onclick|onmouseover/i.test(clean), clean);
  assert.ok(!/<img/i.test(clean), clean);
  assert.ok(clean.includes('<a href="https://example.com" rel="noopener noreferrer">'), clean);
  assert.ok(clean.includes('<h2>큰 제목</h2>'), clean);
});

test('sanitizeHtml — 요약 박스 class 만 허용한다', () => {
  const clean = sanitizeHtml('<div class="summary-box evil" id="x" style="color:red">요약</div>');
  assert.equal(clean, '<div class="summary-box">요약</div>');
});

test('coerceToHtml — 마크다운을 HTML 로 바꾼다', () => {
  const md = `## 소제목

본문 **강조** 문장입니다.

- 하나
- 둘

| 항목 | 값 |
|---|---|
| A | 1 |

> 인용문`;
  const html = coerceToHtml(md);
  assert.ok(html.includes('<h2>소제목</h2>'), html);
  assert.ok(html.includes('<strong>강조</strong>'), html);
  assert.ok(html.includes('<ul>\n<li>하나</li>'), html);
  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('<th>항목</th>'), html);
  assert.ok(html.includes('<blockquote><p>인용문</p></blockquote>'), html);
});

test('coerceToHtml — 태그 없는 글은 문단으로 감싼다', () => {
  const html = coerceToHtml('첫 문단입니다.\n\n둘째 문단입니다.');
  assert.equal(html, '<p>첫 문단입니다.</p>\n<p>둘째 문단입니다.</p>');
});

test('decorateHtml — 표와 요약 박스에 스타일을 준다', () => {
  const html = decorateHtml('<div class="summary-box"><p>x</p></div><table><tr><th>a</th><td>b</td></tr></table>');
  assert.ok(html.includes('background:#f7f7f9'), html);
  assert.ok(html.includes('overflow-x:auto'), html);
  assert.ok(html.includes('<th style="border:1px solid #e5e7eb'), html);
  assert.ok(html.includes('</table></div>'), html);
});

test('extractJson — 펜스와 잡설이 섞여도 객체를 꺼낸다', () => {
  const text = '설명입니다.\n```json\n{"title":"중괄호 } 가 든 제목","html":"<p>x</p>"}\n```\n끝.';
  const parsed = extractJson(text);
  assert.equal(parsed.title, '중괄호 } 가 든 제목');
});

test('extractJson — JSON 이 없으면 null', () => {
  assert.equal(extractJson('그냥 글입니다.'), null);
  assert.equal(extractJson('{"broken": }'), null);
});

test('matchCategory — ID·이름·슬러그·부분·상위 표기 모두 찾는다', () => {
  assert.equal(matchCategory(CATEGORIES, '15').category.id, 15);
  assert.equal(matchCategory(CATEGORIES, '할인정보').category.id, 15);
  assert.equal(matchCategory(CATEGORIES, 'IT·컴퓨터 꿀팁').category.id, 2);
  assert.equal(matchCategory(CATEGORIES, 'it-tips').category.id, 2);
  assert.equal(matchCategory(CATEGORIES, 'AI·개발').category.id, 3);
  assert.equal(matchCategory(CATEGORIES, '게임·리뷰 > 니케').category.id, 12);
  assert.equal(matchCategory(CATEGORIES, '없는카테고리'), null);
  assert.equal(matchCategory(CATEGORIES, ''), null);
});

test('normalizeCategoryName — 구분자를 없애고 비교한다', () => {
  assert.equal(normalizeCategoryName('AI·개발 일지'), 'ai개발일지');
  assert.equal(normalizeCategoryName('it-tips'), 'ittips');
});

test('normalizeArticle — HTML 정리·요약·태그·이미지 정보를 만든다', () => {
  const article = normalizeArticle(
    {
      title: '테스트 제목',
      html: '<p>' + '본문 문장입니다. '.repeat(60) + '</p><script>x</script>',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      image_prompt: 'prompt',
      image_alt: '',
      needs_fact_check: true,
      fact_check_notes: ['가격 확인'],
    },
    { topic: '테스트', category: '할인정보' },
  );
  assert.equal(article.title, '테스트 제목');
  assert.ok(!/script/i.test(article.html));
  assert.equal(article.tags.length, 6);
  assert.equal(article.imageAlt, '테스트 제목 대표 이미지');
  assert.ok(article.excerpt.length > 0);
  assert.ok(article.needsFactCheck);
  assert.equal(article.factCheckNotes[0], '가격 확인');
});

test('normalizeArticle — 제목이 없으면 주제로 대체하고 기록한다', () => {
  const article = normalizeArticle({ html: '<p>본문</p>' }, { topic: '연말 혜택', category: '' });
  assert.equal(article.title, '연말 혜택 정리');
  assert.ok(article.issues.some((i) => i.includes('제목')));
});

test('deriveExcerpt — 태그를 지우고 길이를 자른다', () => {
  const excerpt = deriveExcerpt('<p>짧은 <strong>요약</strong>입니다.</p>');
  assert.equal(excerpt, '짧은 요약입니다.');
  const long = deriveExcerpt('<p>' + '가나다라마바사. '.repeat(40) + '</p>', 50);
  assert.ok(long.length <= 51, long);
});

test('readConfig — 기본값은 draft 이고 잘못된 상태는 거부한다', () => {
  const cfg = readConfig({});
  assert.equal(cfg.wpUrl, 'https://manyinfo.net');
  assert.equal(cfg.postStatus, 'draft');
  assert.equal(cfg.postStatusExplicit, false);
  assert.equal(cfg.categoryFallback, '일상·잡담');
  assert.throws(() => readConfig({ POST_STATUS: 'public' }), /POST_STATUS/);
});

test('readConfig — POST_STATUS=auto 는 "환경변수로 안 정함"으로 읽는다', () => {
  const auto = readConfig({ POST_STATUS: 'auto' });
  assert.equal(auto.postStatus, 'draft');
  assert.equal(auto.postStatusExplicit, false);

  const explicit = readConfig({ POST_STATUS: 'PUBLISH' });
  assert.equal(explicit.postStatus, 'publish');
  assert.equal(explicit.postStatusExplicit, true);
});

test('resolvePostStatus — POST_STATUS > JSON status > draft 순서다', () => {
  const explicit = readConfig({ POST_STATUS: 'pending' });
  assert.deepEqual(resolvePostStatus(explicit, { status: 'publish' }), { status: 'pending', source: 'POST_STATUS' });

  const auto = readConfig({});
  assert.deepEqual(resolvePostStatus(auto, { status: 'draft' }), { status: 'draft', source: 'JSON status' });
  assert.equal(resolvePostStatus(auto, { status: 'PUBLISH' }).status, 'publish');
  assert.equal(resolvePostStatus(auto, {}).status, 'draft');
  assert.equal(resolvePostStatus(auto, { status: 'auto' }).status, 'draft');

  const invalid = resolvePostStatus(auto, { status: 'public' });
  assert.equal(invalid.status, 'draft');
  assert.ok(invalid.warning.includes('public'), invalid.warning);
});

test('normalizeSlug — 공백·대문자·특수문자를 정리하고 한글은 남긴다', () => {
  assert.equal(normalizeSlug('  My Post / Title! '), 'my-post-title');
  assert.equal(normalizeSlug('2026-11-20 할인_정리'), '2026-11-20-할인-정리');
  assert.equal(normalizeSlug('---'), '');
  assert.equal(normalizeSlug(undefined), '');
});

test('normalizeArticle — content_html·summary_points·slug·category 를 받는다', () => {
  const article = normalizeArticle(
    {
      title: '큐 글로 올린 글',
      slug: 'queue-post',
      category: '할인정보',
      content_html: '<p>' + '본문 문장입니다. '.repeat(60) + '</p>',
      summary_points: ['하나', '둘', '셋'],
    },
    { topic: '', category: '할인정보' },
  );
  assert.equal(article.slug, 'queue-post');
  assert.equal(article.category, '할인정보');
  assert.ok(article.html.includes('3줄 요약'), article.html.slice(0, 120));
  assert.ok(article.html.includes('<li>하나</li>'), article.html.slice(0, 200));
  assert.ok(article.html.includes('style="background:#f7f7f9'), '요약 박스에 스타일이 붙어야 한다');
});

test('normalizeArticle — 본문에 요약 박스가 있으면 summary_points 로 또 만들지 않는다', () => {
  const article = normalizeArticle(
    {
      title: '요약 박스가 있는 글',
      content_html: '<div class="summary-box"><p>이미 요약</p></div><p>' + '본문입니다. '.repeat(60) + '</p>',
      summary_points: ['하나', '둘', '셋'],
    },
    { topic: '', category: '' },
  );
  assert.equal((article.html.match(/summary-box/g) || []).length, 1);
  assert.ok(!article.html.includes('3줄 요약'));
});
