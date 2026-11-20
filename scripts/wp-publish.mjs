#!/usr/bin/env node
/**
 * wp-publish.mjs — 클라우드(GitHub Actions)에서 글을 생성해 manyinfo.net 워드프레스에 올린다.
 *
 * ── 왜 이 파일이 코어 밖에 있나 ─────────────────────────────────────────────
 * 로컬 편집국(agents/*)은 content/posts/*.md 를 쓰고 사람이 어드민에서 발행한다.
 * 이 스크립트는 그 파이프라인이 아니라 **클라우드 실행 경로**다. 저장소의 글 파일을
 * 읽지도 쓰지도 않고, 워드프레스 REST API 로만 결과를 낸다.
 *   자세한 배경: wiki/decisions/ADR-0004-cloud-wordpress-publishing.md
 *
 * ── 하는 일 ────────────────────────────────────────────────────────────────
 *   1. TOPIC 으로 LLM(Anthropic 또는 OpenAI)에 글을 요청한다 (JSON 응답).
 *      ARTICLE_JSON=<경로> 를 주면 LLM 을 부르지 않고 그 파일을 쓴다 — 폰 클로드가
 *      쓴 글을 wp-queue/ 에 커밋하면 GitHub Actions 가 이 경로로 올린다(키 불필요).
 *   2. 받은 HTML 을 정리한다 — 허용 태그만 남기고 스크립트·이벤트 속성을 버린다.
 *   3. CATEGORY 를 워드프레스 카테고리와 매칭한다 (이름·슬러그·ID).
 *   4. (선택) OpenAI Images 로 대문 이미지를 만들어 /wp/v2/media 에 올리고 featured_media 로 연결한다.
 *   5. /wp/v2/posts 에 글을 만든다. 기본값은 `draft`(임시저장)다.
 *      상태 우선순위: POST_STATUS > ARTICLE_JSON 의 status > draft.
 *
 * ── 안전 원칙 ──────────────────────────────────────────────────────────────
 *   · 비밀값은 환경변수에서만 읽는다. 하드코딩·로그 출력·파일 기록 금지.
 *   · DRY_RUN=true 면 워드프레스에 **아무것도 쓰지 않는다** (읽기만).
 *   · 발행(publish)은 사람이 워크플로우 입력이나 JSON 에 명시할 때만 일어난다.
 *
 * 사용:
 *   node scripts/wp-publish.mjs
 *   ARTICLE_JSON=wp-queue/2026-11-20-slug.json node scripts/wp-publish.mjs   # LLM 키 불필요
 *   DRY_RUN=true ARTICLE_JSON=scripts/fixtures/wp-article-sample.json \
 *     TOPIC="예시 주제" node scripts/wp-publish.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LOG_PREFIX = '[wp-publish]';
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, '주의:', ...args);

const DEFAULT_WP_URL = 'https://manyinfo.net';
const DEFAULT_CATEGORY_FALLBACK = '일상·잡담';
const ALLOWED_POST_STATUSES = ['draft', 'publish', 'pending', 'private'];

// ARTICLE_JSON 에서 읽는 필드. 여기 없는 키는 오타일 수 있어 경고만 남기고 무시한다.
const KNOWN_ARTICLE_KEYS = new Set([
  'title',
  'slug',
  'excerpt',
  'category',
  'tags',
  'content_html',
  'html',
  'content',
  'summary_points',
  'fact_check_notes',
  'needs_fact_check',
  'image_prompt',
  'image_alt',
  'status',
]);
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const ANTHROPIC_FALLBACK_MODELS = ['claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'];
const OPENAI_FALLBACK_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];

// ── 환경변수 ────────────────────────────────────────────────────────────────

function envBool(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  warn(`${name}="${raw}" 를 불리언으로 읽지 못해 기본값(${fallback})을 씁니다.`);
  return fallback;
}

function envStr(name, fallback = '', env = process.env) {
  const raw = env[name];
  return raw == null || raw.trim() === '' ? fallback : raw.trim();
}

export function readConfig(env = process.env) {
  const e = (name, fallback = '') => envStr(name, fallback, env);
  const b = (name, fallback) => envBool(name, fallback, env);
  const wpUrl = (e('WP_URL', DEFAULT_WP_URL) || DEFAULT_WP_URL).replace(/\/+$/, '');
  // POST_STATUS 가 비었거나 'auto' 면 ARTICLE_JSON 의 status 를 따르고,
  // 그것도 없으면 가장 안전한 기본값 draft 로 올린다.
  const rawStatus = e('POST_STATUS', '').toLowerCase();
  const statusAuto = !rawStatus || rawStatus === 'auto';
  if (!statusAuto && !ALLOWED_POST_STATUSES.includes(rawStatus)) {
    throw new Error(`POST_STATUS="${rawStatus}" 는 쓸 수 없습니다. 허용: ${ALLOWED_POST_STATUSES.join(', ')}, auto`);
  }
  const postStatus = statusAuto ? 'draft' : rawStatus;

  const provider = e('LLM_PROVIDER', 'auto').toLowerCase();
  if (!['auto', 'anthropic', 'openai'].includes(provider)) {
    throw new Error(`LLM_PROVIDER="${provider}" 는 쓸 수 없습니다. 허용: auto, anthropic, openai`);
  }

  const cfg = {
    wpUrl,
    wpUser: e('WP_USER'),
    wpAppPassword: e('WP_APP_PASSWORD'),
    llmProvider: provider,
    anthropicKey: e('ANTHROPIC_API_KEY'),
    openaiKey: e('OPENAI_API_KEY'),
    anthropicModel: e('ANTHROPIC_MODEL', DEFAULT_ANTHROPIC_MODEL),
    openaiModel: e('OPENAI_MODEL', DEFAULT_OPENAI_MODEL),
    // 테스트·프록시용. 비워 두면 실제 API 주소를 쓴다.
    anthropicBaseUrl: e('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
    openaiBaseUrl: e('OPENAI_BASE_URL', 'https://api.openai.com').replace(/\/+$/, ''),
    topic: e('TOPIC'),
    // 워크플로우 select 의 '지정 안 함' 항목은 빈 값과 같게 취급한다.
    category: e('CATEGORY').replace(/^지정\s*안\s*함.*$/, ''),
    categoryFallback: e('CATEGORY_FALLBACK', DEFAULT_CATEGORY_FALLBACK),
    strictCategory: b('STRICT_CATEGORY', false),
    postStatus,
    postStatusExplicit: !statusAuto,
    generateImage: b('GENERATE_IMAGE', true),
    imageModel: e('IMAGE_MODEL', DEFAULT_IMAGE_MODEL),
    dryRun: b('DRY_RUN', false),
    articleJson: e('ARTICLE_JSON'),
    outputDir: e('OUTPUT_DIR', path.join('out', 'wp-publish')),
    siteName: e('SITE_NAME', 'Many_Info'),
    siteUrl: e('SITE_URL', wpUrl),
    maxTokens: Number.parseInt(e('LLM_MAX_TOKENS', '6000'), 10) || 6000,
    llmTimeoutMs: Number.parseInt(e('LLM_TIMEOUT_MS', '180000'), 10) || 180000,
    wpTimeoutMs: Number.parseInt(e('WP_TIMEOUT_MS', '120000'), 10) || 120000,
  };
  cfg.outputDir = path.isAbsolute(cfg.outputDir) ? cfg.outputDir : path.join(ROOT, cfg.outputDir);
  return cfg;
}

/**
 * 업로드 상태를 정한다.
 *   1) POST_STATUS (워크플로우 입력·환경변수) 가 있으면 그 값을 그대로 따른다 — 사람이 고른 값.
 *   2) 없으면 ARTICLE_JSON 의 status.
 *   3) 둘 다 없거나 읽을 수 없으면 draft (임시저장).
 * `auto` 는 "환경변수로 정하지 않음"과 같은 뜻이다.
 */
