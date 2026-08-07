/**
 * 쇼츠 기획 자동화 - Cloudflare Worker
 *
 * 필요한 환경변수/시크릿 (Cloudflare 대시보드 > Settings > Variables and Secrets):
 *   YOUTUBE_API_KEYS   예: "key1,key2"  (콤마로 구분, 쿼터 소진 시 자동 전환)
 *   GEMINI_API_KEY
 *   NOTION_TOKEN       ntn_로 시작하는 값
 *   NOTION_DATABASE_ID 32자리 DB ID
 *
 * 배포 방법:
 *   1. Cloudflare 대시보드 > Workers & Pages > Create > Create Worker
 *   2. 이름 정하고 "Deploy" (기본 템플릿으로 일단 생성)
 *   3. 생성된 Worker 열기 > "Edit code" (Quick Edit)
 *   4. 기존 코드 전체 삭제하고 이 파일 내용 전체 붙여넣기
 *   5. 좌측 "Settings" 탭 > "Variables and Secrets" 에서 위 4개 값 등록 (Secret으로)
 *   6. "Deploy" 클릭
 *   7. 발급되는 https://xxx.workers.dev 주소로 접속하면 웹 폼 뜸
 */

const MANUAL_SYSTEM_PROMPT = `
당신은 '노래 쇼츠 짜집기 채널' 전문 기획자입니다. 아래 매뉴얼 원칙을 반드시 따라 콘텐츠를 기획하세요.

[콘텐츠 유형 우선순위]
1순위: 반전+감동 결합형 (잔잔한 도입 → 후렴 폭발)
2순위: 후킹형 (첫 3초 승부)
3순위: 완결 서사형 원테이크 (팬덤 타겟)
4순위: 정보/비하인드 삽입형
5순위: 단순 하이라이트 나열형 (지양)

[25초 구조]
- 오프닝(0~3초): TTS 사용. 질문형/반전예고형/숫자형/논쟁유발형/공감형 중 선택
- 중반(3~15초): 자막 위주, 전환 멘트만 TTS
- 클라이맥스 직전(15~20초): 자막만 또는 무자막. TTS 절대 금지 (정적/긴장감 유지)
- 클라이맥스(20~25초): 노래만. TTS/효과음 최소화, 원본 관객 반응 있으면 최우선 활용
- 엔딩(25초~): TTS 사용. 댓글/공유 유도 질문형 멘트

[사운드 규칙]
- 클라이맥스 직전: 페이드인(노래 볼륨 서서히 상승) 권장
- 클라이맥스: 원본 박수/환호 있으면 그대로 살리기
- 한 번에 1~2개 효과음만 사용

반드시 아래 JSON 스키마로만 응답하세요. 다른 설명 텍스트는 포함하지 마세요.
{
  "기획_유형": "반전형|후킹형|서사형|정보형|하이라이트형 중 하나",
  "제목안": "3개 제목안을 번호 매겨 한 문자열로",
  "썸네일_가이드": "2개 안, 구도/텍스트/색감 포함",
  "대본_가이드": "구간별([0~3초] 등) 대본 전체",
  "TTS_가이드": "TTS 구간별 실제 텍스트",
  "설명": "SEO 설명문",
  "해시태그": "한국어+영어 해시태그 목록",
  "트렌드_분석_요약": "웹검색으로 확인한 최신 화제성/반응 요약"
}
`;

// ---------- YouTube ----------

