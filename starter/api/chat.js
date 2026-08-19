// =============================================================
// 문의 챗봇 (Vercel Serverless Function)
//
// chatbot/app.py 와 똑같은 규칙으로 답합니다.
// 두 곳의 답이 어긋나지 않게, 문서도 같은 Supabase 표(faq_docs)를 읽습니다.
//
// 답하는 순서
//   1. 실기를 물으셨나         → "저희는 필기 접수만 도와드립니다"
//   2. 확인 못 한 것을 물으셨나 → "모르겠습니다"
//   3. 비슷한말을 문서 말로 바꾸기
//   4. 문서에서 겹치는 낱말 세기 (제목은 두 배)
//   5. 점수가 낮으면           → "모르겠습니다"  (Gemini 를 부르지 않습니다)
//   6. 찾은 근거만 주고 Gemini 가 문장을 다듬기
//
// 핵심: 근거를 못 찾으면 Gemini 를 아예 부르지 않습니다.
//       그래야 지어낼 수가 없습니다. (발주서 12줄 - "이게 가장 중요합니다")
//
// 키는 환경변수에서만 읽습니다. 코드에 적지 않습니다.
// =============================================================

const TOP_K = 3;
const MIN_SCORE = 2;
const GEMINI_MODEL = "gemini-3.5-flash-lite";

// ---------- 어르신이 쓰시는 말 → 문서에 적힌 말 ----------
// 출처: 01_사업현황_발주서.md 90-93줄
const SYNONYMS = {
  "접수비": ["응시료", "수수료"], "시험비": ["응시료", "수수료"],
  "응시비": ["응시료", "수수료"], "돈": ["응시료", "수수료"],
  "얼마": ["응시료", "수수료"], "가격": ["응시료", "수수료"], "비용": ["응시료", "수수료"],
  "1차": ["필기"], "일차": ["필기"], "이론": ["필기"],
  "포크레인": ["굴착기", "굴착기운전기능사"], "굴삭기": ["굴착기", "굴착기운전기능사"],
  "지게차면허": ["지게차", "지게차운전기능사"], "요양사": ["요양보호사"],
  "한식": ["한식조리기능사"], "조리사": ["한식조리기능사"], "전기": ["전기기능사"],
  "언제": ["일정", "기간", "접수"], "어디": ["접수처", "시험장", "사이트"],
  "취소": ["환불"], "돌려": ["환불"], "물러": ["환불"],
  "준비물": ["지참", "준비"], "가져": ["지참", "준비물"],
};

// 조사·어미. "접수비가" 와 "접수비" 를 같은 낱말로 세기 위해 뗍니다.
const PARTICLES = [
  "입니까","인가요","이에요","예요","인지","나요","까요","군요","네요",
  "이라고","라고","부터","까지","에서","으로","한테","에게","께서",
  "이랑","하고","보다","처럼","마다","조차","밖에","이나","거나",
  "은","는","이","가","을","를","의","에","로","와","과","도","만","요","랑","께","서",
].sort((a, b) => b.length - a.length);

function stem(word) {
  for (const p of PARTICLES) {
    if (word.length > p.length + 1 && word.endsWith(p)) return word.slice(0, -p.length);
  }
  return word;
}

