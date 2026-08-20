"""
[rag.py] FAQ 검색 + TF-IDF + FAQ CRUD - 완성형
================================================
Stage 5의 TF-IDF 검색 + Stage 3의 FAQ CRUD를 합친 최종 버전.
FAQ를 추가/삭제하면 TF-IDF 인덱스가 자동 재구축된다.

수정 포인트:
  [R1] min_score를 조정해서 검색 결과 변화를 관찰하세요 (TF-IDF는 0~1 범위)
  [R2] top_k를 늘려서 Gemini에게 여러 근거를 주어보세요
"""
from __future__ import annotations
import json
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT.parent / "data" / "faq_combined.jsonl"
SYNONYMS_PATH = ROOT / "synonyms.json"
UNKNOWN = "제공된 FAQ에서 확인할 수 없는 내용입니다."


# ─────────────────────────────────────────────────────────────
# 동의어 사전 (Stage 3에서 가져와 합침)
#
# TF-IDF 는 데이터에 있는 말만 안다. "포크레인" 은 상담 기록에 실제로
# 나오는 말이라 TF-IDF 가 알아서 찾지만, "요보사" 처럼 데이터에 한 번도
# 안 나오는 줄임말은 사전에 없는 단어라 통째로 버려진다.
# 검색 방식을 바꿔서 풀 수 있는 문제가 아니라, 말을 미리 바꿔줘야 한다.
# ─────────────────────────────────────────────────────────────
def _load_synonyms():
    if not SYNONYMS_PATH.is_file():
        return {}
    return json.loads(SYNONYMS_PATH.read_text(encoding="utf-8"))


SYNONYMS = _load_synonyms()