function extractVideoId(urlOrId) {
  const patterns = [
    /shorts\/([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = urlOrId.match(p);
    if (m) return m[1];
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  throw new Error(`video_id를 추출할 수 없습니다: ${urlOrId}`);
}

async function youtubeRequestWithRotation(endpoint, params, apiKeysCsv) {
  const keys = apiKeysCsv.split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("YOUTUBE_API_KEYS가 비어있습니다.");

  let lastError = null;
  for (const key of keys) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", key);

    const resp = await fetch(url.toString());
    if (resp.ok) return await resp.json();

    const errJson = await resp.json().catch(() => ({}));
    const reasons = (errJson?.error?.errors || []).map((e) => e.reason);
    if (reasons.includes("quotaExceeded") || reasons.includes("dailyLimitExceeded")) {
      lastError = `키 소진: ${key.slice(0, 10)}...`;
      continue;
    }
    throw new Error(`YouTube API 에러: ${JSON.stringify(errJson)}`);
  }
  throw new Error(`모든 YouTube API 키가 소진되었습니다. ${lastError}`);
}

async function getVideoMetadata(url, apiKeysCsv) {
  const videoId = extractVideoId(url);
  const data = await youtubeRequestWithRotation(
    "videos",
    { part: "snippet,statistics,contentDetails", id: videoId },
    apiKeysCsv
  );
  const item = data.items?.[0];
  if (!item) throw new Error(`영상을 찾을 수 없습니다 (비공개/삭제/제한 가능): ${videoId}`);
  return {
    video_id: videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    channel_title: item.snippet.channelTitle,
    view_count: item.statistics?.viewCount,
    like_count: item.statistics?.likeCount,
  };
}

async function getTopComments(url, apiKeysCsv, maxResults = 30) {
  const videoId = extractVideoId(url);
  try {
    const data = await youtubeRequestWithRotation(
      "commentThreads",
      {
        part: "snippet",
        videoId,
        order: "relevance",
        maxResults: String(maxResults),
        textFormat: "plainText",
      },
      apiKeysCsv
    );
    return (data.items || []).map((item) => {
      const top = item.snippet.topLevelComment.snippet;
      return { text: top.textDisplay, like_count: top.likeCount };
    });
  } catch (e) {
    // 댓글이 비활성화된 영상일 수 있음 - 실패해도 파이프라인은 계속 진행
    return [];
  }
}

// ---------- Gemini ----------

async function geminiExtractSongInfo(metadata, comments, apiKey) {
  const commentSample = (comments || [])
    .slice(0, 15)
    .map((c) => `- ${c.text.slice(0, 100)}`)
    .join("\n");

  const prompt = `
다음은 유튜브 영상의 메타데이터와 인기 댓글입니다. 이 정보를 바탕으로:
1. 이 영상에서 다뤄지는 곡명
2. 부른 가수명
3. 이 영상의 핵심 포인트(반전 지점, 화제가 된 이유, 서사 등 - 댓글 반응에서 유추)
를 추출해주세요.

영상 제목: ${metadata?.title || "(정보 없음)"}
영상 설명: ${(metadata?.description || "").slice(0, 500)}
채널명: ${metadata?.channel_title || "(정보 없음)"}

인기 댓글:
${commentSample || "(댓글 없음)"}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "song_title": "곡명 (확실하지 않으면 영상 제목에서 추정)",
  "artist": "가수명 (확실하지 않으면 채널명이나 영상 정보에서 추정)",
  "key_point": "핵심 포인트를 한두 문장으로"
}
`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini 정보 추출 에러: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini가 빈 응답을 반환했습니다 (정보 추출 단계).");
  return JSON.parse(text);
}

async function geminiSearchTrend(artist, songTitle, apiKey) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `'${artist} ${songTitle}' 관련 최신 반응, 화제성, 관련 이슈를 검색해서 요약해줘.` },
            ],
          },
        ],
        tools: [{ google_search: {} }],
      }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini 검색 에러: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function geminiGenerateContent({ songTitle, artist, keyPoint, metadata, comments, trendSummary }, apiKey) {
  const contextParts = [
    `곡명: ${songTitle}`,
    `가수: ${artist}`,
    `핵심 포인트: ${keyPoint}`,
  ];
  if (metadata) {
    contextParts.push(`원본 영상 제목: ${metadata.title}`);
    contextParts.push(`조회수: ${metadata.view_count}`);
  }
  if (comments && comments.length > 0) {
    const sample = comments.slice(0, 10).map((c) => `- ${c.text.slice(0, 80)}`).join("\n");
    contextParts.push(`인기 댓글 샘플:\n${sample}`);
  }

  const prompt = `${MANUAL_SYSTEM_PROMPT}\n\n[트렌드 조사 결과]\n${trendSummary}\n\n[콘텐츠 정보]\n${contextParts.join("\n")}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini 생성 에러: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini가 빈 응답을 반환했습니다.");
  return JSON.parse(text);
}

// ---------- Notion ----------

function richText(content) {
  return [{ type: "text", text: { content: (content || "").slice(0, 2000) } }];
}

async function uploadToNotion({ songTitle, artist, youtubeUrl, content }, notionToken, databaseId) {
  const payload = {
    parent: { database_id: databaseId },
    properties: {
      "제목": { title: [{ text: { content: `${artist} ${songTitle}` } }] },
      "가수": { rich_text: richText(artist) },
      "유튜브 링크": { url: youtubeUrl },
      "기획 유형": { select: { name: content["기획_유형"] || "반전형" } },
      "썸네일 가이드": { rich_text: richText(content["썸네일_가이드"]) },
      "대본 가이드": { rich_text: richText(content["대본_가이드"]) },
      "TTS 가이드": { rich_text: richText(content["TTS_가이드"]) },
      "제목안": { rich_text: richText(content["제목안"]) },
      "설명": { rich_text: richText(content["설명"]) },
      "해시태그": { rich_text: richText(content["해시태그"]) },
      "상태": { status: { name: "시작 전" } },
    },
  };

  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Notion 업로드 실패: ${errText}\n체크: 1) NOTION_TOKEN 정확한지 2) DB에 통합 연결(Connections)했는지 3) NOTION_DATABASE_ID 정확한지`
    );
  }
  const data = await resp.json();
  return { page_url: data.url };
}

// ---------- 파이프라인 ----------

