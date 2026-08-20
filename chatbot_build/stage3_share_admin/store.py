"""
[store.py] 데이터를 어디에 둘지 정하는 파일
============================================
지금까지 FAQ와 동의어는 내 컴퓨터 안의 파일(faq.json, synonyms.json)에 있었다.
그래서 노트북을 끄면 링크가 죽고, 다른 사람이 추가한 FAQ도 보이지 않았다.

이 파일은 같은 데이터를 Supabase에서 읽고 쓴다.
바뀌는 것은 "어디에 저장하느냐" 하나다.
검색 방식, 점수 계산, 챗봇 화면은 그대로 둔다.

설치할 패키지가 없다. urllib은 파이썬에 원래 들어 있다.
Supabase는 PostgREST라는 방식을 쓰는데, 테이블 하나가 주소 하나가 된다.
  faq 테이블      -> https://내프로젝트.supabase.co/rest/v1/faq
  synonyms 테이블 -> https://내프로젝트.supabase.co/rest/v1/synonyms

수정 포인트:
  [D1] TABLE_FAQ, TABLE_SYN 이름을 본인 테이블 이름에 맞게 바꾸세요
  [D2] TIMEOUT을 늘리면 느린 네트워크에서도 기다립니다
"""
from __future__ import annotations
import json
import os
import urllib.parse
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# [D1] 테이블 이름
TABLE_FAQ = "faq"
# 2026-08-20 변경: "synonyms" -> "synonyms_practice"
#
# 실습(이 폴더)과 배포된 접수 사이트가 같은 `synonyms` 표를 쓰고 있었다.
# FAQ 는 faq(실습) / faq_docs(운영)로 나뉘어 있어 괜찮다고 생각했는데,
# 동의어만 양쪽이 같은 표였다. 그래서 실습에서 넣은 "전기사"가 배포된
# 사이트의 답변에도 그대로 반영됐다.
#
# 연습하는 곳과 손님이 쓰는 곳은 나뉘어 있어야 한다. 실습용 표를 따로 만들었다.
TABLE_SYN = "synonyms_practice"
# [D2] 응답을 기다리는 시간(초)
TIMEOUT = 10


def is_configured():
    """.env에 주소와 키가 들어 있는지 본다."""
    return bool(SUPABASE_URL and SUPABASE_KEY)


def _call(method, table, params=None, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", SUPABASE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        text = res.read().decode("utf-8")
        return json.loads(text) if text.strip() else []


def _check_deleted(rows, table, key):
    """
    지워진 게 없으면 알려 준다. (2026-08-20 추가)

    Supabase 는 지울 권한이 없을 때 **에러를 내지 않는다.**
    HTTP 200 에 "0건 처리했다"는 뜻으로 빈 목록을 돌려준다.
    그래서 응답만 보면 성공과 구분이 되지 않는다.

    실제로 겪은 일이다. 동의어 삭제가 막혀 있는데도 화면에는
    "삭제 완료: 전기사" 가 떴고, 목록에는 그대로 남아 있었다.
    지워진 줄 알고 넘어가면 나중에야 이상을 느낀다.

    `Prefer: return=representation` 을 보내므로 지워진 행이 응답으로 돌아온다.
    비어 있으면 지워지지 않은 것이다.
    """
    if rows:
        return
    raise RuntimeError(
        f"'{key}' 을(를) 지우지 못했습니다. "
        f"({table} 표에 그 항목이 없거나, 지울 권한이 없습니다)"
    )


# ── FAQ ──────────────────────────────────────────────
def load_faq():
    """FAQ 전체를 불러온다. 파일 대신 인터넷에서 읽는 것 하나만 다르다."""
    rows = _call("GET", TABLE_FAQ, params={"select": "*", "order": "id"})
    for r in rows:
        if isinstance(r.get("keywords"), str):
            r["keywords"] = [k.strip() for k in r["keywords"].split(",") if k.strip()]
        r.setdefault("keywords", [])
    return rows


def insert_faq(entry):
    _call("POST", TABLE_FAQ, body=entry)


def delete_faq(faq_id):
    rows = _call("DELETE", TABLE_FAQ, params={"id": f"eq.{faq_id}"})
    _check_deleted(rows, TABLE_FAQ, faq_id)


# ── 동의어 ────────────────────────────────────────────
def load_synonyms():
    """{"포크레인": "굴착기"} 모양으로 돌려준다. 파일에서 읽던 것과 같은 모양이다."""
    rows = _call("GET", TABLE_SYN, params={"select": "*", "order": "short"})
    return {r["short"]: r["full"] for r in rows}


def upsert_synonym(short, full):
    _call("POST", TABLE_SYN, params={"on_conflict": "short"}, body={"short": short, "full": full})


def delete_synonym_row(short):
    rows = _call("DELETE", TABLE_SYN, params={"short": f"eq.{short}"})
    _check_deleted(rows, TABLE_SYN, short)