export function resolvePostStatus(cfg, parsed = {}) {
  if (cfg?.postStatusExplicit) return { status: cfg.postStatus, source: 'POST_STATUS' };

  const raw = String(parsed?.status ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return { status: 'draft', source: '기본값(draft)' };
  if (ALLOWED_POST_STATUSES.includes(raw)) return { status: raw, source: 'JSON status' };
  return {
    status: 'draft',
    source: '기본값(draft)',
    warning: `JSON 의 status="${raw}" 는 쓸 수 없어 draft 로 올립니다. 허용: ${ALLOWED_POST_STATUSES.join(', ')}`,
  };
}

function resolveProvider(cfg) {
  if (cfg.llmProvider === 'anthropic') {
    if (!cfg.anthropicKey) throw new Error('LLM_PROVIDER=anthropic 인데 ANTHROPIC_API_KEY 가 없습니다.');
    return 'anthropic';
  }
  if (cfg.llmProvider === 'openai') {
    if (!cfg.openaiKey) throw new Error('LLM_PROVIDER=openai 인데 OPENAI_API_KEY 가 없습니다.');
    return 'openai';
  }
  if (cfg.anthropicKey) return 'anthropic';
  if (cfg.openaiKey) return 'openai';
  throw new Error(
    'LLM 키가 없습니다. ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 중 하나를 넣어 주세요. ' +
      '(ARTICLE_JSON 을 주면 LLM 호출 없이 검증할 수 있습니다.)',
  );
}

// ── HTTP 유틸 ───────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(message, status, body, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function readBodySafe(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function friendlyHttpMessage(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return '응답 시간이 초과됐습니다.';
  if (err?.cause?.code === 'ENOTFOUND') return '도메인을 찾지 못했습니다(주소 오타 또는 DNS).';
  if (err?.cause?.code === 'ECONNREFUSED') return '연결이 거부됐습니다.';
  return err?.message || String(err);
}

// ── HTML 정리 ──────────────────────────────────────────────────────────────

const DROP_CONTENT_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
  'form',
  'textarea',
  'select',
  'button',
  'video',
  'audio',
  'canvas',
  'template',
  'link',
  'meta',
];

const ALLOWED_TAGS = new Set([
  'p',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'hr',
  'br',
  'div',
  'span',
  'code',
  'pre',
  'del',
  'sup',
  'sub',
]);

