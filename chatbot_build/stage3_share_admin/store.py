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
TABLE_SYN = "synonyms"
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
    _call("DELETE", TABLE_FAQ, params={"id": f"eq.{faq_id}"})


# ── 동의어 ────────────────────────────────────────────
def load_synonyms():
    """{"포크레인": "굴착기"} 모양으로 돌려준다. 파일에서 읽던 것과 같은 모양이다."""
    rows = _call("GET", TABLE_SYN, params={"select": "*", "order": "short"})
    return {r["short"]: r["full"] for r in rows}


def upsert_synonym(short, full):
    _call("POST", TABLE_SYN, params={"on_conflict": "short"}, body={"short": short, "full": full})


def delete_synonym_row(short):
    _call("DELETE", TABLE_SYN, params={"short": f"eq.{short}"})
