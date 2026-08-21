# -*- coding: utf-8 -*-
"""
두두자격지원센터 FAQ 챗봇

실행
    python3 app.py           화면 열기
    python3 app.py --test    채점 5문항 돌리기

답하는 순서
    1. 실기를 물으셨나         → "저희는 필기 접수만 도와드립니다"
    2. 확인 못 한 것을 물으셨나 → "모르겠습니다"
    3. 비슷한말을 문서 말로 바꾸기
    4. 문서에서 겹치는 단어 세기
    5. 점수가 낮으면           → "모르겠습니다"  (Gemini 를 부르지 않습니다)
    6. 찾은 근거만 주고 Gemini 가 문장을 다듬기

핵심: 근거를 못 찾으면 Gemini 를 아예 부르지 않습니다.
      그래야 지어낼 수가 없습니다. (발주서 12줄 - "이게 가장 중요합니다")
"""

import json, math, os, re, sys, urllib.request, urllib.error
from pathlib import Path

from settings import TOP_K, MIN_SCORE, USE_GEMINI, GEMINI_MODELS
from synonyms import SYNONYMS, PRACTICAL_WORDS, stem

HERE = Path(__file__).parent
FAQ_PATH = HERE / "faq.json"


# =============================================================
# 키 읽기 — .env 파일에서만 읽습니다. 코드에 적지 않습니다.
# =============================================================

def load_env():
    """.env 파일을 읽어 값들을 돌려줍니다. 코드에 키를 적지 않습니다."""
    out = {}
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    # 배포(Hugging Face 등)에서는 서버 환경변수를 씁니다.
    for k in ("GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY"):
        out.setdefault(k, os.environ.get(k, ""))
        if not out[k]:
            out[k] = os.environ.get(k, "")
    return out


ENV = load_env()
GEMINI_API_KEY    = ENV.get("GEMINI_API_KEY", "")
SUPABASE_URL      = ENV.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = ENV.get("SUPABASE_ANON_KEY", "")


# =============================================================
# 정해진 답 — 검색하기 전에 먼저 걸러냅니다
# =============================================================

# "언제 거절할지"는 아래 규칙(코드)이 정합니다. 직원이 바꿀 수 없습니다.
# "뭐라고 말할지"는 문서(faq_docs)에서 읽습니다. 직원이 바꿀 수 있습니다.
# 문서를 못 읽으면 아래 기본 문구를 씁니다.
#
# 2026-08-21 — 답변 단계를 셋으로 나눔. api/chat.js 와 같은 규칙입니다.
#
# 그 전에는 두 갈래였습니다. 근거 있음 → 답변 / 근거 없음 → 거절.
# 그래서 답할 수 있는 것까지 같이 끊겼습니다.
#   "제가 합격할 수 있을까요?" → "모르겠습니다"
# 합격 여부는 정말 알 수 없습니다. 하지만 시험 일정과 준비물은 저희가 압니다.
#
#   답변 가능       근거가 있다             → 근거대로 답한다
#   조건부 답변 가능  그건 못 하지만 이건 된다  → 못 하는 것 + 되는 것을 같이 말한다
#   답변 불가       저희 범위 밖이다         → 안 된다고만 말한다
#
# 지어내지 않는다는 원칙은 그대로입니다. 조건부도 새 사실을 만들지 않습니다.

LEVEL_FULL    = "답변 가능"
LEVEL_PARTIAL = "조건부 답변 가능"
LEVEL_NONE    = "답변 불가"

NOTICE_UNKNOWN    = "안내문 · 모를 때"
NOTICE_PRACTICAL  = "안내문 · 실기 질문"
NOTICE_UNVERIFIED = "안내문 · 확인 못 한 항목"
NOTICE_PASS       = "안내문 · 합격 예측"
NOTICE_VENUE      = "안내문 · 시험장 시설"
NOTICE_MULTI      = "안내문 · 여러 자격증"