const TAG_RENAME = { h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', b: 'strong', i: 'em' };

const ALLOWED_ATTRS = {
  a: ['href', 'title'],
  div: ['class'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  ol: ['start'],
};

const SAFE_DIV_CLASSES = new Set(['summary-box', 'tip-box']);

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isSafeUrl(raw) {
  const value = String(raw).trim().replace(/[\u0000-\u001f\s]+/g, '').toLowerCase();
  if (!value) return false;
  if (value.startsWith('javascript:') || value.startsWith('data:') || value.startsWith('vbscript:')) return false;
  return /^(https?:\/\/|mailto:|\/|#)/.test(value);
}

function parseAttributes(raw) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs.push([name, value]);
  }
  return attrs;
}

/**
 * LLM 이 돌려준 HTML 을 워드프레스 본문으로 쓸 수 있는 최소 형태로 만든다.
 * 화이트리스트 밖 태그는 태그만 버리고 내용은 남긴다(문단이 통째로 사라지지 않게).
 */
export function sanitizeHtml(input) {
  let html = String(input ?? '');

  // 주석 제거
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 위험한 요소는 내용째 제거
  for (const tag of DROP_CONTENT_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    html = html.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  // 닫히지 않은 script/style 잔해
  html = html.replace(/<(script|style)\b[\s\S]*$/gi, '');

  // 이미지 태그는 통째로 버린다 — 대문 이미지는 미디어로만 붙인다(저작권·출처 문제).
  html = html.replace(/<img\b[^>]*>/gi, '');

  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, closing, rawName, rawAttrs) => {
    let name = rawName.toLowerCase();
    name = TAG_RENAME[name] || name;
    if (!ALLOWED_TAGS.has(name)) return '';

    if (closing) return `</${name}>`;
    if (name === 'br' || name === 'hr') return `<${name}>`;

    const allowed = ALLOWED_ATTRS[name] || [];
    const out = [];
    for (const [attr, value] of parseAttributes(rawAttrs)) {
      if (!allowed.includes(attr)) continue;
      if (attr === 'href' && !isSafeUrl(value)) continue;
      if (attr === 'class' && name === 'div') {
        const classes = String(value).split(/\s+/).filter((c) => SAFE_DIV_CLASSES.has(c));
        if (classes.length === 0) continue;
        out.push(`class="${escapeAttr(classes.join(' '))}"`);
        continue;
      }
      if (attr === 'colspan' || attr === 'rowspan' || attr === 'start') {
        if (!/^\d{1,3}$/.test(String(value).trim())) continue;
      }
      out.push(`${attr}="${escapeAttr(value)}"`);
    }

    if (name === 'a' && out.some((a) => a.startsWith('href="http'))) {
      out.push('rel="noopener noreferrer"');
    }
    return `<${name}${out.length ? ' ' + out.join(' ') : ''}>`;
  });

  // 빈 문단·중복 줄바꿈 정리
  html = html.replace(/<p>\s*<\/p>/gi, '');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

function escapeHtmlText(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  return escapeHtmlText(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

/** LLM 이 마크다운을 뱉었을 때를 위한 얇은 변환기. 표·목록·인용·소제목만 다룬다. */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMarkdown(paragraph.join(' ').trim())}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    // 표: | a | b |  /  |---|---|
    if (/^\|.*\|$/.test(trimmed) && /^\|[\s:|-]+\|$/.test((lines[i + 1] || '').trim())) {
      flushParagraph();
      closeList();
      const header = trimmed.split('|').slice(1, -1).map((c) => c.trim());
      const rows = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().split('|').slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      i -= 1;
      const thead = `<thead><tr>${header.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    const heading = trimmed.match(/^(#{2,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length <= 3 ? 2 : 3;
      out.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote><p>${quote.map(inlineMarkdown).join('<br>')}</p></blockquote>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (listType !== type) {
        closeList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${inlineMarkdown((ordered || unordered)[1].trim())}</li>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return out.join('\n');
}

/** 본문에 HTML 태그가 거의 없으면 마크다운/플레인텍스트로 보고 변환한다. */
export function coerceToHtml(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const tagCount = (raw.match(/<[a-zA-Z][^>]*>/g) || []).length;
  if (tagCount >= 3) return raw;
  if (/(^|\n)\s*(#{2,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|)/.test(raw) || /\*\*[^*]+\*\*/.test(raw)) {
    return markdownToHtml(raw);
  }
  if (tagCount === 0) {
    const blocks = raw.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((b) => `<p>${escapeHtmlText(b).replace(/\n/g, '<br>')}</p>`).join('\n');
  }
  return raw;
}

/** 요약 박스와 표에 최소한의 인라인 스타일을 준다(테마와 무관하게 읽히도록). */
export function decorateHtml(input) {
  let html = String(input ?? '');

  html = html.replace(
    /<div class="summary-box">/g,
    '<div class="summary-box" style="background:#f7f7f9;border:1px solid #e5e7eb;border-radius:14px;padding:18px 22px;margin:26px 0;">',
  );

  html = html.replace(
    /<table(?:\s[^>]*)?>/g,
    (tag) =>
      '<div style="overflow-x:auto;margin:26px 0;">' +
      tag.replace(/^<table/i, '<table style="width:100%;border-collapse:collapse;font-size:15px;"'),
  );
  html = html.replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<th(\s[^>]*)?>/g, (tag, rest = '') =>
    `<th style="border:1px solid #e5e7eb;background:#f6f7f9;padding:10px 12px;text-align:left;font-weight:600;"${rest}>`,
  );
  html = html.replace(/<td(\s[^>]*)?>/g, (tag, rest = '') =>
    `<td style="border:1px solid #e5e7eb;padding:10px 12px;vertical-align:top;"${rest}>`,
  );
  return html;
}

export function stripTags(input) {
  return String(input ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|h2|h3|tr|blockquote|div)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deriveExcerpt(html, max = 150) {
  const text = stripTags(html);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다. '), cut.lastIndexOf('요. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1).trim();
  return `${cut.trim()}…`;
}

// ── LLM 응답 파싱 ──────────────────────────────────────────────────────────

/** ```json 펜스나 앞뒤 설명이 섞여도 첫 번째 JSON 객체를 꺼낸다. */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 워드프레스 슬러그로 쓸 수 있게 다듬는다. 한글은 그대로 둔다(WP가 URL 인코딩한다). */
export function normalizeSlug(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

/** JSON 의 summary_points 로 3줄 요약 박스를 만든다(본문에 이미 있으면 쓰지 않는다). */
function buildSummaryBox(points) {
  const heading = points.length === 3 ? '3줄 요약' : '핵심 요약';
  const items = points.map((p) => `<li>${escapeHtmlText(p)}</li>`).join('');
  return `<div class="summary-box"><p><strong>${heading}</strong></p><ul>${items}</ul></div>`;
}

export function normalizeArticle(parsed, { topic, category }) {
  const issues = [];
  let title = String(parsed?.title ?? '').trim();
  if (!title) {
    title = topic ? `${topic} 정리` : '제목 없음';
    issues.push('제목이 비어 있어 주제로 대체했습니다.');
  }
  if (title.length > 90) {
    title = title.slice(0, 90).trim();
    issues.push('제목이 90자를 넘어 잘랐습니다.');
  }

  const rawHtml = String(parsed?.html ?? parsed?.content_html ?? parsed?.content ?? '').trim();
  if (!rawHtml) throw new Error('글 본문이 없습니다. JSON 의 content_html(또는 html)을 채워 주세요.');

  const summaryPoints = Array.isArray(parsed?.summary_points)
    ? parsed.summary_points.map((p) => String(p).trim()).filter(Boolean).slice(0, 5)
    : [];

  let sourceHtml = coerceToHtml(rawHtml);
  if (summaryPoints.length && !/class\s*=\s*["'][^"']*summary-box/i.test(sourceHtml)) {
    sourceHtml = `${buildSummaryBox(summaryPoints)}\n${sourceHtml}`;
  }

  let html = decorateHtml(sanitizeHtml(sourceHtml));
  if (!html) throw new Error('HTML 정리 후 본문이 비었습니다.');

  const textLength = stripTags(html).length;
  if (textLength < 400) issues.push(`본문이 짧습니다(${textLength}자). 초안 검수 때 보강을 권합니다.`);

  let excerpt = String(parsed?.excerpt ?? '').trim();
  if (!excerpt) excerpt = deriveExcerpt(html);
  if (excerpt.length > 300) excerpt = excerpt.slice(0, 300).trim();

  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  const imagePrompt = String(parsed?.image_prompt ?? '').trim();
  const imageAlt = String(parsed?.image_alt ?? '').trim() || `${title} 대표 이미지`;
  const slug = normalizeSlug(parsed?.slug);
  const needsFactCheck = parsed?.needs_fact_check === true;
  const factCheckNotes = Array.isArray(parsed?.fact_check_notes)
    ? parsed.fact_check_notes.map((n) => String(n).trim()).filter(Boolean)
    : [];

  if (needsFactCheck) issues.push('최신 수치·날짜·가격 확인이 필요한 주제라고 모델이 표시했습니다.');

  return {
    title,
    slug,
    excerpt,
    html,
    textLength,
    tags,
    category: category || '',
    imagePrompt,
    imageAlt,
    needsFactCheck,
    factCheckNotes,
    issues,
  };
}

// ── 글 생성 프롬프트 ────────────────────────────────────────────────────────

export function buildPrompt({ topic, category, siteName, today }) {
  const system = `당신은 한국어 정보 블로그 '${siteName}'(manyinfo.net)의 글을 쓰는 작가입니다.
독자는 20~40대 한국인이고, 검색으로 들어와 3분 안에 답을 얻어가길 원합니다.

[톤]
- 가벼운 존댓말 베이스. 딱딱한 안내문이 아니라 사람이 말하듯 씁니다.
- 솔직한 워딩을 조금 섞습니다("생각보다 간단해요", "이건 좀 아쉬웠어요"). 과한 비속어·밈은 쓰지 않습니다.
- 문단은 2~4문장으로 짧게 끊습니다. 한 문단에 한 가지 말만 합니다.
- 이모티콘은 소제목이나 문단 끝에 1개 정도, 글 전체에서 3~5개만 씁니다. 남발하지 않습니다.

[구조]
1. 도입: 독자가 겪는 상황에 공감하는 2~3문장.
2. <div class="summary-box"> 안에 "3줄 요약" 제목과 ul 목록 3개.
3. h2 소제목 3~5개로 본문 전개. 각 소제목 아래 p 2~4개.
4. 비교 표(table) 또는 체크리스트(ul)를 최소 1개 넣습니다. 표는 3~5행으로 작게.
5. 마무리: 핵심을 한 번 더 짚고, 실제 적용 전에 확인할 점을 안내합니다.

[HTML 규칙]
- 본문은 HTML 조각만 씁니다. <html>, <body>, <h1> 은 쓰지 않습니다.
- 허용 태그: h2, h3, p, ul, ol, li, strong, em, blockquote, table, thead, tbody, tr, th, td, a, hr, br, div(class="summary-box" 또는 "tip-box"), code.
- style 속성·script·iframe·이미지 태그를 쓰지 않습니다. (대문 이미지는 따로 붙습니다.)
- 표는 첫 줄을 th 로 만듭니다.

[사실 규칙 — 가장 중요]
- 당신에게는 검색 도구가 없습니다. 확인되지 않은 가격, 날짜, 통계, 정책 변경, 매장 정보를 지어내지 않습니다.
- 최신 정보가 필요한 주제라면 단정하지 말고 "방문·신청 전에 공식 페이지에서 확인하세요"처럼 씁니다.
- 일반 원칙과 절차, 체크리스트처럼 시간이 지나도 맞는 내용을 중심으로 씁니다.
- 모르는 것을 아는 척하지 않습니다. 확인이 필요한 항목은 fact_check_notes 에 적습니다.

[개인정보]
- 작성자(블로거)의 이름, 나이, 주소, 직장·학교, 계정, 가족·연인 정보, 구매 이력을 쓰지 않습니다.
- 1인칭 경험담이 필요하면 "직접 써보니" 정도의 일반적인 표현만 씁니다. 없는 경험을 만들지 않습니다.

[SEO]
- title: 핵심 키워드를 앞쪽에, 60자 이내, 낚시성 표현 금지.
- excerpt: 100~150자, 검색 결과에서 눌러보고 싶게.
- tags: 3~6개, 모두 한국어 소문자 명사.

[대문 이미지 프롬프트]
- image_prompt 는 영어로 씁니다. 글 내용을 상징하는 밝은 플랫 일러스트, 파스텔 톤, 16:9.
- 이미지 안에 글자·로고·실제 인물 얼굴을 넣지 않습니다("no text, no letters, no logos, no faces").
- image_alt 는 한국어 한 문장.

[출력]
설명 없이 아래 스키마의 JSON 객체 하나만 출력합니다.
{
  "title": "제목",
  "excerpt": "요약",
  "html": "<p>...</p>",
  "tags": ["태그1", "태그2", "태그3"],
  "image_prompt": "English prompt ...",
  "image_alt": "한국어 대체 텍스트",
  "needs_fact_check": true,
  "fact_check_notes": ["확인 필요: ..."]
}`;

  const user = `오늘 날짜: ${today}
주제: ${topic}
카테고리: ${category || '(지정 없음 — 사이트 기본 카테고리)'}
사이트: ${siteName}

이 주제로 정보 블로그 글을 써 주세요. 본문 분량은 공백 제외 1,200~2,200자로 맞춥니다.`;

  return { system, user };
}

async function callAnthropic(cfg, prompt) {
  const models = [...new Set([cfg.anthropicModel, ...ANTHROPIC_FALLBACK_MODELS])];
  let lastError;
  for (const model of models) {
    const res = await fetchWithTimeout(
      `${cfg.anthropicBaseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: cfg.maxTokens,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        }),
      },
      cfg.llmTimeoutMs,
    );
    const text = await readBodySafe(res);
    if (res.ok) {
      const data = parseJsonSafe(text);
      const out = (data?.content || [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (!out) throw new Error('Anthropic 응답에 텍스트가 없습니다.');
      return { text: out, model, usage: data?.usage };
    }
    const data = parseJsonSafe(text);
    const message = data?.error?.message || text.slice(0, 400);
    const modelMissing = res.status === 404 || /model/i.test(message) && /not|invalid|unknown/i.test(message);
    lastError = new HttpError(`Anthropic ${res.status}: ${message}`, res.status, text, 'anthropic');
    if (!modelMissing) break;
    warn(`Anthropic 모델 "${model}" 을 쓸 수 없어 다음 후보로 넘어갑니다.`);
  }
  throw lastError;
}

async function callOpenAI(cfg, prompt) {
  const models = [...new Set([cfg.openaiModel, ...OPENAI_FALLBACK_MODELS])];
  let lastError;
  for (const model of models) {
    const modern = /^(gpt-4o|gpt-4\.1|gpt-5|o[1-9])/.test(model);
    const body = {
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    };
    if (modern) body.response_format = { type: 'json_object' };
    // 추론 계열은 temperature 를 거부하므로 아예 보내지 않는다.
    const res = await fetchWithTimeout(
      `${cfg.openaiBaseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.openaiKey}`,
        },
        body: JSON.stringify(body),
      },
      cfg.llmTimeoutMs,
    );
    const text = await readBodySafe(res);
    if (res.ok) {
      const data = parseJsonSafe(text);
      const out = data?.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error('OpenAI 응답에 content 가 없습니다.');
      return { text: out, model, usage: data?.usage };
    }
    const data = parseJsonSafe(text);
    const message = data?.error?.message || text.slice(0, 400);
    lastError = new HttpError(`OpenAI ${res.status}: ${message}`, res.status, text, 'openai');
    const modelMissing = res.status === 404 || /model/i.test(message) && /not|invalid|does not exist|unknown/i.test(message);
    if (!modelMissing) break;
    warn(`OpenAI 모델 "${model}" 을 쓸 수 없어 다음 후보로 넘어갑니다.`);
  }
  throw lastError;
}

async function generateArticle(cfg) {
  if (cfg.articleJson) {
    const file = path.isAbsolute(cfg.articleJson) ? cfg.articleJson : path.join(ROOT, cfg.articleJson);
    if (!fs.existsSync(file)) throw new Error(`ARTICLE_JSON 파일이 없습니다: ${file}`);
    const rel = path.relative(ROOT, file);
    log(`LLM 호출 없이 ARTICLE_JSON 을 사용합니다: ${rel}`);
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`ARTICLE_JSON(${rel}) 을 JSON 으로 읽지 못했습니다: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`ARTICLE_JSON(${rel}) 의 최상위는 객체({ })여야 합니다.`);
    }
    const unknown = Object.keys(parsed).filter((k) => !KNOWN_ARTICLE_KEYS.has(k));
    if (unknown.length) warn(`ARTICLE_JSON(${rel}) 에서 모르는 필드는 무시합니다: ${unknown.join(', ')}`);
    return { parsed, meta: { source: 'article-json', file: rel } };
  }

  if (!cfg.topic) throw new Error('TOPIC 이 필요합니다. (워크플로우 입력 topic)');
  const provider = resolveProvider(cfg);
  const prompt = buildPrompt({
    topic: cfg.topic,
    category: cfg.category,
    siteName: cfg.siteName,
    today: new Date().toISOString().slice(0, 10),
  });

  log(`글 생성: ${provider} · 주제 "${cfg.topic}"`);
  const started = Date.now();
  const result = provider === 'anthropic' ? await callAnthropic(cfg, prompt) : await callOpenAI(cfg, prompt);
  log(`글 생성 완료: ${result.model} · ${((Date.now() - started) / 1000).toFixed(1)}초`);

  const parsed = extractJson(result.text);
  if (!parsed) {
    throw new Error('LLM 응답에서 JSON 을 찾지 못했습니다. (응답 앞부분: ' + result.text.slice(0, 300) + ')');
  }
  return { parsed, meta: { source: provider, model: result.model, usage: result.usage || null } };
}

// ── 워드프레스 REST ─────────────────────────────────────────────────────────

function wpBase(cfg) {
  return `${cfg.wpUrl}/wp-json/wp/v2`;
}

function wpHeaders(cfg, extra = {}) {
  const headers = {
    'user-agent': 'agent-company-wp-publish/1.0',
    ...extra,
  };
  // 자격증명이 없으면 Authorization 을 아예 보내지 않는다(공개 GET 만 하는 DRY_RUN).
  if (cfg.wpUser && cfg.wpAppPassword) {
    headers.authorization = 'Basic ' + Buffer.from(`${cfg.wpUser}:${cfg.wpAppPassword}`).toString('base64');
  }
  return headers;
}

async function wpRequest(cfg, method, endpoint, { query, json, raw, contentType, filename, retries = 2 } = {}) {
  const url = new URL(`${wpBase(cfg)}${endpoint}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers = wpHeaders(cfg);
  let body;
  if (raw !== undefined) {
    body = raw;
    headers['content-type'] = contentType || 'application/octet-stream';
    if (filename) headers['content-disposition'] = `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"`;
  } else if (json !== undefined) {
    body = JSON.stringify(json);
    headers['content-type'] = 'application/json';
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await fetchWithTimeout(url, { method, headers, body }, cfg.wpTimeoutMs);
    } catch (err) {
      if (attempt <= retries && method === 'GET') {
        await sleep(800 * attempt);
        continue;
      }
      throw new Error(`워드프레스 ${method} ${url.pathname} 실패: ${friendlyHttpMessage(err)}`);
    }

    const text = await readBodySafe(res);
    const data = parseJsonSafe(text);

    if (res.ok) return { data: data ?? text, headers: res.headers, status: res.status };

    const message = data?.message ? String(data.message) : text.replace(/<[^>]+>/g, ' ').slice(0, 300);
    const retryable = method === 'GET' ? [429, 500, 502, 503, 504].includes(res.status) : res.status === 429;
    if (retryable && attempt <= retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(500 * attempt, retryAfter * 1000));
      continue;
    }
    throw new HttpError(`워드프레스 ${method} ${url.pathname} → HTTP ${res.status}: ${message}`, res.status, text, url.toString());
  }
}

/** 비교용 접기: 공백·가운뎃점·하이픈 같은 구분자를 모두 없애고 글자/숫자만 남긴다. */
export function normalizeCategoryName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 이름·슬러그·ID 어느 쪽으로 들어와도 카테고리를 찾는다. */
export function matchCategory(categories, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const byId = categories.find((c) => Number(c.id) === Number(raw));
    if (byId) return { category: byId, reason: 'id' };
  }

  // "게임·리뷰 > 니케" 처럼 상위를 함께 적은 경우 마지막 조각을 우선한다.
  const parts = raw
    .split(/>|›|\//)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1] || raw;

  const candidates = [last, raw];
  for (const target of candidates) {
    const norm = normalizeCategoryName(target);
    if (!norm) continue;

    const exact = categories.find((c) => normalizeCategoryName(c.name) === norm);
    if (exact) return { category: exact, reason: 'name' };

    const slug = categories.find(
      (c) => normalizeCategoryName(c.slug) === norm || c.slug.toLowerCase() === String(target).trim().toLowerCase(),
    );
    if (slug) return { category: slug, reason: 'slug' };

    // 'AI·개발' 처럼 일부만 적은 경우 — 짧은 쪽이 긴 쪽에 포함되면 매칭.
    const partial = categories
      .filter((c) => {
        const n = normalizeCategoryName(c.name);
        return n.includes(norm) || norm.includes(n);
      })
      .sort((a, b) => Math.abs(normalizeCategoryName(a.name).length - norm.length) - Math.abs(normalizeCategoryName(b.name).length - norm.length));
    if (partial.length) return { category: partial[0], reason: 'partial' };
  }
  return null;
}

async function fetchCategories(cfg) {
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const { data, headers } = await wpRequest(cfg, 'GET', '/categories', {
      query: { per_page: 100, page, orderby: 'name', order: 'asc' },
      retries: 1,
    });
    if (!Array.isArray(data)) break;
    all.push(...data);
    const totalPages = Number(headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages || data.length === 0) break;
  }
  return all;
}

async function resolveCategory(cfg, categories, requestedQuery = cfg.category) {
  const requested = String(requestedQuery ?? '').trim();
  if (!requested) {
    log('카테고리 지정이 없어 워드프레스 카테고리를 기본값으로 둡니다.');
    return { requested: '', category: null, fallback: false };
  }
  const match = matchCategory(categories, requested);
  if (match) {
    log(`카테고리 매칭: "${requested}" → ${match.category.name} (ID ${match.category.id}, ${match.reason})`);
    return { requested, category: match.category, fallback: false, reason: match.reason };
  }

  const fallback = matchCategory(categories, cfg.categoryFallback);
  const list = categories.map((c) => `${c.name}(${c.id})`).join(', ');
  if (cfg.strictCategory) {
    throw new Error(`카테고리 "${requested}" 를 찾지 못했습니다. 사용 가능: ${list}`);
  }
  if (!fallback) {
    throw new Error(`카테고리 "${requested}" 와 대체 카테고리 "${cfg.categoryFallback}" 둘 다 없습니다. 사용 가능: ${list}`);
  }
  warn(`카테고리 "${requested}" 를 찾지 못해 "${fallback.category.name}"(ID ${fallback.category.id})로 올립니다. 사용 가능: ${list}`);
  return { requested, category: fallback.category, fallback: true };
}

async function ensureTags(cfg, names) {
  const ids = [];
  for (const name of names) {
    try {
      const { data } = await wpRequest(cfg, 'GET', '/tags', { query: { search: name, per_page: 100 }, retries: 1 });
      const exact = Array.isArray(data) ? data.find((t) => normalizeCategoryName(t.name) === normalizeCategoryName(name)) : null;
      if (exact) {
        ids.push(exact.id);
        continue;
      }
      try {
        const created = await wpRequest(cfg, 'POST', '/tags', { json: { name }, retries: 0 });
        ids.push(created.data.id);
      } catch (err) {
        const body = parseJsonSafe(err?.body || '');
        if (body?.code === 'term_exists' && body?.data?.term_id) ids.push(body.data.term_id);
        else warn(`태그 "${name}" 를 만들지 못해 건너뜁니다: ${err.message}`);
      }
    } catch (err) {
      warn(`태그 "${name}" 조회 실패: ${err.message}`);
    }
  }
  return [...new Set(ids)];
}

// ── 인증 확인 ─────────────────────────────────────────────────────────────

async function verifyWpAuth(cfg) {
  try {
    const me = await wpRequest(cfg, 'GET', '/users/me', { query: { context: 'edit' }, retries: 0 });
    log(`워드프레스 인증 확인: ${me.data?.name || me.data?.slug || 'ok'}`);
    return me.data;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new Error(
        `워드프레스 인증 실패(${err.status}). WP_USER(아이디)와 WP_APP_PASSWORD(응용 프로그램 비밀번호)를 확인하세요. ` +
          '관리자 프로필 → 응용 프로그램 비밀번호에서 새로 발급할 수 있습니다.',
      );
    }
    throw err;
  }
}

