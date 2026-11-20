/**
 * wp-publish.e2e.test.mjs — 실제 네트워크 없이 전체 발행 경로를 검증한다.
 *
 * 로컬에 가짜 워드프레스 + 가짜 Anthropic + 가짜 OpenAI 서버를 띄우고
 * `node scripts/wp-publish.mjs` 를 자식 프로세스로 실행한다.
 * 확인하는 것: 인증 확인 → 글 생성 → 카테고리 매칭 → 태그 → 이미지 → 글 생성.
 *
 *   node --test scripts/wp-publish.e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CATEGORIES = [
  { id: 2, parent: 0, slug: 'it-tips', name: 'IT·컴퓨터 꿀팁' },
  { id: 4, parent: 0, slug: 'game-review', name: '게임·리뷰' },
  { id: 12, parent: 4, slug: 'nikke', name: '니케' },
  { id: 10, parent: 0, slug: 'daily', name: '일상·잡담' },
  { id: 15, parent: 0, slug: 'discount-info', name: '할인정보' },
];

const ARTICLE = {
  title: '테스트용 생활 혜택 정리',
  excerpt: '테스트 요약입니다. 실제 사이트에는 올라가지 않습니다.',
  html:
    '<p>' +
    '테스트 본문 문장입니다. 이 글은 로컬 모의 서버로만 전송됩니다. '.repeat(20) +
    '</p>' +
    '<div class="summary-box"><p><strong>3줄 요약</strong></p><ul><li>하나</li><li>둘</li><li>셋</li></ul></div>' +
    '<h2>소제목</h2><p>본문입니다.</p>' +
    '<table><thead><tr><th>항목</th><th>값</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>',
  tags: ['테스트', '생활혜택'],
  image_prompt: 'A clean flat illustration, no text, no letters, no logos, no faces',
  image_alt: '테스트 이미지',
  needs_fact_check: false,
  fact_check_notes: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function startMockServer() {
  const state = {
    authSeen: [],
    posts: [],
    media: [],
    tagPosts: [],
    llmCalls: 0,
    imageCalls: 0,
    userCalls: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const body = await readBody(req);
    state.authSeen.push(req.headers.authorization || '');

    // ── LLM ──────────────────────────────────────────────
    if (p === '/v1/messages' && req.method === 'POST') {
      state.llmCalls += 1;
      const payload = JSON.parse(body.toString('utf8'));
      assert.ok(payload.model, '모델이 전달되어야 한다');
      assert.ok(payload.max_tokens > 0, 'max_tokens 가 있어야 한다');
      assert.ok(String(payload.system).includes('개인정보'), '시스템 프롬프트에 개인정보 규칙이 있어야 한다');
      return sendJson(res, 200, {
        content: [{ type: 'text', text: JSON.stringify(ARTICLE) }],
        usage: { input_tokens: 100, output_tokens: 200 },
      });
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      state.llmCalls += 1;
      return sendJson(res, 200, { choices: [{ message: { content: JSON.stringify(ARTICLE) } }] });
    }

    // ── 이미지 ───────────────────────────────────────────
    if (p === '/v1/images/generations' && req.method === 'POST') {
      state.imageCalls += 1;
      const payload = JSON.parse(body.toString('utf8'));
      assert.equal(payload.model, 'gpt-image-1');
      assert.equal(payload.size, '1536x1024');
      assert.ok(String(payload.prompt).includes('no text'), '이미지 프롬프트가 전달되어야 한다');
      return sendJson(res, 200, {
        data: [{ b64_json: Buffer.from('fake-webp-bytes').toString('base64') }],
      });
    }

    // ── 워드프레스 ────────────────────────────────────────
    if (p === '/wp-json/wp/v2/users/me') {
      state.userCalls += 1;
      return sendJson(res, 200, { id: 1, name: 'admin', slug: 'admin' });
    }

    if (p === '/wp-json/wp/v2/categories') {
      return sendJson(res, 200, CATEGORIES, { 'x-wp-totalpages': '1', 'x-wp-total': String(CATEGORIES.length) });
    }

    if (p === '/wp-json/wp/v2/tags' && req.method === 'GET') {
      return sendJson(res, 200, []);
    }

    if (p === '/wp-json/wp/v2/tags' && req.method === 'POST') {
      const payload = JSON.parse(body.toString('utf8'));
      state.tagPosts.push(payload.name);
      return sendJson(res, 201, { id: 100 + state.tagPosts.length, name: payload.name });
    }

    if (p === '/wp-json/wp/v2/media' && req.method === 'POST') {
      state.media.push({
        type: req.headers['content-type'],
        disposition: req.headers['content-disposition'],
        bytes: body.length,
      });
      return sendJson(res, 201, { id: 501, source_url: 'http://mock.local/cover.webp' });
    }

    if (p === '/wp-json/wp/v2/media/501' && req.method === 'POST') {
      return sendJson(res, 200, { id: 501 });
    }

    if (p === '/wp-json/wp/v2/posts' && req.method === 'POST') {
      const payload = JSON.parse(body.toString('utf8'));
      state.posts.push(payload);
      return sendJson(res, 201, {
        id: 9001,
        link: 'http://mock.local/?p=9001',
        status: payload.status,
        date: '2026-11-20T10:00:00',
      });
    }

    sendJson(res, 404, { code: 'rest_no_route', message: `no route: ${p}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

function runPublisher(port, extraEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-pub-e2e-'));
  const env = {
    ...process.env,
    WP_URL: `http://127.0.0.1:${port}`,
    WP_USER: 'admin',
    WP_APP_PASSWORD: 'abcd efgh ijkl mnop',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    OPENAI_API_KEY: 'test-openai-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
    LLM_PROVIDER: 'anthropic',
    TOPIC: '테스트 주제',
    CATEGORY: '할인정보',
    // 워크플로우 푸시 경로와 같이 비워 두면 JSON 의 status 를 따른다.
    POST_STATUS: '',
    GENERATE_IMAGE: 'true',
    DRY_RUN: 'false',
    OUTPUT_DIR: outDir,
    ...extraEnv,
  };
  // 실제 키가 섞여 들어가지 않게 테스트 값을 덮어쓴다. 빈 문자열은 "키 없음"으로 존중한다.
  env.ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY' in extraEnv ? extraEnv.ANTHROPIC_API_KEY : 'test-anthropic-key';
  env.OPENAI_API_KEY = 'OPENAI_API_KEY' in extraEnv ? extraEnv.OPENAI_API_KEY : 'test-openai-key';

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/wp-publish.mjs')], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, outDir }));
  });
}

test('전체 경로 — 글·태그·이미지·draft 업로드가 한 번에 된다', async () => {
  const { server, port, state } = await startMockServer();
  try {
    const run = await runPublisher(port);
    assert.equal(run.code, 0, run.stderr + run.stdout);

    assert.equal(state.userCalls, 1, '인증을 먼저 확인해야 한다');
    assert.equal(state.llmCalls, 1);
    assert.equal(state.imageCalls, 1);
    assert.equal(state.media.length, 1);
    assert.match(state.media[0].type, /^image\/webp/);
    assert.match(state.media[0].disposition, /wp-cover-.*\.webp/);
    assert.ok(state.media[0].bytes > 0);

    assert.equal(state.posts.length, 1);
    const post = state.posts[0];
    assert.equal(post.title, ARTICLE.title);
    assert.equal(post.status, 'draft');
    assert.equal(post.featured_media, 501);
    assert.deepEqual(post.categories, [15]);
    assert.deepEqual(post.tags, [101, 102]);
    assert.ok(post.content.includes('class="summary-box"'));
    assert.ok(!post.content.includes('<script'));

    const resultDir = fs.readFileSync(path.join(run.outDir, 'latest.txt'), 'utf8').trim();
    const result = JSON.parse(fs.readFileSync(path.join(resultDir, 'result.json'), 'utf8'));
    assert.equal(result.post.id, 9001);
    assert.equal(result.category.matched.id, 15);
    assert.equal(result.image.uploaded.id, 501);

    const summary = fs.readFileSync(path.join(resultDir, 'summary.md'), 'utf8');
    assert.ok(summary.includes('임시저장(draft)'), summary);
    assert.ok(summary.includes(ARTICLE.title), summary);
  } finally {
    server.close();
  }
});

test('publish 선택 — 상태가 그대로 전달되고 이미지는 생략할 수 있다', async () => {
  const { server, port, state } = await startMockServer();
  try {
    const run = await runPublisher(port, { POST_STATUS: 'publish', GENERATE_IMAGE: 'false' });
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(state.imageCalls, 0);
    assert.equal(state.media.length, 0);
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].status, 'publish');
    assert.equal(state.posts[0].featured_media, undefined);
  } finally {
    server.close();
  }
});

test('wp-queue JSON — LLM 키 없이 JSON 만으로 올리고 JSON status 를 따른다', async () => {
  const { server, port, state } = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-queue-'));
  const file = path.join(dir, '2026-11-20-queue-post.json');
  const article = {
    title: '큐로 올린 테스트 글',
    slug: '2026-11-20 Queue Test',
    excerpt: '큐 경로 테스트입니다.',
    category: '할인정보',
    tags: ['큐', '테스트'],
    summary_points: ['첫째', '둘째', '셋째'],
    content_html: '<p>' + '본문 문장입니다. '.repeat(40) + '</p><h2>소제목</h2><p>내용입니다.</p>',
    fact_check_notes: ['가격은 공식 페이지에서 확인'],
    needs_fact_check: true,
    status: 'pending',
  };
  fs.writeFileSync(file, JSON.stringify(article), 'utf8');

  try {
    const run = await runPublisher(port, {
      ARTICLE_JSON: file,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      TOPIC: '',
      CATEGORY: '',
      GENERATE_IMAGE: 'false',
    });
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(state.llmCalls, 0, 'LLM 을 부르면 안 된다');
    assert.equal(state.imageCalls, 0);
    assert.equal(state.media.length, 0);

    assert.equal(state.posts.length, 1);
    const post = state.posts[0];
    assert.equal(post.title, article.title);
    assert.equal(post.status, 'pending', 'JSON 의 status 를 따라야 한다');
    assert.equal(post.slug, '2026-11-20-queue-test');
    assert.deepEqual(post.categories, [15]);
    assert.ok(post.content.includes('3줄 요약'), post.content.slice(0, 200));
    assert.ok(post.content.includes('<li>첫째</li>'));
    assert.ok(post.content.includes('style="background:#f7f7f9'), '요약 박스에 스타일이 붙어야 한다');

    const resultDir = fs.readFileSync(path.join(run.outDir, 'latest.txt'), 'utf8').trim();
    const result = JSON.parse(fs.readFileSync(path.join(resultDir, 'result.json'), 'utf8'));
    assert.equal(result.article.slug, '2026-11-20-queue-test');
    assert.equal(result.postStatus.status, 'pending');
    assert.equal(result.postStatus.source, 'JSON status');
    assert.equal(result.article.factCheckNotes[0], '가격은 공식 페이지에서 확인');
  } finally {
    server.close();
  }
});

test('wp-queue JSON — 워크플로우가 준 status 가 JSON 보다 우선한다', async () => {
  const { server, port, state } = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-queue-'));
  const file = path.join(dir, 'publish-attempt.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      title: '공개하려던 큐 글',
      content_html: '<p>' + '본문 문장입니다. '.repeat(40) + '</p>',
      status: 'publish',
    }),
    'utf8',
  );

  try {
    const run = await runPublisher(port, {
      ARTICLE_JSON: file,
      POST_STATUS: 'draft',
      GENERATE_IMAGE: 'false',
    });
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].status, 'draft', 'POST_STATUS 가 이긴다');
  } finally {
    server.close();
  }
});

test('인증 실패 — LLM 을 부르기 전에 멈춘다', async () => {
  const server = http.createServer((req, res) => {
    sendJson(res, 401, { code: 'rest_forbidden', message: 'unauthorized' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const run = await runPublisher(port);
    assert.notEqual(run.code, 0);
    assert.ok(run.stderr.includes('워드프레스 인증 실패'), run.stderr);
  } finally {
    server.close();
  }
});