DEFAULTS = {
    NOTICE_UNKNOWN: (
        "모르겠습니다. 저희가 확인하지 못한 내용이라 알려드릴 수 없습니다.\n"
        "짐작해서 말씀드리면 잘못 안내될 수 있어 답을 드리지 않습니다."
    ),
    NOTICE_PRACTICAL: (
        "실기는 저희가 안내해 드리지 않습니다.\n"
        "필기 접수는 저희가 도와드립니다. 필기에 대해 물어봐 주십시오."
    ),
    # 무엇을 확인 못 했는지는 앞에 한 줄로 붙습니다. (fixed_answer 참고)
    NOTICE_UNVERIFIED: (
        "짐작해서 말씀드리면 잘못 안내될 수 있어 알려드리지 않습니다.\n"
        "대신 어디서 접수하는지, 언제까지 접수하는지는 알려드릴 수 있습니다."
    ),
    NOTICE_PASS: (
        "합격 여부를 미리 판단해 드릴 수는 없습니다.\n"
        "대신 시험 일정이나 시험 당일 준비물은 알려드릴 수 있습니다."
    ),
    NOTICE_VENUE: (
        "시험장 안의 시설은 저희가 확인하지 못했습니다.\n"
        "시험장을 어디서 고르는지, 무엇을 가져가시는지는 알려드릴 수 있습니다."
    ),
    NOTICE_MULTI: (
        "여러 자격증을 함께 준비하시는 것이 좋을지는 저희가 판단해 드릴 수 없습니다.\n"
        "저희가 다루는 여덟 가지 가운데 궁금한 자격증의 접수 방법은 알려드릴 수 있습니다."
    ),
}


def notice(docs, title):
    for d in docs:
        if d["title"] == title and d["text"].strip():
            return d["text"].strip()
    return DEFAULTS.get(title, "")


def is_notice(d):
    return d["title"] in DEFAULTS


def with_topic(word, rest):
    """앞말에 받침이 있으면 '은', 없으면 '는' 을 붙입니다.

    "요양보호사 응시료" → "요양보호사 응시료는"
    조사를 "은(는)" 으로 적으면 소리 내어 읽으실 때 걸립니다.
    """
    last = word.strip()[-1]
    code = ord(last)
    한글 = 0xAC00 <= code <= 0xD7A3
    받침 = 한글 and (code - 0xAC00) % 28 != 0
    return word + ("은 " if 받침 else "는 ") + rest

# 02_안내규정.md 9절 — 발주처가 확인하지 못한 8가지.
# 이 조합으로 물으시면 무조건 모른다고 답합니다.
FEE_WORDS = ["응시료", "수수료", "접수비", "시험비", "얼마", "가격", "비용", "돈"]

UNKNOWN_RULES = [
    (["요양보호사", "요양사"],   FEE_WORDS,                          "요양보호사 응시료"),
    (["위생사"],                 FEE_WORDS,                          "위생사 응시료"),
    (["손해평가사"],             FEE_WORDS,                          "손해평가사 응시료"),
    (["공인중개사"],             FEE_WORDS,                          "공인중개사 응시료"),
    (["요양보호사", "요양사"],   ["응시자격", "자격", "교육", "이수"], "요양보호사 응시자격"),
    (["위생사"],                 ["일정", "언제", "시험일", "날짜"],   "위생사 시험 일정"),
    (["공인중개사"],             ["면제"],                            "공인중개사 1차 면제 기간"),
]