// ── 이미지 ─────────────────────────────────────────────────────────────────

async function requestOpenAIImage(cfg, prompt) {
  const model = cfg.imageModel;
  const isGptImage = model.startsWith('gpt-image');
  const body = {
    model,
    prompt,
    n: 1,
    size: isGptImage ? '1536x1024' : '1792x1024',
  };
  if (isGptImage) {
    body.quality = envStr('IMAGE_QUALITY', 'medium');
    body.output_format = 'webp';
  } else {
    body.quality = 'standard';
    body.response_format = 'b64_json';
  }

  const res = await fetchWithTimeout(
    `${cfg.openaiBaseUrl}/v1/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openaiKey}` },
      body: JSON.stringify(body),
    },
    240000,
  );
  const text = await readBodySafe(res);
  if (!res.ok) {
    const data = parseJsonSafe(text);
    throw new Error(`OpenAI 이미지 ${res.status}: ${data?.error?.message || text.slice(0, 300)}`);
  }
  const data = parseJsonSafe(text);
  const first = data?.data?.[0];
  if (!first) throw new Error('OpenAI 이미지 응답이 비었습니다.');

  let buffer;
  let contentType = isGptImage ? 'image/webp' : 'image/png';
  let ext = isGptImage ? 'webp' : 'png';
  if (first.b64_json) {
    buffer = Buffer.from(first.b64_json, 'base64');
  } else if (first.url) {
    const imageRes = await fetchWithTimeout(first.url, { method: 'GET' }, 120000);
    if (!imageRes.ok) throw new Error(`생성된 이미지 다운로드 실패: HTTP ${imageRes.status}`);
    buffer = Buffer.from(await imageRes.arrayBuffer());
    const type = imageRes.headers.get('content-type');
    if (type?.startsWith('image/')) {
      contentType = type.split(';')[0];
      ext = contentType.split('/')[1] || ext;
    }
  } else {
    throw new Error('OpenAI 이미지 응답에 b64_json/url 이 없습니다.');
  }

  return { buffer, contentType, ext, model, revisedPrompt: first.revised_prompt || null };
}

