// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import axios from 'axios';
import { load as loadHtml } from 'cheerio';
import pLimit from 'p-limit';

const app = express();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * ✅ CORS
 * - 기본: http://localhost:8000 (프론트)
 * - 확장: localhost/127.0.0.1의 임의 포트도 허용 (개발/모바일 테스트 편의)
 * - 배포 시에는 FRONT_ORIGIN 환경변수로 고정 권장
 */
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || null;
app.use(
  cors({
    origin: FRONT_ORIGIN
      ? FRONT_ORIGIN
      : [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
  })
);

app.use(express.json({ limit: '1mb' }));

// 헬스 체크
app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * ✅ 간단 재랭킹 로직
 * - 입력: { purpose, cafes:[{ name, addr, distance_m, ... }] }
 * - 기준: "거리"를 기본(가까울수록 가점) + "목적 키워드 매칭" 보너스
 * - 실제 데이터가 더 풍부해지면(좌석수/영업시간/태그 등) 가중치 확장하면 됨
  */
app.post('/rerank', async (req, res) => {
  try {
    const { purpose = 'study', cafes } = req.body || {};
    if (!Array.isArray(cafes) || !cafes.length) {
      return res.status(400).json({ error: 'cafes 배열이 필요합니다.' });
    }

    // 목적별 키워드(간단 버전) — name/addr 문자열에서 매칭
    // - date: 디저트가 있고 예쁜
    // - study: 조금은 시끄러워도 되는
    // - assignment: 상대적으로 조용한 분위기
    const purposeKeywords = {
      date: ['데이트', '감성', '뷰', '사진', '인스타', '예쁜', '디저트', '브런치', '케이크'],
      study: ['스터디', '그룹', '모임', '단체석', '토론', '넓은', '대형', '프랜차이즈', '적당'],
      assignment: ['과제', '조용', '집중', '독서', '1인', '개인', '사일런스', '노이즈', '콘센트', '와이파이', '노트북'],
    };
    const keywords = purposeKeywords[purpose] || purposeKeywords.study;

    // 거리 정규화(가까울수록 1에 가깝게)
    const distances = cafes.map((c) =>
      typeof c.distance_m === 'number' ? c.distance_m : null
    );
    const validDistances = distances.filter((d) => d !== null);
    const maxD = validDistances.length ? Math.max(...validDistances) : 0;
    const minD = validDistances.length ? Math.min(...validDistances) : 0;
    const rangeD = Math.max(1, maxD - minD); // 0 division 방지

    const scored = cafes.map((c, idx) => {
      const text =
        `${c.name ?? ''} ${c.addr ?? ''}`.toLowerCase().replace(/\s+/g, '');
      const kwMatches = keywords.reduce(
        (acc, kw) => acc + (text.includes(kw.toLowerCase()) ? 1 : 0),
        0
      );

      // 거리 점수: 가까울수록 높게 (0~1)
      let distanceScore = 0.5; // 거리 정보 없으면 중간값
      if (typeof c.distance_m === 'number') {
        // minD가 가장 가깝고 → 1점, maxD가 가장 멀고 → 0점
        distanceScore = 1 - (c.distance_m - minD) / rangeD;
        distanceScore = Math.max(0, Math.min(1, distanceScore));
      }

      // 가중치: 거리 0.7 + 목적키워드 0.3 (키워드 개수는 0~n → 0~1로 스케일링)
      const keywordScore = Math.min(1, kwMatches / 3); // 키워드 3개 이상이면 만점
      const finalScore = 0.7 * distanceScore + 0.3 * keywordScore;

      return { idx, score: finalScore };
    });

    // 점수 내림차순 정렬 → 인덱스 배열만 반환
    const order = scored.sort((a, b) => b.score - a.score).map((s) => s.idx);

    return res.json({
      order,
      reasoning: `purpose=${purpose}, weights(distance=0.7, keyword=0.3)`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'rerank 실패', detail: String(e?.message || e) });
  }
});

/**
 * ✅ 웹스크래핑 + OpenAI 기반 재랭킹
 * - 입력: { purpose, cafes:[{ name, addr, url, distance_m }] }
 * - 처리:
 *   1) 각 카페의 url을 요청하여 텍스트 추출(간단 크롤링)
 *   2) OpenAI로 목적 적합도(0~1)와 핵심 키워드 생성
 *   3) 거리 점수(0~1)와 합산(예: distance 0.6 + ai 0.4)
 * - 출력: { order, details: [{ idx, distanceScore, aiScore, keywords }] }
 */
app.post('/rerank/ai', async (req, res) => {
  try {
    const { purpose = 'study', peopleCount = 1, cafes } = req.body || {};
    if (!Array.isArray(cafes) || !cafes.length) {
      return res.status(400).json({ error: 'cafes 배열이 필요합니다.' });
    }

    // 거리 정규화 준비
    const distances = cafes.map((c) =>
      typeof c.distance_m === 'number' ? c.distance_m : null
    );
    const validDistances = distances.filter((d) => d !== null);
    const maxD = validDistances.length ? Math.max(...validDistances) : 0;
    const minD = validDistances.length ? Math.min(...validDistances) : 0;
    const rangeD = Math.max(1, maxD - minD);

    // 병렬 요청 제한(과도한 동시 연결 방지)
    const limit = pLimit(4);

    // 목적에 따라 가중치 동적 조정
    let aiWeight = 0.4;
    if (purpose === 'assignment') aiWeight = 0.5;
    else if (purpose === 'date') aiWeight = 0.45;
    const distanceWeight = 1 - aiWeight;

    const tasks = cafes.map((cafe, idx) =>
      limit(async () => {
        const url = cafe.url;
        let pageText = '';
        if (typeof url === 'string' && url.startsWith('http')) {
          try {
            const html = await fetchHtml(url);
            pageText = extractVisibleText(html);
          } catch (e) {
            // 스크래핑 실패는 aiScore 0으로 처리(거리만 반영)
            pageText = '';
          }
        }

        const aiResult = await getAiRelevance({ purpose, peopleCount, cafe, pageText });

        // 거리 점수 계산
        let distanceScore = 0.5;
        if (typeof cafe.distance_m === 'number') {
          distanceScore = 1 - (cafe.distance_m - minD) / rangeD;
          distanceScore = Math.max(0, Math.min(1, distanceScore));
        }

        // 가중치 합산: 거리 vs AI (동적)
        const finalScore = distanceWeight * distanceScore + aiWeight * aiResult.aiScore;

        return {
          idx,
          score: finalScore,
          distanceScore,
          aiScore: aiResult.aiScore,
          keywords: aiResult.keywords,
          reason: aiResult.reason,
        };
      })
    );

    const results = await Promise.all(tasks);
    const order = results
      .sort((a, b) => b.score - a.score)
      .map((r) => r.idx);

    return res.json({
      order,
      details: results,
      reasoning: `purpose=${purpose}, people=${peopleCount}, weights(distance=${distanceWeight.toFixed(2)}, ai=${aiWeight.toFixed(2)})`,
    });
  } catch (e) {
    console.error(e);
    res
      .status(500)
      .json({ error: 'rerank/ai 실패', detail: String(e?.message || e) });
  }
});

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 8000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    // 리다이렉트/쿠키 등 기본 옵션은 axios 기본값 사용
  });
  return typeof data === 'string' ? data : '';
}