# 발주서 95-98줄 — 저희가 답할 수 없는 질문
#
# 2026-08-21 — 전에는 셋 다 "모르겠습니다"로 똑같이 끊었습니다.
# 이제는 못 하는 것마다 대신 해 드릴 수 있는 일을 함께 말합니다.
# 무엇을 못 하는지는 그대로입니다. 판단해 드리지 않는다는 원칙은 지킵니다.
#
# 낱말도 좁혔습니다. 전에는 "합격" 과 "가능" 만 들어가도 끊었습니다.
# 그래서 "필기 합격은 몇 년 유효한가요?" 처럼 문서에 답이 있는 질문까지
# 거절했습니다. api/chat.js 와 같이 "합격할" "가능할까" 로 맞춥니다.
PARTIAL_RULES = [
    (["주차"],                            NOTICE_VENUE, "시험장 시설"),
    (["붙", "합격할", "될까", "가능할까"],  NOTICE_PASS,  "합격 예측"),
    (["다른 자격증", "같이 딸", "동시에"],  NOTICE_MULTI, "여러 자격증"),
]


# 저희가 다루지 않는 자격증 걸러내기 (2026-08-20 추가)
#
# "정보처리기사 환불 규정" 을 물으시면 환불 규정을 그대로 안내하고 있었습니다.
# 환불 규정 문서에는 자격증명이 없어(여덟 가지 공통 규정) Gemini 가 범위 밖인 줄
# 몰랐던 것입니다. "여기서 정보처리기사도 접수되는구나" 로 오해하시게 됩니다.
#
# 모델 판단에 맡기면 그때그때 다릅니다. "미용사 환불 규정" 은 거절했는데
# "정보처리기사 환불 규정" 은 답했습니다. 그래서 규칙으로 끊습니다.
# api/chat.js 의 outOfScopeCert() 와 같은 규칙이어야 합니다.
OUR_CERTS = [
    "한식조리기능사", "지게차운전기능사", "굴착기운전기능사", "전기기능사",
    "손해평가사", "공인중개사", "요양보호사", "위생사",
]

# 자격증을 가리키는 별칭만. "전기", "한식" 같은 넓은 낱말은 넣지 않습니다.
# 넣으면 "전기기사" 까지 통과합니다.
CERT_NICKNAMES = [
    "포크레인", "포클레인", "굴삭기", "지게차면허",
    "요양사", "요보사", "손평사", "한조기",
]

CERT_LIKE = re.compile(r"[가-힣]{2,8}?(?:기능사|기사)")


def out_of_scope_cert(question):
    """저희가 다루지 않는 자격증이면 그 이름을 돌려줍니다. 아니면 None."""
    flat = question.replace(" ", "")
    for h in CERT_LIKE.findall(flat):
        if any(c in h or h in c for c in OUR_CERTS):
            continue
        if any(w in h for w in CERT_NICKNAMES):
            continue
        return h
    return None


def has_any(text, words):
    """질문은 띄어쓰기를 지우고 견줍니다. 어르신마다 띄어 쓰시는 자리가 달라서입니다.

    그러니 찾는 낱말에서도 띄어쓰기를 지워야 합니다.
    2026-08-21 고침. 전에는 낱말 쪽을 안 지웠습니다. 그래서 "같이 딸" 같은
    두 낱말짜리 규칙은 한 번도 맞은 적이 없었습니다.
    """
    return any(w.replace(" ", "") in text for w in words)


