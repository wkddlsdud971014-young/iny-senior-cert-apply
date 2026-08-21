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
// 점수 문턱. 이보다 낮으면 Gemini 를 부르지 않고 "모르겠습니다"로 끊습니다.
// 2026-08-20: 낱말 개수 세기에서 IDF 가중치로 바꾸면서 단위가 달라져 다시 쟀습니다.
//   관련 없는 질문(날씨·주식·점심) 7개 → 전부 0.00점
//   답이 있어야 하는 질문 24개        → 가장 낮은 것이 2.99점
// 그 사이인 2.5 로 잡았습니다.
const MIN_SCORE = 2.5;
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
  // 2026-08-20 추가. 실습 챗봇(chatbot_build)에서 4,705건 상담 데이터로
  // 검색을 시험하다 이 줄임말들을 못 알아듣는 것을 확인하고 배포본에 옮겼다.
  // 확인 방법: 배포된 /api/chat 에 직접 물어 "모르겠습니다"가 나오는 것을 봤다.
  "요보사": ["요양보호사"], "손평사": ["손해평가사"],
  "개사": ["공인중개사"], "공개사": ["공인중개사"], "중개사": ["공인중개사"],
  "한조기": ["한식조리기능사"], "포클레인": ["굴착기", "굴착기운전기능사"],
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