function extractVisibleText(html) {
  if (!html) return '';
  const $ = loadHtml(html);
  // 스크립트/스타일 제거 후 텍스트만 추출
  $('script, style, noscript').remove();
  const bodyText = $('body').text();
  const text = (bodyText || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
  // 지나치게 긴 텍스트는 토큰 비용 절감을 위해 제한
  return text.slice(0, 8000);
}

async function getAiRelevance({ purpose, peopleCount, cafe, pageText }) {
  // 목적 설명 매핑
  const purposeDesc = {
    date: '디저트가 있고 사진 찍기 좋은 예쁜 분위기(감성, 뷰, 케이크/브런치)',
    study: '그룹 스터디/모임에 적합한 공간(단체석, 넓은 공간, 토론 가능, 약간의 소음 허용)',
    assignment: '개인 과제/독서에 적합한 조용한 분위기(1인 공간, 집중, 사일런스, 완전 조용)',
  };

  // 프롬프트: 목적과 카페 기본 정보, 페이지 텍스트 일부를 전달해 목적 적합도와 키워드 도출
  const system = 'You are a local guide evaluating cafes for a specific purpose and atmosphere.';
  const user = `
목적: ${purpose} — ${purposeDesc[purpose] || ''}
인원수: ${peopleCount}명
카페명: ${cafe.name ?? ''}
주소: ${cafe.addr ?? ''}
페이지텍스트(일부): ${pageText?.slice(0, 3000) || ''}

지침:
1) 위 목적/인원을 함께 고려해 0.0~1.0 사이 점수를 소수 둘째 자리까지 제시
2) 해당 관점에서 핵심 키워드 3~6개 뽑기
3) 간단한 근거 1줄

응답 JSON 형식만:
{ "score": number, "keywords": string[], "reason": string }
`;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    });
    const content = completion.choices?.[0]?.message?.content?.trim() || '';
    // JSON 파싱 시도
    const parsed = safeParseJson(content);
    const aiScore = normalizeScore(parsed?.score);
    const keywords = Array.isArray(parsed?.keywords) ? parsed.keywords : [];
    const reason = typeof parsed?.reason === 'string' ? parsed.reason : '';
    return { aiScore, keywords, reason };
  } catch (e) {
    // 실패 시 보수적으로 0점 처리
    return { aiScore: 0, keywords: [], reason: 'AI 평가 실패' };
  }
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    // 모델이 코드블록으로 감싸는 경우 제거 후 재시도
    const trimmed = String(s).replace(/^```[\s\S]*?\n|```$/g, '').trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }
}

function normalizeScore(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return Math.min(1, n / 100);
  return n;
}

const port = process.env.PORT || 5050;
app.listen(port, () => console.log(`✅ Backend on http://localhost:${port}`));