def fixed_answer(question, docs):
    """검색하기 전에 정해진 답이 있는지 봅니다. 문구는 문서에서 읽습니다.

    돌려주는 값: (answer, source, level)
    answer 가 None 이면 정해진 답이 아니라는 뜻입니다. 그때는 문서를 찾아봅니다.
    """
    q = question.replace(" ", "")

    # --- 조건부 답변 가능 ---
    # 실기는 안내하지 않지만 필기는 도와드립니다.
    if has_any(q, PRACTICAL_WORDS):
        return notice(docs, NOTICE_PRACTICAL), "실기 질문", LEVEL_PARTIAL

    # --- 답변 불가 ---
    # 저희가 다루지 않는 자격증입니다. 대신 해 드릴 수 있는 일이 없습니다.
    other = out_of_scope_cert(question)
    if other:
        listing = notice(docs, "저희가 다루는 자격증 여덟 가지")
        head = with_topic(other, "저희가 접수를 도와드리지 않습니다.")
        return ((f"{head}\n{listing}" if listing else head),
                "다루지 않는 자격증: " + other, LEVEL_NONE)

    # --- 조건부 답변 가능 ---
    # 발주처가 확인하지 못한 8가지입니다.
    # 그것은 못 말씀드리지만 접수처와 일정은 압니다.
    # 무엇을 확인 못 했는지 이름을 대 드립니다. "그건 모릅니다"보다 덜 막막합니다.
    for subjects, topics, label in UNKNOWN_RULES:
        if has_any(q, subjects) and has_any(q, topics):
            head = with_topic(label, "저희가 확인하지 못했습니다.")
            return (f"{head}\n{notice(docs, NOTICE_UNVERIFIED)}",
                    "확인 못 한 항목: " + label, LEVEL_PARTIAL)

    # --- 조건부 답변 가능 ---
    # 저희가 판단해 드릴 수 없는 질문입니다. 대신 해 드릴 수 있는 일을 말씀드립니다.
    for words, notice_title, label in PARTIAL_RULES:
        if has_any(q, words):
            return (notice(docs, notice_title),
                    "판단해 드릴 수 없는 질문: " + label, LEVEL_PARTIAL)

    return None, None, None


# =============================================================
# 검색 — 질문과 문서에 같이 나오는 단어를 셉니다
# =============================================================

def tokens(text, extra_aliases=None):
    """글에서 단어를 뽑습니다.
       조사를 떼고, 비슷한말은 문서에 적힌 말로 바꿔 함께 넣습니다.

       extra_aliases 는 직원이 「말 바꾸기」 화면에서 넣은 것입니다.
       {줄임말: 정식명칭} 꼴이며, 코드에 적힌 SYNONYMS 위에 얹습니다.
       표가 비어 있거나 못 읽어도 코드에 적힌 것만으로 그대로 동작합니다.
       api/chat.js 의 tokens() 와 같은 규칙이어야 합니다.
    """
    words = re.findall(r"[가-힣A-Za-z0-9]+", text.lower())

    base = set(words)
    for w in words:              # "접수비가" → "접수비" 도 함께 넣습니다
        base.add(stem(w))

    # 붙여 쓴 말도 잡히도록 통째로 봅니다 ("접수비가얼마" 같은 경우)
    flat = text.replace(" ", "")
    for word, extra in SYNONYMS.items():
        if word in flat:
            base |= set(extra)
    for short, full in (extra_aliases or {}).items():
        if short and full and short in flat:
            base.add(full)
    return base


def load_aliases():
    """직원이 「말 바꾸기」 화면에서 넣은 것을 가져옵니다.

    문서와 같은 방식입니다. 질문마다 새로 읽어야 방금 넣은 것이 바로
    반영됩니다. 표가 없거나 못 읽으면 빈 것을 돌려줍니다. 그러면 코드에
    적힌 SYNONYMS 만으로 지금까지처럼 동작합니다. 챗봇이 멈추지 않습니다.
    """
    if not (SUPABASE_URL and SUPABASE_ANON_KEY):
        return {}
    try:
        url = SUPABASE_URL + "/rest/v1/synonyms?select=short,full&is_active=eq.true"
        req = urllib.request.Request(url, headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
        return {x["short"].strip(): x["full"].strip()
                for x in rows if x.get("short") and x.get("full")}
    except Exception as e:
        print(f"  [말 바꾸기] 표를 못 읽어 코드에 적힌 것만 씁니다: {e}")
        return {}


def load_docs():
    """챗봇이 읽을 문서를 가져옵니다.

    Supabase 의 faq_docs 표에서 읽습니다.
    직원이 웹 화면에서 문서를 고치면 챗봇 답이 바로 바뀝니다. (인수검사 6번)
    질문을 받을 때마다 새로 읽습니다. 고친 것이 바로 반영되어야 하기 때문입니다.

    인터넷이 안 되거나 표를 못 읽으면 파일(faq.json)로 물러섭니다.
    챗봇이 아예 멈추는 것보다는 낫기 때문입니다.
    """
    if SUPABASE_URL and SUPABASE_ANON_KEY:
        try:
            url = (SUPABASE_URL + "/rest/v1/faq_docs"
                   "?select=title,content&is_active=eq.true&order=sort_order")
            req = urllib.request.Request(url, headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": "Bearer " + SUPABASE_ANON_KEY,
            })
            with urllib.request.urlopen(req, timeout=10) as r:
                rows = json.loads(r.read())
            if rows:
                return [{"title": r["title"], "text": r["content"]} for r in rows]
        except Exception as e:
            print(f"  [문서] 표를 못 읽어 파일로 대신합니다: {e}")

    return json.loads(FAQ_PATH.read_text(encoding="utf-8"))