async function uploadImage(cfg, image, article) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `wp-cover-${stamp}-${Date.now()}.${image.ext}`;
  const { data } = await wpRequest(cfg, 'POST', '/media', {
    raw: image.buffer,
    contentType: image.contentType,
    filename,
    retries: 0,
  });
  const id = data?.id;
  if (!id) throw new Error('미디어 업로드 응답에 id 가 없습니다.');

  try {
    await wpRequest(cfg, 'POST', `/media/${id}`, {
      json: {
        title: article.title,
        alt_text: article.imageAlt,
        caption: '',
      },
      retries: 0,
    });
  } catch (err) {
    warn(`대표 이미지 메타데이터(alt) 저장 실패: ${err.message}`);
  }
  return { id, sourceUrl: data?.source_url || '', filename };
}

// ── 출력 ───────────────────────────────────────────────────────────────────

function createRunDir(cfg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(cfg.outputDir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.outputDir, 'latest.txt'), dir, 'utf8');
  return dir;
}

function writeOutputs(dir, payload) {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(payload, null, 2), 'utf8');
  if (payload.article?.html) fs.writeFileSync(path.join(dir, 'article.html'), payload.article.html, 'utf8');
  if (payload.summaryMarkdown) fs.writeFileSync(path.join(dir, 'summary.md'), payload.summaryMarkdown, 'utf8');
}