def _save_synonyms():
    SYNONYMS_PATH.write_text(
        json.dumps(SYNONYMS, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def reload_synonyms():
    global SYNONYMS
    SYNONYMS = _load_synonyms()


def get_synonyms_table():
    return [[short, full] for short, full in sorted(SYNONYMS.items())]


def add_synonym(short, full):
    short, full = (short or "").strip(), (full or "").strip()
    if not short or not full:
        return "줄임말과 정식 명칭을 모두 입력하세요.", get_synonyms_table()
    SYNONYMS[short] = full
    _save_synonyms()
    return f"추가됨: {short} → {full}", get_synonyms_table()


def delete_synonym(short):
    short = (short or "").strip()
    if short not in SYNONYMS:
        return f"'{short}' 은(는) 없습니다.", get_synonyms_table()
    full = SYNONYMS.pop(short)
    _save_synonyms()
    return f"삭제됨: {short} → {full}", get_synonyms_table()


def _expand_synonyms(text):
    """질문 속 줄임말을 정식 명칭으로 바꾼다. 검색 직전에 한 번 부른다."""
    for short, full in SYNONYMS.items():
        if short in text:
            text = text.replace(short, full)
    return text


def _load_jsonl(path):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


FAQ = _load_jsonl(DATA_PATH)


# 자격증명과 분류를 검색용 글자에 몇 번 넣을지. (2026-08-20 추가)
#
# exchanges 를 읽게 하면서 문서가 길어졌다. 그러자 자격증명 한 낱말이
# 대화 수십 낱말 속에 묻혀 힘을 잃었다. "공인중개사 환불 규정"을 물었는데
# 손해평가사 환불 문서가 1등으로 올라오는 식이다.
# (내용은 자격증 공통이라 답은 맞았지만 출처가 엉뚱해진다)
#
# 자격증명을 여러 번 적어 두면 그 낱말의 비중이 올라간다.
# 8개 자격증 × 3개 주제 = 24문항으로 재어 정한 값이다.
#   1번 17/24(70%)  2번 18/24  3번 18/24  4번 20/24  5번 24/24(100%)  7번 24/24
# 5번에서 전부 맞고 그 이상은 더 나아지지 않아 5로 정했다.
CERT_WEIGHT = 5


def _question_of(r):
    """
    묻는 쪽 글을 꺼낸다. 출처에 따라 칸 이름이 다르다. (2026-08-20 추가)

    게시판(qna_board) : title / body 에 들어 있다
    전화(phone)      : opening 과 exchanges[].caller 에 들어 있다
    """
    if r.get("body") or r.get("title"):
        return f"{r.get('title', '')} {r.get('body', '')}".strip()
    parts = [r.get("opening", "")]
    parts += [x.get("caller", "") for x in r.get("exchanges", [])]
    return " ".join(p for p in parts if p).strip()


def _answer_of(r):
    """
    답한 쪽 글을 꺼낸다. Gemini 에게 넘길 근거가 이것이다.

    게시판 : reply
    전화   : exchanges[].staff 를 이어 붙인다
    """
    if r.get("reply"):
        return r["reply"]
    said = [x.get("staff", "") for x in r.get("exchanges", [])]
    return " ".join(s for s in said if s).strip()


def _label_of(r):
    """
    출처에 보여 줄 이름. (2026-08-20 추가)

    전화 상담 기록에는 제목이 없어 그대로 두면 출처가 "손해평가사 - ?" 로 나온다.
    제목이 없으면 분류와 첫 질문을 대신 보여 준다.
    """
    if r.get("title"):
        return r["title"]
    first = ""
    for x in r.get("exchanges", []):
        if x.get("caller"):
            first = x["caller"]
            break
    cat = r.get("category", "")
    if cat and first:
        return f"{cat} · 전화 상담 \"{first[:24]}\""
    return cat or "전화 상담"


def _build_docs(faq_list):
    """
    검색용 글자를 만든다.

    2026-08-20 수정: 전에는 title/body/reply 만 이어 붙였다.
    그런데 4,705건 중 3,502건(74%)이 전화 상담 기록이고, 그쪽에는 그 칸들이 없다.
    내용이 exchanges 안에 들어 있기 때문이다.
    그래서 실제로 만들어지던 글자가 이랬다.

        '공인중개사 HC 환불   '        ← 자격증명과 카테고리뿐

    내용이 통째로 빠지니 두 가지 일이 벌어졌다.
      1) 답이 데이터에 있는데도 검색에 안 걸린다
      2) 문서가 짧아져 코사인 유사도가 오히려 높게 나온다
         ("공인중개사 환불 규정" 질문에 유사도 0.77 인데 근거가 비어 UNKNOWN 이 나왔다)

    내용이 없어서 유사도가 높아지고, 내용이 없어서 답을 못 하는 상태였다.
    이제 출처와 상관없이 묻는 글과 답한 글을 모두 넣는다.
    """
    return [
        f"{(str(r.get('cert', '')) + ' ') * CERT_WEIGHT}"
        f"{(str(r.get('category', '')) + ' ') * CERT_WEIGHT}"
        f"{_question_of(r)} {_answer_of(r)}"
        for r in faq_list
    ]


vectorizer = TfidfVectorizer()
tfidf_matrix = vectorizer.fit_transform(_build_docs(FAQ))


def rebuild_index():
    """FAQ 변경 후 TF-IDF 인덱스를 재구축한다."""
    global vectorizer, tfidf_matrix
    vectorizer = TfidfVectorizer()
    tfidf_matrix = vectorizer.fit_transform(_build_docs(FAQ))


def get_faq_count():
    return len(FAQ)


def get_faq_table(query=""):
    """FAQ 목록을 테이블 형태로 반환한다 (최근 50건)."""
    filtered = FAQ
    if query:
        q = query.lower()
        filtered = [r for r in FAQ if
                     q in r.get("cert", "").lower() or
                     q in r.get("category", "").lower() or
                     q in r.get("title", "").lower()]
    rows = [[r.get("id", "?"), r.get("cert", ""), r.get("category", ""), r.get("title", "")] for r in filtered[-50:]]
    return rows


def add_faq_entry(cert, category, title, reply):
    """FAQ 항목을 추가한다."""
    max_id = max((r.get("id", 0) for r in FAQ), default=0)
    if isinstance(max_id, str):
        max_id = len(FAQ)
    entry = {
        "id": max_id + 1,
        "channel": "admin",
        "caller_type": "admin",
        "cert": cert,
        "category": category,
        "title": title,
        "body": title,
        "reply": reply,
        "resolution": "admin_added",
    }
    FAQ.append(entry)


def delete_faq_entry(faq_id):
    """FAQ 항목을 삭제한다."""
    global FAQ
    FAQ = [r for r in FAQ if r.get("id") != faq_id]


def retrieve(question, top_k=3, min_score=0.05):
    # 줄임말을 먼저 정식 명칭으로 바꾼 뒤 TF-IDF 로 넘긴다.
    question = _expand_synonyms(question)
    q_vec = vectorizer.transform([question])
    scores = cosine_similarity(q_vec, tfidf_matrix).flatten()
    top_indices = scores.argsort()[::-1][:top_k]
    return [(float(scores[i]), FAQ[i]) for i in top_indices if scores[i] >= min_score]


def build_prompt(question, document):
    # 근거가 어느 자격증 것인지 반드시 밝힌다. (2026-08-20 추가)
    #
    # 전화 상담 기록에는 자격증명이 본문에 안 나온다. 통화하는 두 사람은
    # 무슨 자격증인지 이미 알고 있어 굳이 말하지 않기 때문이다.
    #   "1차 응시료는 20,000원이에요. 2차는 별도로 33,000원을 내셔야 해요."
    #
    # 이 문장만 넘기면 Gemini 는 그것이 어느 자격증 요금인지 알 수 없다.
    # 실제로 "미용사 시험비"(우리가 다루지 않는 자격증)를 물었을 때
    # 손해평가사 요금을 미용사 요금이라고 안내했다.
    #
    # 그래서 근거 앞에 자격증명을 붙이고, 질문과 다르면 답하지 말라고 못 박는다.
    cert = document.get("cert", "") or "확인되지 않음"
    return f"""당신은 자격증 시험 접수 FAQ 상담원입니다.
아래 근거 안에서만 답하세요. 근거에 없는 내용을 만들지 마세요.
근거로 답할 수 없으면 정확히 UNKNOWN이라고 답하세요.

이 근거는 '{cert}' 에 대한 것입니다.
질문이 다른 자격증에 대한 것이면 정확히 UNKNOWN이라고 답하세요.
근거에 적힌 금액·날짜를 다른 자격증의 것으로 옮겨 말하지 마세요.

[질문]
{question}

[근거]
{_answer_of(document) or document.get('text', '')}

한국어 두 문장 이내로 답하세요."""


def answer_question(question, generate):
    results = retrieve(question)
    if not results:
        return {"status": "UNKNOWN", "answer": UNKNOWN, "source": "없음", "score": 0}

    best_score, best_doc = results[0]
    generated = generate(build_prompt(question, best_doc)).strip()

    if not generated or generated.upper() == "UNKNOWN":
        return {"status": "UNKNOWN", "answer": UNKNOWN, "source": "없음", "score": best_score}

    return {
        "status": "ANSWERED",
        "answer": generated,
        "source": f"{best_doc.get('cert', '?')} - {_label_of(best_doc)}",
        "score": best_score,
    }