def build_idf(faqs, aliases=None):
    """
    낱말마다 무게를 매깁니다. (IDF - 2026-08-20 추가)

    그 전에는 겹치는 낱말을 그냥 세었습니다. 그러면 "접수"처럼 거의 모든
    문서에 있는 낱말과 "환불"처럼 한두 문서에만 있는 낱말이 똑같이 한 표씩
    됩니다. "환불 언제까지 되나요" 라고 물으시면 ("언제"가 "접수"로 넓혀지는
    탓에) 제목에 "접수"가 든 문서들이 위로 올라오고, 정작 환불 문서는 상위
    세 개 안에도 못 들었습니다.

    여러 문서에 나오는 낱말은 가볍게, 몇 문서에만 나오는 낱말은 무겁게 칩니다.
    흔한 낱말로는 문서를 고를 수 없고, 드문 낱말이 진짜 단서이기 때문입니다.

    api/chat.js 의 buildIdf() 와 같은 식이어야 합니다.
    """
    n = len(faqs)
    df = {}
    for faq in faqs:
        for w in tokens(faq["title"], aliases) | tokens(faq["text"], aliases):
            df[w] = df.get(w, 0) + 1
    # +1 은 한 번도 안 나온 낱말에서 0 으로 나누는 것을 막습니다.
    return lambda w: math.log((n + 1) / (df.get(w, 0) + 1)) + 1


def search(question):
    faqs = [d for d in load_docs() if not is_notice(d)]   # 안내문은 근거에서 제외
    aliases = load_aliases()   # 직원이 「말 바꾸기」 화면에서 넣은 것
    q = tokens(question, aliases)
    idf = build_idf(faqs, aliases)

    ranked = []
    for faq in faqs:
        # 제목에 겹치는 낱말은 두 배로 셉니다.
        # "환불 되나요?" 는 본문에 '환불'이 스쳐 지나가는 문서보다
        # 제목이 '환불 규정'인 문서가 먼저 나와야 합니다.
        title_words = tokens(faq["title"], aliases)
        text_words  = tokens(faq["text"], aliases)
        score = 0.0
        for w in q:
            if w in title_words:
                score += 2 * idf(w)
            if w in text_words:
                score += idf(w)
        ranked.append((score, faq))

    ranked.sort(key=lambda x: (-x[0], x[1]["title"]))
    return [(s, f) for s, f in ranked if s >= MIN_SCORE][:TOP_K]


# =============================================================
# Gemini — 찾은 근거로 문장만 다듬습니다. 판단은 하지 않습니다.
# =============================================================

PROMPT = """당신은 두두자격지원센터의 안내 직원입니다.
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
{context}

[질문]
{question}
"""