function tokens(text) {
  const words = String(text || "").toLowerCase().match(/[가-힣a-z0-9]+/g) || [];
  const out = new Set(words);
  for (const w of words) out.add(stem(w));
  const flat = String(text || "").replace(/\s/g, "");
  for (const [word, extra] of Object.entries(SYNONYMS)) {
    if (flat.includes(word)) extra.forEach(e => out.add(e));
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// ---------- 정해진 답 ----------
// "언제 거절할지"는 아래 규칙(코드)이 정합니다. 직원이 바꿀 수 없습니다.
// "뭐라고 말할지"는 문서(faq_docs)에서 읽습니다. 직원이 바꿀 수 있습니다.
//   900번 안내문 · 모를 때
//   910번 안내문 · 실기 질문
// 문서를 못 읽으면 아래 기본 문구를 씁니다.

const DEFAULT_PRACTICAL =
  "저희는 필기 접수만 도와드립니다. 실기는 저희가 안내하지 않습니다.";

const DEFAULT_UNKNOWN =
  "모르겠습니다. 저희가 확인하지 못한 내용이라 알려드릴 수 없습니다.\n" +
  "짐작해서 말씀드리면 잘못 안내될 수 있어 답을 드리지 않습니다.";

const NOTICE_UNKNOWN   = "안내문 · 모를 때";
const NOTICE_PRACTICAL = "안내문 · 실기 질문";

function notice(docs, title, fallback) {
  const d = docs.find(x => x.title === title);
  return (d && d.content && d.content.trim()) ? d.content.trim() : fallback;
}

// 안내문은 근거 문서로 쓰지 않습니다. 답변 문구일 뿐이라서요.
const isNotice = d => d.title === NOTICE_UNKNOWN || d.title === NOTICE_PRACTICAL;

// "2차"는 넣지 않았습니다. 손해평가사·공인중개사는 필기를 1차, 그 다음을 2차라
// 부르기 때문에, 2차를 실기로 보면 전문자격 질문까지 거절하게 됩니다.
const PRACTICAL_WORDS = ["실기", "실습"];

const FEE_WORDS = ["응시료", "수수료", "접수비", "시험비", "얼마", "가격", "비용", "돈"];

// 02_안내규정.md 9절 — 발주처가 확인하지 못한 8가지
const UNKNOWN_RULES = [
  [["요양보호사", "요양사"], FEE_WORDS, "요양보호사 응시료"],
  [["위생사"], FEE_WORDS, "위생사 응시료"],
  [["손해평가사"], FEE_WORDS, "손해평가사 응시료"],
  [["공인중개사"], FEE_WORDS, "공인중개사 응시료"],
  [["요양보호사", "요양사"], ["응시자격", "자격", "교육", "이수"], "요양보호사 응시자격"],
  [["위생사"], ["일정", "언제", "시험일", "날짜"], "위생사 시험 일정"],
  [["공인중개사"], ["면제"], "공인중개사 1차 면제 기간"],
];

// 발주서 95-98줄 — 저희가 답할 수 없는 질문
const CANNOT_ANSWER = [
  ["주차"],
  ["붙", "합격할", "될까", "가능할까"],
  ["다른 자격증", "같이 딸", "동시에"],
];

const hasAny = (text, words) => words.some(w => text.includes(w));

function fixedAnswer(question, docs) {
  const q = question.replace(/\s/g, "");
  const unknown   = notice(docs, NOTICE_UNKNOWN,   DEFAULT_UNKNOWN);
  const practical = notice(docs, NOTICE_PRACTICAL, DEFAULT_PRACTICAL);

  if (hasAny(q, PRACTICAL_WORDS)) return [practical, "실기 질문"];
  for (const [subjects, topics, label] of UNKNOWN_RULES) {
    if (hasAny(q, subjects) && hasAny(q, topics)) return [unknown, "확인 못 한 항목: " + label];
  }
  for (const group of CANNOT_ANSWER) {
    if (hasAny(q, group)) return [unknown, "저희 소관이 아닌 질문"];
  }
  return [null, null];
}

// ---------- 문서 읽기 ----------
// 질문마다 새로 읽습니다. 직원이 고친 내용이 바로 반영되어야 하기 때문입니다.
async function loadDocs() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  const res = await fetch(
    `${url}/rest/v1/faq_docs?select=title,content&is_active=eq.true&order=sort_order`,
    { headers: { apikey: key, Authorization: "Bearer " + key } }
  );
  if (!res.ok) return [];
  return await res.json();
}

// ---------- Gemini ----------
const PROMPT = (context, question) => `당신은 두두자격지원센터의 안내 직원입니다.
아래 [근거]에 적힌 내용만 사용해서 어르신께 답하십시오.

지켜야 할 것
- [근거]에 없는 내용은 절대 만들어 내지 마십시오.
- 금액, 날짜, 숫자는 [근거]에 적힌 그대로만 쓰십시오.
- 60대 이상 어르신이 읽으십니다. 짧고 쉬운 말로, 존댓말로 답하십시오.
- 물어보신 것에만 답하십시오. 묻지 않으신 것은 덧붙이지 마십시오.
- 두 문장 안에 끝내십시오. 100자를 넘기지 마십시오.
- 날짜나 목록이 여럿이면 줄을 바꿔 한 줄에 하나씩 적으십시오. 이때는 문장 수 제한을 넘겨도 됩니다.
- 되물어보지 마십시오. [근거]에 있는 내용으로 바로 답하십시오.
- [근거]로 답할 수 없으면 "모르겠습니다"라고만 답하십시오.

[근거]
${context}

[질문]
${question}
`;

async function askGemini(question, context) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT(context, question) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || "").join("").trim();
    return text || null;
  } catch {
    return null;
  }
}

// 너무 길면 문장 끝에서 자릅니다. 중간에 끊긴 문장을 보여드리지 않기 위해서입니다.
function trim(text, limit = 160) {
  text = text.trim();
  // 줄바꿈이 있는 답(일정 목록 등)은 자르지 않습니다.
  if (text.includes("\n")) return text;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf("다."), cut.lastIndexOf("요."), cut.lastIndexOf("."));
  return (end > 40 ? cut.slice(0, end + 1) : cut).trim();
}

// 화면은 글을 마크다운으로 읽습니다. ~ 는 취소선 기호라 글자를 먹습니다.
const forScreen = t => t.replace(/~/g, " – ");

// =============================================================
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST 로 보내 주십시오" });

  const question = String(req.body?.message || "").trim();
  if (!question) return res.status(200).json({ answer: "궁금하신 것을 적어 주십시오.", source: "" });

  const docs = await loadDocs();

  // 1~3) 정해진 답 (거절 문구는 문서에서 읽습니다)
  const [fixed, why] = fixedAnswer(question, docs);
  if (fixed) return res.status(200).json({ answer: fixed, source: why });

  if (!docs.length) {
    return res.status(200).json({ answer: DEFAULT_UNKNOWN, source: "문서를 읽지 못했습니다" });
  }

  // 4~5) 검색 (안내문은 근거에서 제외)
  const q = tokens(question);
  const ranked = docs
    .filter(d => !isNotice(d))
    .map(d => ({
      score: overlap(q, tokens(d.title)) * 2 + overlap(q, tokens(d.content)),
      doc: d,
    }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  if (!ranked.length) {
    return res.status(200).json({
      answer: notice(docs, NOTICE_UNKNOWN, DEFAULT_UNKNOWN),
      source: "문서에서 근거를 찾지 못함",
    });
  }

  const context = ranked.map(x => `- ${x.doc.title}\n${x.doc.content}`).join("\n\n");
  const source = "근거: " + ranked[0].doc.title;

  // 6) 문장 다듬기
  const made = await askGemini(question, context);
  if (made) return res.status(200).json({ answer: forScreen(trim(made)), source });

  // Gemini 를 못 쓰면 문서 내용을 그대로 보여 드립니다. 지어내지 않습니다.
  return res.status(200).json({ answer: forScreen(ranked[0].doc.content), source });
}
