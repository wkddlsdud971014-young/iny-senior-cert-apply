"""
[seed.py] 지금 있는 FAQ와 동의어를 Supabase 로 한 번 옮긴다
==========================================================
faq.json 100건과 synonyms.json 을 읽어서 테이블에 넣는다.
처음 한 번만 실행하면 된다.

실행:  python seed.py
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# .env 를 직접 읽는다 (추가 패키지 없이)
env = ROOT / ".env"
if env.is_file():
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

import store  # noqa: E402

if not store.is_configured():
    raise SystemExit(".env 에 SUPABASE_URL 과 SUPABASE_KEY 를 넣어주세요.")

faq = json.loads((ROOT / "faq.json").read_text(encoding="utf-8"))
ok = 0
for r in faq:
    try:
        store.insert_faq({
            "id": r["id"], "cert": r["cert"], "title": r["title"],
            "text": r["text"], "keywords": r.get("keywords", []),
        })
        ok += 1
    except Exception as e:
        print(f"  건너뜀 {r.get('id')}: {type(e).__name__}")
print(f"FAQ {ok}/{len(faq)} 건 올림")

syn_path = ROOT / "synonyms.json"
if syn_path.is_file():
    syn = json.loads(syn_path.read_text(encoding="utf-8"))
    n = 0
    for short, full in syn.items():
        try:
            store.upsert_synonym(short, full); n += 1
        except Exception as e:
            print(f"  건너뜀 {short}: {type(e).__name__}")
    print(f"동의어 {n}/{len(syn)} 개 올림")

print("\n확인: Supabase 대시보드 > Table Editor 에서 faq 테이블에 행이 보이면 성공입니다.")