# 자격증을 부르는 다른 이름만 따로 모읍니다.
# 동의어는 지금까지 "검색"에만 쓰였습니다. 근거는 제대로 찾아 놓고도
# Gemini 에게는 원래 질문이 그대로 가서, "개사" 같은 짧은 줄임말은
# Gemini 가 못 알아듣고 "모르겠습니다"로 답하는 일이 있었습니다.
# 그래서 어떤 줄임말을 쓰셨는지 한 줄로 알려 드립니다.
#
# 질문 자체는 고치지 않습니다. SYNONYMS 에는 "얼마" → "응시료" 같은 항목도
# 있어서 그대로 바꾸면 "얼마예요"가 "응시료예요"가 되어 문장이 망가집니다.
# api/chat.js 의 CERT_ALIASES · aliasHint() 와 같은 내용이어야 합니다.
CERT_ALIASES = {
    "포크레인": "굴착기운전기능사", "포클레인": "굴착기운전기능사",
    "굴삭기": "굴착기운전기능사", "지게차면허": "지게차운전기능사",
    "요양사": "요양보호사", "요보사": "요양보호사",
    "손평사": "손해평가사", "개사": "공인중개사",
    "공개사": "공인중개사", "중개사": "공인중개사",
    "한조기": "한식조리기능사", "조리사": "한식조리기능사",
}


def alias_hint(question, extra=None):
    """질문에 쓰인 줄임말을 한 줄로 풀어 줍니다. 없으면 빈 글자입니다."""
    flat = question.replace(" ", "")
    allmap = dict(CERT_ALIASES)
    allmap.update(extra or {})          # 직원이 넣은 것이 코드 값을 덮어씁니다
    hits = [f"{w} = {full}" for w, full in allmap.items()
            if w in flat and full not in flat]
    return "\n\n[줄임말 풀이]\n" + "\n".join(hits) if hits else ""


def ask_gemini(question, context, aliases=None):
    """실패하면 None 을 돌려줍니다. 그러면 문서 내용을 그대로 보여 줍니다."""
    if not (USE_GEMINI and GEMINI_API_KEY):
        return None

    body = json.dumps({
        "contents": [{"parts": [{"text": PROMPT.format(
            context=context,
            question=question + alias_hint(question, aliases),
        )}]}],
        # maxOutputTokens 를 넉넉히 둡니다.
        # 요즘 모델은 답하기 전에 "생각"하는 데도 토큰을 써서,
        # 자리가 모자라면 문장이 중간에 잘립니다.
        # (gemini-3.5-flash-lite 는 thinkingConfig 설정을 받지 않습니다)
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }).encode("utf-8")

    for model in GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
            if text:
                return text
        except Exception as e:
            print(f"  [Gemini] {model} 실패: {e}")
            continue
    return None


# =============================================================
# 답하기
# =============================================================

def trim(text, limit=160):
    """너무 길면 문장 끝에서 자릅니다.
       중간에 뚝 끊긴 문장을 보여드리지 않기 위해서입니다."""
    text = text.strip()
    # 줄바꿈이 있는 답(일정 목록 등)은 자르지 않습니다.
    if "\n" in text:
        return text
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind("다."), cut.rfind("요."), cut.rfind("."))
    return (cut[: end + 1] if end > 40 else cut).strip()


def answer(question):
    """돌려주는 값: (답, 까닭, 단계)"""
    question = (question or "").strip()
    if question == "":
        return "궁금하신 것을 적어 주십시오.", "", ""

    docs = load_docs()

    # 1~3) 정해진 답 (안내 문구는 문서에서 읽습니다)
    fixed, why, level = fixed_answer(question, docs)
    if fixed:
        return fixed, why, level

    # 4~5) 검색
    found = search(question)
    if not found:
        return notice(docs, NOTICE_UNKNOWN), "문서에서 근거를 찾지 못함", LEVEL_NONE

    context = "\n\n".join(f"- {f['title']}\n{f['text']}" for _, f in found)
    source = " / ".join(f["title"] for _, f in found)

    # 6) 문장 다듬기
    made = ask_gemini(question, context, load_aliases())
    if made:
        return trim(made), "근거: " + source, LEVEL_FULL

    # Gemini 를 못 쓰면 문서 내용을 그대로 보여 드립니다. 지어내지 않습니다.
    return found[0][1]["text"], "근거: " + source, LEVEL_FULL


