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

import json, os, re, sys, urllib.request, urllib.error
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
#   900번 안내문 · 모를 때 / 910번 안내문 · 실기 질문
# 문서를 못 읽으면 아래 기본 문구를 씁니다.

DEFAULT_PRACTICAL = "저희는 필기 접수만 도와드립니다. 실기는 저희가 안내하지 않습니다."

DEFAULT_UNKNOWN = (
    "모르겠습니다. 저희가 확인하지 못한 내용이라 알려드릴 수 없습니다.\n"
    "짐작해서 말씀드리면 잘못 안내될 수 있어 답을 드리지 않습니다."
)

NOTICE_UNKNOWN   = "안내문 · 모를 때"
NOTICE_PRACTICAL = "안내문 · 실기 질문"


def notice(docs, title, fallback):
    for d in docs:
        if d["title"] == title and d["text"].strip():
            return d["text"].strip()
    return fallback


def is_notice(d):
    return d["title"] in (NOTICE_UNKNOWN, NOTICE_PRACTICAL)

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
CANNOT_ANSWER = [
    ["주차"],
    ["붙", "합격", "될까", "가능"],   # "제가 붙을 수 있을까요"
    ["다른 자격증", "같이 딸", "동시에"],
]


def has_any(text, words):
    return any(w in text for w in words)


def fixed_answer(question, docs):
    """검색하기 전에 정해진 답이 있는지 봅니다. 문구는 문서에서 읽습니다."""
    q = question.replace(" ", "")
    unknown   = notice(docs, NOTICE_UNKNOWN, DEFAULT_UNKNOWN)
    practical = notice(docs, NOTICE_PRACTICAL, DEFAULT_PRACTICAL)

    # 1) 실기
    if has_any(q, PRACTICAL_WORDS):
        return practical, "실기 질문"

    # 2) 확인 못 한 8가지
    for subjects, topics, label in UNKNOWN_RULES:
        if has_any(q, subjects) and has_any(q, topics):
            return unknown, "확인 못 한 항목: " + label

    # 3) 답할 수 없는 질문
    for group in CANNOT_ANSWER:
        if has_any(q, group):
            return unknown, "저희 소관이 아닌 질문"

    return None, None


# =============================================================
# 검색 — 질문과 문서에 같이 나오는 단어를 셉니다
# =============================================================

def tokens(text):
    """글에서 단어를 뽑습니다.
       조사를 떼고, 비슷한말은 문서에 적힌 말로 바꿔 함께 넣습니다."""
    words = re.findall(r"[가-힣A-Za-z0-9]+", text.lower())

    base = set(words)
    for w in words:              # "접수비가" → "접수비" 도 함께 넣습니다
        base.add(stem(w))

    # 붙여 쓴 말도 잡히도록 통째로 봅니다 ("접수비가얼마" 같은 경우)
    flat = text.replace(" ", "")
    for word, extra in SYNONYMS.items():
        if word in flat:
            base |= set(extra)
    return base


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


def search(question):
    faqs = [d for d in load_docs() if not is_notice(d)]   # 안내문은 근거에서 제외
    q = tokens(question)

    ranked = []
    for faq in faqs:
        # 제목에 겹치는 낱말은 두 배로 셉니다.
        # "환불 되나요?" 는 본문에 '환불'이 스쳐 지나가는 문서보다
        # 제목이 '환불 규정'인 문서가 먼저 나와야 합니다.
        in_title = len(q & tokens(faq["title"]))
        in_text  = len(q & tokens(faq["text"]))
        ranked.append((in_title * 2 + in_text, faq))

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


def ask_gemini(question, context):
    """실패하면 None 을 돌려줍니다. 그러면 문서 내용을 그대로 보여 줍니다."""
    if not (USE_GEMINI and GEMINI_API_KEY):
        return None

    body = json.dumps({
        "contents": [{"parts": [{"text": PROMPT.format(context=context, question=question)}]}],
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
    question = (question or "").strip()
    if question == "":
        return "궁금하신 것을 적어 주십시오.", ""

    docs = load_docs()

    # 1~3) 정해진 답 (거절 문구는 문서에서 읽습니다)
    fixed, why = fixed_answer(question, docs)
    if fixed:
        return fixed, why

    # 4~5) 검색
    found = search(question)
    if not found:
        return notice(docs, NOTICE_UNKNOWN, DEFAULT_UNKNOWN), "문서에서 근거를 찾지 못함"

    context = "\n\n".join(f"- {f['title']}\n{f['text']}" for _, f in found)
    source = " / ".join(f["title"] for _, f in found)

    # 6) 문장 다듬기
    made = ask_gemini(question, context)
    if made:
        return trim(made), "근거: " + source

    # Gemini 를 못 쓰면 문서 내용을 그대로 보여 드립니다. 지어내지 않습니다.
    return found[0][1]["text"], "근거: " + source


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
        got, why = answer(t["q"])
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
    got, why = answer(message)
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