// extra 는 직원이 「말 바꾸기」 화면에서 넣은 것입니다. { 줄임말: 정식명칭 }
// 코드에 적힌 SYNONYMS 위에 얹습니다. 표가 비어 있거나 못 읽어도
// 코드에 적힌 것만으로 그대로 동작합니다.
function tokens(text, extra = {}) {
  const words = String(text || "").toLowerCase().match(/[가-힣a-z0-9]+/g) || [];
  const out = new Set(words);
  for (const w of words) out.add(stem(w));
  const flat = String(text || "").replace(/\s/g, "");
  for (const [word, more] of Object.entries(SYNONYMS)) {
    if (flat.includes(word)) more.forEach(e => out.add(e));
  }
  for (const [short, full] of Object.entries(extra)) {
    if (short && full && flat.includes(short)) out.add(full);
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

// ---------- 낱말의 무게 (IDF) ----------
// 2026-08-20 추가.
//
// 그 전에는 겹치는 낱말을 그냥 세었습니다. 그러면 "접수"처럼 거의 모든
// 문서에 있는 낱말과 "환불"처럼 한두 문서에만 있는 낱말이 똑같이 한 표씩
// 됩니다. 그래서 "환불 언제까지 되나요" 라고 물으시면 ("언제" 가 "접수" 로
// 넓혀지는 탓에) 제목에 "접수" 가 든 문서들이 위로 올라오고, 정작 환불
// 문서는 상위 세 개 안에도 못 들어갔습니다. Gemini 는 엉뚱한 근거만 받으니
// 답할 방법이 없습니다.
//
// IDF 는 "이 낱말이 몇 개 문서에 나오는가" 를 봅니다. 여러 문서에 나오면
// 가볍게, 몇 문서에만 나오면 무겁게 칩니다. 흔한 낱말로는 문서를 고를 수
// 없고, 드문 낱말이 진짜 단서이기 때문입니다.
//
// 실습(chatbot_build)에서 4,705건으로 확인한 방식을 문서 21건에 옮긴 것입니다.
// 옮기기 전 24문항으로 재어 보았습니다.
//   상위 3개 안에 정답 문서가 드는 비율: 20/24(83%) → 22/24(92%)
//   나빠진 문항은 없었습니다.
function buildIdf(docs, aliases = {}) {
  const n = docs.length;
  const df = new Map();
  for (const d of docs) {
    const words = new Set([...tokens(d.title, aliases), ...tokens(d.content, aliases)]);
    for (const w of words) df.set(w, (df.get(w) || 0) + 1);
  }
  // +1 은 한 번도 안 나온 낱말에서 0 으로 나누는 것을 막습니다.
  return w => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;
}

// 제목에서 맞으면 두 배로 칩니다. 예전 방식과 같은 규칙입니다.
function weighted(qt, doc, idf, aliases = {}) {
  const t = tokens(doc.title, aliases), c = tokens(doc.content, aliases);
  let s = 0;
  for (const w of qt) {
    if (t.has(w)) s += 2 * idf(w);
    if (c.has(w)) s += idf(w);
  }
  return s;
}

// ---------- 정해진 답 ----------
// "언제 거절할지"는 아래 규칙(코드)이 정합니다. 직원이 바꿀 수 없습니다.
// "뭐라고 말할지"는 문서(faq_docs)에서 읽습니다. 직원이 바꿀 수 있습니다.
// 문서를 못 읽으면 아래 기본 문구를 씁니다.
//
// 2026-08-21 — 답변 단계를 셋으로 나눔.
//
// 그 전에는 두 갈래였습니다.
//   근거 있음 → 답변 / 근거 없음 → 거절
//
// 사용성 테스트에서, 답할 수 있는 것까지 같이 끊기는 것을 보았습니다.
//   "제가 합격할 수 있을까요?"     → "모르겠습니다"
//   "시험 공부를 얼마나 해야 하나요?" → "모르겠습니다"
// 합격 여부는 정말 알 수 없습니다. 하지만 시험 일정과 준비물은 저희가 압니다.
// 어르신은 "여기서는 아무것도 안 알려주는구나" 하고 끊으셨습니다.
//
// 그래서 가운데 단계를 넣었습니다.
//   답변 가능      근거가 있다             → 근거대로 답한다
//   조건부 답변 가능 그건 못 하지만 이건 된다  → 못 하는 것 + 대신 되는 것을 같이 말한다
//   답변 불가      저희 범위 밖이다         → 안 된다고만 말한다
//
// 지어내지 않는다는 원칙은 그대로입니다. 조건부도 새 사실을 만들지 않습니다.
// 못 하는 것을 여전히 못 한다고 말하되, 할 수 있는 일을 덧붙일 뿐입니다.

const LEVEL = { FULL: "답변 가능", PARTIAL: "조건부 답변 가능", NONE: "답변 불가" };

const NOTICE_UNKNOWN   = "안내문 · 모를 때";
const NOTICE_PRACTICAL = "안내문 · 실기 질문";
const NOTICE_UNVERIFIED = "안내문 · 확인 못 한 항목";
const NOTICE_PASS      = "안내문 · 합격 예측";
const NOTICE_VENUE     = "안내문 · 시험장 시설";
const NOTICE_MULTI     = "안내문 · 여러 자격증";

const DEFAULTS = {
  [NOTICE_UNKNOWN]:
    "모르겠습니다. 저희가 확인하지 못한 내용이라 알려드릴 수 없습니다.\n" +
    "짐작해서 말씀드리면 잘못 안내될 수 있어 답을 드리지 않습니다.",

  [NOTICE_PRACTICAL]:
    "실기는 저희가 안내해 드리지 않습니다.\n" +
    "필기 접수는 저희가 도와드립니다. 필기에 대해 물어봐 주십시오.",

  // 무엇을 확인 못 했는지는 앞에 한 줄로 붙습니다. (fixedAnswer 참고)
  // 확인 못 한 여덟 가지에는 응시료도 있고 일정도 있어, 문서에는 공통된 말만 둡니다.
  [NOTICE_UNVERIFIED]:
    "짐작해서 말씀드리면 잘못 안내될 수 있어 알려드리지 않습니다.\n" +
    "대신 어디서 접수하는지, 언제까지 접수하는지는 알려드릴 수 있습니다.",

  [NOTICE_PASS]:
    "합격 여부를 미리 판단해 드릴 수는 없습니다.\n" +
    "대신 시험 일정이나 시험 당일 준비물은 알려드릴 수 있습니다.",

  [NOTICE_VENUE]:
    "시험장 안의 시설은 저희가 확인하지 못했습니다.\n" +
    "시험장을 어디서 고르는지, 무엇을 가져가시는지는 알려드릴 수 있습니다.",

  [NOTICE_MULTI]:
    "여러 자격증을 함께 준비하시는 것이 좋을지는 저희가 판단해 드릴 수 없습니다.\n" +
    "저희가 다루는 여덟 가지 가운데 궁금한 자격증의 접수 방법은 알려드릴 수 있습니다.",
};

function notice(docs, title) {
  const d = docs.find(x => x.title === title);
  return (d && d.content && d.content.trim()) ? d.content.trim() : (DEFAULTS[title] || "");
}

// 안내문은 근거 문서로 쓰지 않습니다. 답변 문구일 뿐이라서요.
const NOTICE_TITLES = Object.keys(DEFAULTS);
const isNotice = d => NOTICE_TITLES.includes(d.title);

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
//
// 전에는 셋 다 "모르겠습니다"로 똑같이 끊었습니다.
// 이제는 못 하는 것마다 대신 해 드릴 수 있는 일을 함께 말합니다.
// 무엇을 못 하는지는 그대로입니다. 판단해 드리지 않는다는 원칙은 지킵니다.
const PARTIAL_RULES = [
  { words: ["주차"],                                    notice: NOTICE_VENUE, label: "시험장 시설" },
  // "붙" 한 글자로 두면 안 됩니다. 2026-08-21 배포 뒤 재어 보고 좁혔습니다.
  //   기능사 필기 붙으면 몇 년 동안 인정되나요?   → 붙으  ❌ 잡힘
  //   필기 붙은 다음에 뭘 해야 하나요?           → 붙은  ❌ 잡힘
  //   사진은 어디에 붙여야 하나요?               → 붙여  ❌ 잡힘
  // 앞의 둘은 문서에 답이 있고, 셋째는 합격과 아무 상관이 없습니다.
  // "붙을" 로 좁히면 물어보시는 것("붙을까요" "붙을 수 있을까요")만 걸립니다.
  { words: ["붙을", "붙나요", "합격할", "될까", "가능할까"], notice: NOTICE_PASS, label: "합격 예측" },
  { words: ["다른 자격증", "같이 딸", "동시에"],           notice: NOTICE_MULTI, label: "여러 자격증" },
];

// 질문은 띄어쓰기를 지우고 견줍니다. 어르신마다 띄어 쓰시는 자리가 달라서입니다.
// 그러니 찾는 낱말에서도 띄어쓰기를 지워야 합니다.
//
// 2026-08-21 고침. 전에는 낱말 쪽을 안 지웠습니다. 그래서 "같이 딸" 같은
// 두 낱말짜리 규칙은 한 번도 맞은 적이 없었습니다.
// ("지게차랑 굴착기 같이 딸 수 있나요?" → "지게차랑굴착기같이딸수있나요?" 에는
//  "같이 딸" 이 없습니다. 띄어쓰기가 사이에 끼어 있어서입니다.)
const hasAny = (text, words) =>
  words.some(w => text.includes(String(w).replace(/\s/g, "")));

// ---------- 저희가 다루지 않는 자격증 걸러내기 ----------
// 2026-08-20 추가.
//
// "정보처리기사 환불 규정" 을 물으시면 환불 규정을 그대로 안내하고 있었습니다.
// 환불 규정 문서에는 자격증명이 안 적혀 있어(저희가 다루는 여덟 가지 공통 규정),
// Gemini 가 그 질문이 범위 밖인 줄 몰랐던 것입니다.
// 그대로 두면 "여기서 정보처리기사도 접수되는구나" 로 오해하시게 됩니다.
//
// 모델의 판단에 맡기면 그때그때 다릅니다. 실제로 "미용사 환불 규정" 은 거절했는데
// "정보처리기사 환불 규정" 은 답했습니다. 그래서 규칙으로 확실히 끊습니다.
const OUR_CERTS = [
  "한식조리기능사", "지게차운전기능사", "굴착기운전기능사", "전기기능사",
  "손해평가사", "공인중개사", "요양보호사", "위생사",
];

// 자격증을 가리키는 별칭만 넣습니다.
// "전기", "한식" 같은 넓은 낱말은 넣지 않습니다. 넣으면 "전기기사" 까지 통과합니다.
const CERT_NICKNAMES = [
  "포크레인", "포클레인", "굴삭기", "지게차면허",
  "요양사", "요보사", "손평사", "한조기",
];

// "정보처리기사", "제과기능사" 처럼 자격증 이름꼴을 찾습니다.
const CERT_LIKE = /[가-힣]{2,8}?(기능사|기사)/g;

function outOfScopeCert(question) {
  const flat = question.replace(/\s/g, "");
  const hits = flat.match(CERT_LIKE) || [];
  for (const h of hits) {
    if (OUR_CERTS.some(c => c.includes(h) || h.includes(c))) continue;
    if (CERT_NICKNAMES.some(w => h.includes(w))) continue;
    return h;   // 저희가 다루지 않는 자격증
  }
  return null;
}

// ---------- 상담 기록 3,347건 ----------
// 2026-08-20 추가.
//
// 안내 문서(faq_docs)는 발주 문서를 보고 직접 쓴 23건이라 정확하지만 범위가 좁습니다.
// 실습에서 쓰던 상담 기록 4,705건을 답변 기준으로 묶어(같은 답끼리 합치고 질문 표현은
// 모두 남겨) 3,347건으로 만들어 함께 싣습니다.
//
// Supabase 표에 넣지 않고 파일로 싣는 이유:
//   Supabase 는 한 번에 1,000행까지만 돌려줍니다. 3,347건을 읽으려면 질문마다
//   네 번씩 나눠 받아야 해서 느려집니다. 파일은 함수가 처음 뜰 때 한 번만 읽습니다.
//
// 칸 이름은 c(자격증) g(분류) q(질문들) a(답변) 로 줄였습니다. 1.98MB 입니다.
import BULK from "./faq-bulk.js";

// 자격증명과 분류를 여러 번 적어 비중을 올립니다.
// 상담 기록은 대화가 길어 자격증명 한 낱말이 묻히기 때문입니다.
// 실습(S6)에서 8개 자격증 × 3개 주제 = 24문항으로 재어 5번으로 정했습니다.
//   1번 17/24 · 3번 18/24 · 5번 24/24 · 7번 24/24
const CERT_WEIGHT = 5;

// 상담 기록의 자격증명은 짧은 형태입니다(전기, 한식조리, 굴착기, 지게차).
// 어르신은 정식 명칭으로도 물으시므로 두 형태를 함께 넣습니다.
const CERT_FULL = {
  "전기": "전기기능사", "한식조리": "한식조리기능사",
  "굴착기": "굴착기운전기능사", "지게차": "지게차운전기능사",
  "요양보호사": "요양보호사", "위생사": "위생사",
  "손해평가사": "손해평가사", "공인중개사": "공인중개사",
};

const bulkText = d => {
  const full = CERT_FULL[d.c] || d.c;
  const name = `${d.c} ${full} `;
  return `${name.repeat(CERT_WEIGHT)}${(d.g + " ").repeat(CERT_WEIGHT)}${d.q} ${d.a}`;
};

// 질문에 자격증이 나오면 그 자격증 상담만 봅니다.
// 문턱만으로는 가를 수 없기 때문입니다. 실제로 재어 보니
// 관련 없는 질문이 9.4점인데 정상 질문이 7.3점인 경우가 있었습니다.
// 자격증을 먼저 좁히면 그런 겹침이 사라집니다.
function certInQuestion(question) {
  const flat = question.replace(/\s/g, "");
  for (const [short, full] of Object.entries(CERT_FULL)) {
    if (flat.includes(full) || flat.includes(short)) return short;
  }
  const nick = {
    "포크레인": "굴착기", "포클레인": "굴착기", "굴삭기": "굴착기",
    "지게차면허": "지게차", "요양사": "요양보호사", "요보사": "요양보호사",
    "손평사": "손해평가사", "한조기": "한식조리",
    "개사": "공인중개사", "공개사": "공인중개사", "중개사": "공인중개사",
  };
  for (const [w, c] of Object.entries(nick)) if (flat.includes(w)) return c;
  return null;
}

// 함수가 처음 뜰 때 한 번만 만듭니다. 그 뒤 질문에서는 다시 만들지 않습니다.
let BULK_IDF = null;
let BULK_TOKENS = null;
function prepareBulk() {
  if (BULK_IDF) return;
  BULK_TOKENS = BULK.map(d => tokens(bulkText(d)));
  const df = new Map();
  for (const set of BULK_TOKENS) for (const w of set) df.set(w, (df.get(w) || 0) + 1);
  const n = BULK.length;
  BULK_IDF = w => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;
}

// 상담 기록 점수 문턱. 자격증을 먼저 좁히므로 아주 높게 둘 필요는 없습니다.
// 재어 보니 정상 질문의 최저가 7.3, 자격증을 안 밝힌 질문은 후보 자체가 안 생겨
// 0 이었습니다. 그 사이인 5 로 잡았습니다.
const BULK_MIN_SCORE = 5;

function searchBulk(question, aliases = {}) {
  prepareBulk();
  const q = tokens(question, aliases);
  const cert = certInQuestion(question);
  // 자격증을 안 밝히고 물으시면 어느 자격증 상담을 골라야 할지 알 수 없습니다.
  // 그때는 상담 기록을 쓰지 않습니다. 안내 문서에서 못 찾았다면 모른다고 답합니다.
  if (!cert) return [];

  const out = [];
  for (let i = 0; i < BULK.length; i++) {
    if (BULK[i].c !== cert) continue;
    const words = BULK_TOKENS[i];
    let s = 0;
    for (const w of q) if (words.has(w)) s += BULK_IDF(w);
    if (s >= BULK_MIN_SCORE) out.push({ score: s, doc: BULK[i] });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, TOP_K);
}

// 앞말에 받침이 있으면 "은", 없으면 "는" 을 붙입니다.
//   "요양보호사 응시료" → "요양보호사 응시료는"
//   "공인중개사 1차 면제 기간" → "공인중개사 1차 면제 기간은"
// 조사를 "은(는)" 으로 적으면 소리 내어 읽으실 때 걸립니다.
function withTopic(word, rest) {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  const 한글 = code >= 0xAC00 && code <= 0xD7A3;
  const 받침 = 한글 && (code - 0xAC00) % 28 !== 0;
  return word + (받침 ? "은 " : "는 ") + rest;
}

// 돌려주는 값: { answer, source, level }
// level 이 없으면 정해진 답이 아니라는 뜻입니다. 그때는 문서를 찾아봅니다.
function fixedAnswer(question, docs) {
  const q = question.replace(/\s/g, "");

  // --- 조건부 답변 가능 ---
  // 실기는 안내하지 않지만 필기는 도와드립니다.
  if (hasAny(q, PRACTICAL_WORDS))
    return { answer: notice(docs, NOTICE_PRACTICAL), source: "실기 질문", level: LEVEL.PARTIAL };

  // --- 답변 불가 ---
  // 저희가 다루지 않는 자격증입니다. 대신 해 드릴 수 있는 일이 없습니다.
  // 안내 문구는 문서("저희가 다루는 자격증 여덟 가지")에서 읽어 직원이 고칠 수 있게 합니다.
  const other = outOfScopeCert(question);
  if (other) {
    const list = notice(docs, "저희가 다루는 자격증 여덟 가지");
    const head = withTopic(other, "저희가 접수를 도와드리지 않습니다.");
    return { answer: list ? `${head}\n${list}` : head,
             source: "다루지 않는 자격증: " + other, level: LEVEL.NONE };
  }

  // --- 조건부 답변 가능 ---
  // 발주처가 확인하지 못한 항목입니다. 그것은 못 말씀드리지만 접수처와 일정은 압니다.
  // 무엇을 확인 못 했는지 이름을 대 드립니다. "그건 모릅니다"보다 덜 막막합니다.
  for (const [subjects, topics, label] of UNKNOWN_RULES) {
    if (hasAny(q, subjects) && hasAny(q, topics))
      return { answer: withTopic(label, "저희가 확인하지 못했습니다.") + "\n" +
                       notice(docs, NOTICE_UNVERIFIED),
               source: "확인 못 한 항목: " + label, level: LEVEL.PARTIAL };
  }

  // --- 조건부 답변 가능 ---
  // 저희가 판단해 드릴 수 없는 질문입니다. 대신 해 드릴 수 있는 일을 말씀드립니다.
  for (const rule of PARTIAL_RULES) {
    if (hasAny(q, rule.words))
      return { answer: notice(docs, rule.notice),
               source: "판단해 드릴 수 없는 질문: " + rule.label, level: LEVEL.PARTIAL };
  }

  return { answer: null, source: null, level: null };
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

// ---------- 직원이 넣은 말 바꾸기 읽기 ----------
// 문서와 같은 방식입니다. 질문마다 새로 읽어야 「말 바꾸기」 화면에서
// 방금 넣은 것이 바로 반영됩니다.
// 표가 없거나 못 읽어도 빈 것을 돌려줍니다. 그러면 코드에 적힌
// SYNONYMS 만으로 지금까지처럼 동작합니다. 챗봇이 멈추지 않습니다.
async function loadAliases() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return {};
  try {
    const res = await fetch(
      `${url}/rest/v1/synonyms?select=short,full&is_active=eq.true`,
      { headers: { apikey: key, Authorization: "Bearer " + key } }
    );
    if (!res.ok) return {};
    const rows = await res.json();
    const out = {};
    for (const r of rows) if (r.short && r.full) out[r.short.trim()] = r.full.trim();
    return out;
  } catch {
    return {};
  }
}

// ---------- 줄임말 풀이 ----------
// 동의어는 지금까지 "검색"에만 쓰였습니다. 근거는 제대로 찾아 놓고도
// Gemini 에게는 원래 질문이 그대로 가서, "개사" 같은 짧은 줄임말은
// Gemini 가 못 알아듣고 "모르겠습니다"로 답하는 일이 있었습니다.
// 그래서 어떤 줄임말을 쓰셨는지 한 줄로 알려 드립니다.
// 질문 자체는 고치지 않습니다. "얼마" 같은 말까지 바꾸면 문장이 망가집니다.
const CERT_ALIASES = {
  "포크레인": "굴착기운전기능사", "포클레인": "굴착기운전기능사", "굴삭기": "굴착기운전기능사",
  "지게차면허": "지게차운전기능사", "요양사": "요양보호사", "요보사": "요양보호사",
  "손평사": "손해평가사", "개사": "공인중개사", "공개사": "공인중개사", "중개사": "공인중개사",
  "한조기": "한식조리기능사", "조리사": "한식조리기능사",
};

function aliasHint(question, extra = {}) {
  const flat = question.replace(/\s/g, "");
  const all = { ...CERT_ALIASES, ...extra };   // 직원이 넣은 것이 코드 값을 덮어씁니다
  const hits = [];
  for (const [word, full] of Object.entries(all)) {
    if (flat.includes(word) && !flat.includes(full)) hits.push(`${word} = ${full}`);
  }
  return hits.length ? `\n\n[줄임말 풀이]\n${hits.join("\n")}` : "";
}

// ---------- Gemini ----------
const PROMPT = (context, question, aliases = {}) => `당신은 두두자격지원센터의 안내 직원입니다.
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
${question}${aliasHint(question, aliases)}
`;

async function askGemini(question, context, aliases = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT(context, question, aliases) }] }],
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
  const aliases = await loadAliases();   // 직원이 「말 바꾸기」 화면에서 넣은 것

  // 1~3) 정해진 답 (안내 문구는 문서에서 읽습니다)
  const fixed = fixedAnswer(question, docs);
  if (fixed.answer) return res.status(200).json(fixed);

  if (!docs.length) {
    return res.status(200).json({ answer: DEFAULTS[NOTICE_UNKNOWN],
                                  source: "문서를 읽지 못했습니다", level: LEVEL.NONE });
  }

  // 4~5) 검색 (안내문은 근거에서 제외)
  const q = tokens(question, aliases);
  const pool = docs.filter(d => !isNotice(d));
  const idf = buildIdf(pool, aliases);
  const rankedDocs = pool
    .map(d => ({ score: weighted(q, d, idf, aliases), doc: d }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  // 4-2) 안내 문서로 답이 안 나오면 상담 기록 3,347건을 본다
  //
  // 안내 문서 23건은 발주 문서를 보고 직접 쓴 것이라 정확하지만 범위가 좁습니다.
  // 상담 기록은 범위가 넓은 대신 검증된 문서가 아닙니다.
  // 그래서 **안내 문서를 먼저** 보고, 거기서 답이 안 나올 때만 상담 기록을 봅니다.
  // 순서를 바꾸면 검증되지 않은 내용이 검증된 안내문을 밀어냅니다.
  //
  // "찾지 못했을 때"가 아니라 "답이 안 나왔을 때"로 잡았습니다.
  // 문서를 찾긴 했는데 주제가 달라 Gemini 가 거절하는 경우가 더 흔하기 때문입니다.
  // ("굴착기 시험장 어디예요" → 「어디서 접수하나」를 찾았지만 시험장 얘기가 없음)

  // 답이 사실상 "모르겠습니다" 인지 봅니다.
  const isUnknown = s => !s || /모르겠|확인할 수 없|알려드릴 수 없/.test(s);

  async function tryAnswer(hits, bulk) {
    if (!hits.length) return null;
    const context = bulk
      // 상담 기록에는 본문에 자격증명이 안 나옵니다. 통화하는 두 사람은 이미 알고
      // 있어 말하지 않기 때문입니다. 그대로 넘기면 다른 자격증 금액을 옮겨 말하게 됩니다.
      // 그래서 근거마다 어느 자격증 상담인지 함께 적습니다.
      ? hits.map(x => `- [${x.doc.c} · ${x.doc.g}] 상담 기록\n${x.doc.a}`).join("\n\n")
      : hits.map(x => `- ${x.doc.title}\n${x.doc.content}`).join("\n\n");
    const src = bulk
      ? `근거: ${hits[0].doc.c} 상담 기록 (${hits[0].doc.g})`
      : "근거: " + hits[0].doc.title;

    const made = await askGemini(question, context, aliases);
    if (made && !isUnknown(made))
      return { answer: forScreen(trim(made)), source: src, level: LEVEL.FULL };
    // Gemini 를 못 쓰면 문서 내용을 그대로 보여 드립니다. 지어내지 않습니다.
    if (!made) {
      const plain = bulk ? hits[0].doc.a : hits[0].doc.content;
      return { answer: forScreen(plain), source: src, level: LEVEL.FULL };
    }
    return null;   // 근거는 있었으나 답이 안 나온 경우
  }

  const first = await tryAnswer(rankedDocs, false);
  if (first) return res.status(200).json(first);

  const second = await tryAnswer(searchBulk(question, aliases), true);
  if (second) return res.status(200).json(second);

  return res.status(200).json({
    answer: notice(docs, NOTICE_UNKNOWN),
    source: "문서에서 근거를 찾지 못함",
    level:  LEVEL.NONE,
  });
}