# =============================================================
# 채점 5문항 — 인수검사 항목을 그대로 옮긴 것입니다
# =============================================================

TESTS = [
    {"q": "한식조리기능사 필기 응시료가 얼마인가요?",
     "must": ["14,500"], "why": "문서에 적힌 대로 답하는가 (인수검사 2번)"},

    {"q": "접수비가 얼마예요?",
     "must": ["14,500"], "why": "'접수비'로 물어도 '응시료' 답이 나오는가 (인수검사 5번)"},

    {"q": "요양보호사 응시료는 얼마인가요?",
     "must": ["모르겠습니다"], "why": "확인 못 한 것은 모른다고 하는가 (인수검사 4번)"},

    {"q": "실기시험 준비물이 무엇인가요?",
     "must": ["필기 접수만"], "why": "실기를 물으면 필기만 안내하는가 (인수검사 3번)"},

    {"q": "시험장에 주차 되나요?",
     "must": ["모르겠습니다"], "why": "저희 소관이 아닌 것은 모른다고 하는가"},
]


def run_test():
    print("=" * 66)
    print("  채점 5문항")
    print("=" * 66)
    passed = 0
    for i, t in enumerate(TESTS, 1):
        got, why, _ = answer(t["q"])
        ok = all(m in got for m in t["must"])
        passed += ok
        print(f"\n[{i}] {t['why']}")
        print(f"    질문   {t['q']}")
        print(f"    있어야  {t['must']}")
        print(f"    답     {got.replace(chr(10), ' ')[:90]}")
        print(f"    까닭   {why}")
        print(f"    판정   {'PASS ✅' if ok else 'FAIL ❌'}")
    print("\n" + "=" * 66)
    print(f"  {passed} / {len(TESTS)} 통과 " + ("✅" if passed == len(TESTS) else "❌"))
    print("=" * 66)
    return passed == len(TESTS)


# =============================================================
# 화면
# =============================================================

EXAMPLES = [
    "한식조리기능사 응시료가 얼마예요?",
    "접수비 얼마나 해요?",
    "전기기능사는 언제 접수해요?",
    "포크레인 자격증도 되나요?",
    "요양보호사 응시료는요?",
    "시험 볼 때 뭘 가져가나요?",
]


def for_screen(text):
    """화면은 글을 마크다운으로 읽습니다.
       ~ 는 취소선 기호로 알아들어 글자를 먹어버립니다.
       날짜의 물결표(8월 24일~8월 27일)가 사라지지 않게 바꿔 줍니다."""
    return text.replace("~", " – ").replace("  – ", " – ")


def chat(message, history):
    got, why, _ = answer(message)
    got = for_screen(got)
    if why and why.startswith("근거: "):
        why = "근거: " + why[4:].split(" / ")[0]   # 가장 잘 맞는 문서 하나만
    return got + (f"\n\n_{why}_" if why else "")


def build_ui():
    import gradio as gr

    with gr.Blocks(title="두두자격지원센터 문의", theme=gr.themes.Soft()) as demo:
        gr.Markdown(
            "# 무엇이든 물어보십시오\n"
            "응시료, 접수 기간, 준비물 같은 것을 물어보시면 문서에 있는 대로 답해 드립니다.\n\n"
            "**저희는 필기 접수만 도와드립니다.** 확인하지 못한 것은 모른다고 답합니다."
        )
        gr.ChatInterface(fn=chat, examples=EXAMPLES, type="messages")
    return demo


if __name__ == "__main__":
    if "--test" in sys.argv:
        sys.exit(0 if run_test() else 1)
    build_ui().launch()