async function runPipeline({ youtubeUrl }, env) {
  const requiredVars = ["YOUTUBE_API_KEYS", "GEMINI_API_KEY", "NOTION_TOKEN", "NOTION_DATABASE_ID"];
  const missing = requiredVars.filter((v) => !env[v]);
  if (missing.length > 0) {
    throw new Error(
      `환경변수가 설정되지 않았습니다: ${missing.join(", ")}\n` +
      `Cloudflare 대시보드 > Settings > Variables and Secrets 에서 확인해주세요.`
    );
  }

  let metadata = null;
  let comments = [];
  try {
    metadata = await getVideoMetadata(youtubeUrl, env.YOUTUBE_API_KEYS);
    comments = await getTopComments(youtubeUrl, env.YOUTUBE_API_KEYS);
  } catch (e) {
    throw new Error(
      `유튜브 영상 정보를 가져오지 못했습니다: ${e.message}\n` +
      `(비공개/삭제/연령제한 영상이거나 YouTube API 키 문제일 수 있습니다)`
    );
  }

  // 1단계: 영상 정보에서 곡명/가수/핵심포인트 자동 추출
  const extracted = await geminiExtractSongInfo(metadata, comments, env.GEMINI_API_KEY);
  const songTitle = extracted.song_title;
  const artist = extracted.artist;
  const keyPoint = extracted.key_point;

  const trendSummary = await geminiSearchTrend(artist, songTitle, env.GEMINI_API_KEY);

  const content = await geminiGenerateContent(
    { songTitle, artist, keyPoint, metadata, comments, trendSummary },
    env.GEMINI_API_KEY
  );

  const uploadResult = await uploadToNotion(
    { songTitle, artist, youtubeUrl, content },
    env.NOTION_TOKEN,
    env.NOTION_DATABASE_ID
  );

  return { notionUrl: uploadResult.page_url, content, songTitle, artist };
}

// ---------- 웹 폼 HTML ----------

const FORM_HTML = `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>쇼츠 기획 자동화</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; }
  h1 { font-size: 20px; }
  label { display: block; margin-top: 16px; font-weight: bold; }
  input, textarea { width: 100%; padding: 10px; margin-top: 6px; box-sizing: border-box; }
  button { margin-top: 24px; padding: 12px 20px; background: #111; color: #fff; border: none; cursor: pointer; }
  #result { margin-top: 24px; padding: 16px; background: #f5f5f5; display: none; }
  #loading { margin-top: 24px; color: #888; display: none; }
</style>
</head>
<body>
  <h1>노래 쇼츠 기획 자동화</h1>
  <p style="color:#666; font-size:14px;">유튜브 링크만 넣으면 곡명/가수/핵심포인트를 자동으로 분석합니다.</p>
  <form id="genForm">
    <label>유튜브 링크</label>
    <input type="url" id="youtube_url" required placeholder="https://www.youtube.com/shorts/...">

    <button type="submit">기획 생성 + Notion 업로드</button>
  </form>
  <div id="loading">처리 중입니다... (10~30초 소요)</div>
  <div id="result"></div>

<script>
document.getElementById('genForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';

  const body = {
    youtube_url: document.getElementById('youtube_url').value,
  };

  try {
    const resp = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    document.getElementById('loading').style.display = 'none';
    const resultDiv = document.getElementById('result');
    resultDiv.style.display = 'block';
    if (data.error) {
      resultDiv.innerHTML = '<h3>❌ 에러</h3><p style="color:red;">' + data.error + '</p>';
    } else {
      resultDiv.innerHTML = '<h3>✅ 완료</h3>' +
        '<p>인식된 정보: ' + data.artist + ' - ' + data.songTitle + '</p>' +
        '<p><a href="' + data.notionUrl + '" target="_blank">Notion에서 결과 확인하기</a></p>';
    }
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    const resultDiv = document.getElementById('result');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<h3>❌ 에러</h3><p style="color:red;">' + err.message + '</p>';
  }
});
</script>
</body>
</html>
`;

// ---------- Worker 엔트리포인트 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(FORM_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/debug-env" && request.method === "GET") {
      const status = {
        YOUTUBE_API_KEYS: !!env.YOUTUBE_API_KEYS,
        GEMINI_API_KEY: !!env.GEMINI_API_KEY,
        NOTION_TOKEN: !!env.NOTION_TOKEN,
        NOTION_DATABASE_ID: !!env.NOTION_DATABASE_ID,
      };
      // 값의 앞 4글자만 살짝 보여줘서 "다른 값이 들어간 건 아닌지"도 확인 가능하게
      const preview = {};
      for (const key of Object.keys(status)) {
        preview[key] = env[key] ? String(env[key]).slice(0, 4) + "..." : "(없음)";
      }
      return new Response(
        JSON.stringify({ 존재여부: status, 앞부분미리보기: preview }, null, 2),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        const body = await request.json();
        const result = await runPipeline({ youtubeUrl: body.youtube_url }, env);
        return new Response(
          JSON.stringify({
            notionUrl: result.notionUrl,
            songTitle: result.songTitle,
            artist: result.artist,
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