function buildSummary(payload) {
  const { dryRun, article, category, post, image, warnings, run, postStatus } = payload;
  const lines = [];
  lines.push(dryRun ? '## 워드프레스 자동 발행 — DRY RUN (업로드 안 함)' : '## 워드프레스 자동 발행 결과');
  lines.push('');
  lines.push(`- **제목**: ${article.title}`);
  if (article.slug) lines.push(`- **슬러그**: ${article.slug}`);
  lines.push(`- **상태**: ${dryRun ? 'dry-run' : `${post?.status || '알 수 없음'}${postStatus?.source ? ` (${postStatus.source})` : ''}`}`);
  if (post?.id) {
    const edit = `${run.siteUrl}/wp-admin/post.php?post=${post.id}&action=edit`;
    lines.push(`- **글 ID**: ${post.id} · [워드프레스에서 열기](${edit})`);
    if (post.link) lines.push(`- **링크**: ${post.link}`);
  }
  if (category?.category) {
    const suffix = category.fallback ? ` (요청: ${category.requested} — 못 찾아 대체)` : '';
    lines.push(`- **카테고리**: ${category.category.name} (ID ${category.category.id})${suffix}`);
  } else {
    lines.push('- **카테고리**: 사이트 기본값');
  }
  lines.push(`- **태그**: ${article.tags?.length ? article.tags.join(', ') : '(없음)'}`);
  lines.push(`- **본문 분량**: ${article.textLength}자`);
  lines.push(`- **대표 이미지**: ${image?.uploaded ? `있음 (미디어 ID ${image.uploaded.id})` : image?.reason ? `없음 — ${image.reason}` : '없음'}`);
  lines.push(`- **사실 확인 플래그**: ${article.needsFactCheck ? '필요' : '없음'}`);
  if (article.factCheckNotes?.length) {
    lines.push('');
    lines.push('### 확인이 필요한 항목');
    for (const note of article.factCheckNotes) lines.push(`- ${note}`);
  }
  if (article.issues?.length) {
    lines.push('');
    lines.push('### 점검 메모');
    for (const issue of article.issues) lines.push(`- ${issue}`);
  }
  if (warnings?.length) {
    lines.push('');
    lines.push('### 경고');
    for (const w of warnings) lines.push(`- ${w}`);
  }
  if (!dryRun && post?.status === 'publish') {
    lines.push('');
    lines.push('> 공개(publish) 상태로 올라갔습니다. 사이트에서 바로 보입니다.');
  } else if (!dryRun) {
    lines.push('');
    lines.push('> 임시저장(draft)입니다. 워드프레스 관리자에서 확인한 뒤 직접 발행하세요.');
  }
  return lines.join('\n') + '\n';
}

function writeStepSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, markdown, 'utf8');
  } catch (err) {
    warn(`GITHUB_STEP_SUMMARY 기록 실패: ${err.message}`);
  }
}

// ── 메인 ───────────────────────────────────────────────────────────────────

export async function run() {
  const cfg = readConfig();
  const runDir = createRunDir(cfg);
  const warnings = [];
  const siteUrl = cfg.wpUrl;

  log(`사이트: ${cfg.wpUrl}`);
  log(`상태: ${cfg.postStatus} · DRY_RUN=${cfg.dryRun} · 이미지=${cfg.generateImage}`);

  if (!cfg.dryRun && !cfg.articleJson && !cfg.topic) {
    throw new Error('TOPIC 이 필요합니다. (워크플로우 입력 topic)');
  }

  // 자격증명은 LLM 을 부르기 전에 확인한다 — 잘못된 비밀번호로 글 생성 비용을 쓰지 않게.
  if (!cfg.dryRun) {
    if (!cfg.wpUser || !cfg.wpAppPassword) {
      throw new Error('WP_USER 와 WP_APP_PASSWORD 가 필요합니다. (GitHub Secrets)');
    }
    await verifyWpAuth(cfg);
  }

  // 1) 글
  const { parsed, meta } = await generateArticle(cfg);
  // 카테고리는 워크플로우 입력(환경변수)이 우선, 없으면 JSON 의 category.
  const requestedCategory = cfg.category || String(parsed?.category ?? '').trim();
  const article = normalizeArticle(parsed, { topic: cfg.topic, category: requestedCategory });
  log(`본문 ${article.textLength}자 · 태그 ${article.tags.length}개`);

  // 업로드 상태 — 사람이 고른 POST_STATUS > JSON status > draft.
  const statusInfo = resolvePostStatus(cfg, parsed);
  if (statusInfo.warning) warnings.push(statusInfo.warning);
  log(`업로드 상태: ${statusInfo.status} (${statusInfo.source})`);

  // 2) 카테고리 (읽기 — DRY_RUN 에서도 가능. 자격증명이 없으면 건너뛴다)
  let categories = [];
  let category = { requested: requestedCategory, category: null, fallback: false };
  const canReadWp = Boolean(cfg.wpUser && cfg.wpAppPassword) || cfg.dryRun;
  if (canReadWp && cfg.wpUrl) {
    try {
      categories = await fetchCategories(cfg);
      log(`카테고리 ${categories.length}개 조회`);
      category = await resolveCategory(cfg, categories, requestedCategory);
    } catch (err) {
      if (cfg.dryRun && !cfg.strictCategory) {
        warn(`카테고리 조회 실패(무시하고 계속): ${err.message}`);
      } else {
        throw err;
      }
    }
  } else {
    warn('WP_USER / WP_APP_PASSWORD 가 없어 카테고리 매칭을 건너뜁니다.');
  }

  let post = null;
  let image = { uploaded: null, reason: null };

  if (cfg.dryRun) {
    // DRY_RUN 은 워드프레스에 아무것도 쓰지 않는다. 이미지도 만들지 않는다(비용).
    if (cfg.generateImage) {
      image.reason = 'DRY_RUN — 이미지 생성 생략(비용)';
    } else {
      image.reason = 'GENERATE_IMAGE=false';
    }
    log('DRY_RUN: 업로드·이미지 생성 없이 결과만 기록합니다.');
  } else {
    // 3) 대표 이미지
    if (cfg.generateImage && cfg.openaiKey && article.imagePrompt) {
      try {
        log('대표 이미지 생성 중…');
        const generated = await requestOpenAIImage(cfg, article.imagePrompt);
        log(`이미지 생성 완료: ${(generated.buffer.length / 1024).toFixed(0)}KB (${generated.model})`);
        const uploaded = await uploadImage(cfg, generated, article);
        image = { uploaded, reason: null, model: generated.model, bytes: generated.buffer.length };
        log(`미디어 업로드 완료: ID ${uploaded.id}`);
      } catch (err) {
        image.reason = `이미지 생성/업로드 실패: ${err.message}`;
        warn(`${image.reason} — 이미지 없이 글을 올립니다.`);
      }
    } else if (!cfg.generateImage) {
      image.reason = 'GENERATE_IMAGE=false';
    } else if (!cfg.openaiKey) {
      image.reason = 'OPENAI_API_KEY 없음';
      log('OPENAI_API_KEY 가 없어 대표 이미지 없이 진행합니다.');
    } else {
      image.reason = '이미지 프롬프트 없음';
    }

    // 4) 태그
    const tagIds = article.tags.length ? await ensureTags(cfg, article.tags) : [];

    // 5) 글 생성
    const postBody = {
      title: article.title,
      content: article.html,
      excerpt: article.excerpt,
      status: statusInfo.status,
      format: 'standard',
    };
    if (article.slug) postBody.slug = article.slug;
    if (category.category?.id) postBody.categories = [category.category.id];
    if (tagIds.length) postBody.tags = tagIds;
    if (image.uploaded?.id) postBody.featured_media = image.uploaded.id;

    log(`글 업로드: status=${statusInfo.status}`);
    const created = await wpRequest(cfg, 'POST', '/posts', { json: postBody, retries: 0 });
    post = {
      id: created.data?.id,
      link: created.data?.link,
      status: created.data?.status,
      date: created.data?.date,
    };
    if (!post.id) throw new Error('글 생성 응답에 id 가 없습니다.');
    log(`완료: 글 ID ${post.id} · ${post.status}`);
  }

  const payload = {
    dryRun: cfg.dryRun,
    generatedAt: new Date().toISOString(),
    run: { siteUrl, outputDir: path.relative(ROOT, runDir), meta },
    article: {
      title: article.title,
      slug: article.slug,
      excerpt: article.excerpt,
      html: article.html,
      htmlLength: article.html.length,
      textLength: article.textLength,
      tags: article.tags,
      imagePrompt: article.imagePrompt,
      imageAlt: article.imageAlt,
      needsFactCheck: article.needsFactCheck,
      factCheckNotes: article.factCheckNotes,
      issues: article.issues,
    },
    category: {
      requested: category.requested,
      matched: category.category ? { id: category.category.id, name: category.category.name, slug: category.category.slug } : null,
      fallback: Boolean(category.fallback),
    },
    image,
    post,
    postStatus: { status: statusInfo.status, source: statusInfo.source },
    warnings,
  };

  let summary = buildSummary({ ...payload, category });
  payload.summaryMarkdown = summary;
  writeOutputs(runDir, payload);
  writeStepSummary(summary);

  log(`결과 파일: ${path.relative(ROOT, path.join(runDir, 'result.json'))}`);
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((err) => {
    const message = err?.message || String(err);
    console.error(`${LOG_PREFIX} 실패: ${message}`);
    if (err instanceof HttpError && err.status === 401) {
      console.error(`${LOG_PREFIX} 힌트: 응용 프로그램 비밀번호는 공백을 포함해도 그대로 넣으면 됩니다. 관리자 프로필에서 재발급해 보세요.`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeStepSummary(`## 워드프레스 자동 발행 실패\n\n- **이유**: ${message}\n`);
    }
    process.exitCode = 1;
  });
}
