# -*- coding: utf-8 -*-
"""
DB 통합 — 세 CSV를 하나로 합칩니다.

사용법:
    python3 merge.py draft_100     (100건으로 시험)
    python3 merge.py real_1000     (1,000건 본 데이터)

원칙 (01_칸_매핑표.md)
    1. 원본 CSV 3개는 읽기만 합니다. 절대 고치지 않습니다.
    2. 표기를 바꾼 칸은 표준값과 원본값을 둘 다 남깁니다.
    3. 판정이 안 되면 비워둡니다. 짐작해서 채우지 않습니다.
    4. 없는 칸은 빈 칸으로 둡니다. 0이나 "없음"으로 채우지 않습니다.
"""

import csv, io, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")

# 판정하지 못한 것을 모아 둡니다. 나중에 리포트로 보여줍니다.
NOT_JUDGED = []


def note(source, receipt, field, raw):
    """판정 못 한 값을 기록합니다."""
    NOT_JUDGED.append({"출처": source, "접수번호": receipt, "칸": field, "원본값": raw})


# ---------------------------------------------------------------
# 표준화 함수들
# ---------------------------------------------------------------

GENDER = {"남": "남", "여": "여", "M": "남", "F": "여", "1": "남", "2": "여"}

PAY_METHOD = {
    "신용카드": "신용카드", "CARD": "신용카드", "card": "신용카드",
    "계좌이체": "계좌이체", "BANK_TRANSFER": "계좌이체", "transfer": "계좌이체",
    "가상계좌": "가상계좌", "VIRTUAL_ACCOUNT": "가상계좌", "virtual": "가상계좌",
}

PAY_STATUS = {
    "완료": "완료", "PAID": "완료", "success": "완료",
    "대기": "대기", "PENDING": "대기", "pending": "대기",
    "환불": "환불", "REFUNDED": "환불", "refunded": "환불",
}

APP_STATUS = {
    "접수완료": "접수완료", "CONFIRMED": "접수완료", "active": "접수완료",
    "결제대기": "결제대기", "PENDING": "결제대기", "pending": "결제대기",
    "취소": "취소", "CANCELLED": "취소", "cancelled": "취소",
}

DISCOUNT = {
    "없음": "없음", "NONE": "없음",
    "장애인": "장애인", "DISABLED": "장애인",
    "기초생활수급자": "기초생활수급자", "BASIC_LIVING": "기초생활수급자", "기초수급": "기초생활수급자",
    "국가유공자": "국가유공자",
    "차상위계층": "차상위계층",
}


def std(table, raw, source, receipt, field):
    """사전에 있으면 표준값, 없으면 빈 칸 + 기록"""
    raw = (raw or "").strip()
    if raw == "":
        return ""
    if raw in table:
        return table[raw]
    note(source, receipt, field, raw)
    return ""


def std_phone(raw, source, receipt):
    """연락처: 숫자만 뽑아 010-0000-0000 모양으로. 자릿수가 안 맞으면 빈 칸."""
    d = re.sub(r"[^0-9]", "", raw or "")
    if len(d) == 11:
        return f"{d[:3]}-{d[3:7]}-{d[7:]}"
    if len(d) == 10:
        return f"{d[:3]}-{d[3:6]}-{d[6:]}"
    if raw.strip():
        note(source, receipt, "연락처", raw)
    return ""


# 출처별 날짜 형식 (01_칸_매핑표.md B-3)
#   두두보건은 일-월-년 순입니다. 10-08-2026 = 8월 10일
DATE_ORDER = {
    "국가기술": "ymd",   # 1954-07-13
    "전문":     "ymd",   # 1966/10/05
    "두두보건": "dmy",   # 28-07-1948
}


def std_date(raw, source, receipt, field):
    """날짜 → YYYY-MM-DD"""
    raw = (raw or "").strip()
    if raw == "":
        return ""
    nums = re.findall(r"\d+", raw.split(" ")[0])
    if len(nums) != 3:
        note(source, receipt, field, raw)
        return ""
    if DATE_ORDER[source] == "ymd":
        y, m, d = nums
    else:
        d, m, y = nums
    try:
        y, m, d = int(y), int(m), int(d)
        if not (1 <= m <= 12 and 1 <= d <= 31):
            raise ValueError
    except ValueError:
        note(source, receipt, field, raw)
        return ""
    return f"{y:04d}-{m:02d}-{d:02d}"


def std_datetime(raw, source, receipt, field):
    """날짜+시각 → YYYY-MM-DD HH:MM"""
    raw = (raw or "").strip()
    if raw == "":
        return ""
    day = std_date(raw, source, receipt, field)
    if day == "":
        return ""
    t = re.search(r"(\d{1,2}):(\d{2})", raw)
    if not t:
        return day
    return f"{day} {int(t.group(1)):02d}:{t.group(2)}"


# ---------------------------------------------------------------
# 통합표의 칸 순서
# ---------------------------------------------------------------

COLUMNS = [
    "출처", "접수번호", "성명",
    "생년월일", "생년월일_원본",
    "성별", "성별_원본",
    "연락처", "연락처_원본",
    "최종학력", "자격증",
    "시험지역", "시험장",
    "시험일자", "시험일자_원본",
    "교시_원본",
    "수수료", "감면유형", "감면유형_원본", "감면금액", "최종결제금액",
    "결제수단", "결제수단_원본",
    "결제상태", "결제상태_원본",
    "접수상태", "접수상태_원본",
    "접수일시", "접수일시_원본",
    "사용맥락",
    # 국가기술만
    "등급", "시험유형", "회차", "시험구분", "응시자격유형",
    # 전문만
    "시험연도", "차수", "1차합격여부", "시험과목",
    # 두두보건만
    "교육기관", "교육수료번호", "교육수료일", "교육수료일_원본", "교육이수시간", "사진검증",
    # 판정 결과
    "확인필요",
]


def blank_row():
    return {c: "" for c in COLUMNS}


# ---------------------------------------------------------------
# DB별 변환
# ---------------------------------------------------------------

def from_national(r):
    """두두넷 국가기술자격"""
    s, no = "국가기술", r["접수번호"]
    o = blank_row()
    o.update({
        "출처": s, "접수번호": no, "성명": r["성명"],
        "생년월일": std_date(r["생년월일"], s, no, "생년월일"), "생년월일_원본": r["생년월일"],
        "성별": std(GENDER, r["성별"], s, no, "성별"), "성별_원본": r["성별"],
        "연락처": std_phone(r["연락처"], s, no), "연락처_원본": r["연락처"],
        "최종학력": r["최종학력"], "자격증": r["자격종목"],
        "시험지역": r["시험지역"], "시험장": r["시험장"],
        "시험일자": std_date(r["시험일자"], s, no, "시험일자"), "시험일자_원본": r["시험일자"],
        "교시_원본": r["교시"],
        "수수료": r["수수료"],
        "감면유형": std(DISCOUNT, r["감면유형"], s, no, "감면유형"), "감면유형_원본": r["감면유형"],
        "감면금액": r["감면금액"], "최종결제금액": r["최종결제금액"],
        "결제수단": std(PAY_METHOD, r["결제수단"], s, no, "결제수단"), "결제수단_원본": r["결제수단"],
        "결제상태": std(PAY_STATUS, r["결제상태"], s, no, "결제상태"), "결제상태_원본": r["결제상태"],
        "접수상태": std(APP_STATUS, r["접수상태"], s, no, "접수상태"), "접수상태_원본": r["접수상태"],
        "접수일시": std_datetime(r["접수일시"], s, no, "접수일시"), "접수일시_원본": r["접수일시"],
        "사용맥락": r["사용맥락"],
        "등급": r["등급"], "시험유형": r["시험유형"], "회차": r["회차"],
        "시험구분": r["시험구분"], "응시자격유형": r["응시자격유형"],
    })
    return o


def from_professional(r):
    """두두넷 전문자격"""
    s, no = "전문", r["receipt_no"]
    o = blank_row()
    o.update({
        "출처": s, "접수번호": no, "성명": r["applicant_name"],
        "생년월일": std_date(r["date_of_birth"], s, no, "생년월일"), "생년월일_원본": r["date_of_birth"],
        "성별": std(GENDER, r["sex"], s, no, "성별"), "성별_원본": r["sex"],
        "연락처": std_phone(r["contact_number"], s, no), "연락처_원본": r["contact_number"],
        "최종학력": r["education"], "자격증": r["qualification"],
        "시험지역": r["exam_region"], "시험장": r["exam_center"],
        "시험일자": std_date(r["test_date"], s, no, "시험일자"), "시험일자_원본": r["test_date"],
        "교시_원본": r["session_no"],
        "수수료": r["amount"],
        "감면유형": std(DISCOUNT, r["discount"], s, no, "감면유형"), "감면유형_원본": r["discount"],
        "최종결제금액": r["final_amount"],
        "결제수단": std(PAY_METHOD, r["pay_type"], s, no, "결제수단"), "결제수단_원본": r["pay_type"],
        "결제상태": std(PAY_STATUS, r["pay_status"], s, no, "결제상태"), "결제상태_원본": r["pay_status"],
        "접수상태": std(APP_STATUS, r["app_status"], s, no, "접수상태"), "접수상태_원본": r["app_status"],
        "접수일시": std_datetime(r["registered_at"], s, no, "접수일시"), "접수일시_원본": r["registered_at"],
        "사용맥락": r["usage_context"],
        "시험연도": r["exam_year"], "차수": r["exam_stage"],
        "1차합격여부": r["is_first_pass"], "시험과목": r["subjects"],
    })
    return o


def from_health(r):
    """두두보건 — 시험지역 칸이 없습니다. 비워 둡니다 (매핑표 C절)"""
    s, no = "두두보건", r["examNumber"]
    o = blank_row()
    o.update({
        "출처": s, "접수번호": no, "성명": r["fullName"],
        "생년월일": std_date(r["birthday"], s, no, "생년월일"), "생년월일_원본": r["birthday"],
        "성별": std(GENDER, r["genderCode"], s, no, "성별"), "성별_원본": r["genderCode"],
        "연락처": std_phone(r["mobile"], s, no), "연락처_원본": r["mobile"],
        "최종학력": r["educationLevel"], "자격증": r["certType"],
        "시험지역": "",                       # 칸 자체가 없음. 짐작하지 않음
        "시험장": r["centerName"],
        "시험일자": std_date(r["examDate"], s, no, "시험일자"), "시험일자_원본": r["examDate"],
        "교시_원본": r["timeSlot"],
        "수수료": r["feeAmount"],
        "감면유형": std(DISCOUNT, r["discountType"], s, no, "감면유형"), "감면유형_원본": r["discountType"],
        "최종결제금액": r["finalFee"],
        "결제수단": std(PAY_METHOD, r["payment"], s, no, "결제수단"), "결제수단_원본": r["payment"],
        "결제상태": std(PAY_STATUS, r["payResult"], s, no, "결제상태"), "결제상태_원본": r["payResult"],
        "접수상태": std(APP_STATUS, r["regStatus"], s, no, "접수상태"), "접수상태_원본": r["regStatus"],
        "접수일시": std_datetime(r["appliedAt"], s, no, "접수일시"), "접수일시_원본": r["appliedAt"],
        "사용맥락": r["usageContext"],
        "교육기관": r["trainingOrg"], "교육수료번호": r["trainingCertNo"],
        "교육수료일": std_date(r["trainingCompleteDate"], s, no, "교육수료일"),
        "교육수료일_원본": r["trainingCompleteDate"],
        "교육이수시간": r["trainingHours"], "사진검증": r["photoVerified"],
    })
    return o


# ---------------------------------------------------------------
# 실행
# ---------------------------------------------------------------

def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "draft_100"
    n = "100" if folder == "draft_100" else "1000"

    sources = [
        ("국가기술", f"두두넷_국가기술자격_접수_{n}.csv", from_national),
        ("전문",     f"두두넷_전문자격_접수_{n}.csv",     from_professional),
        ("두두보건", f"두두보건_접수_{n}.csv",           from_health),
    ]

    merged, counts = [], {}
    for label, fname, fn in sources:
        path = os.path.join(DATA, folder, fname)
        rows = list(csv.DictReader(io.open(path, encoding="utf-8-sig")))
        counts[label] = len(rows)
        for r in rows:
            merged.append(fn(r))

    # 표준 칸이 비었는데 원본에는 값이 있는 행 = 사람이 봐야 하는 행
    pairs = [("생년월일", "생년월일_원본"), ("성별", "성별_원본"), ("연락처", "연락처_원본"),
             ("시험일자", "시험일자_원본"), ("감면유형", "감면유형_원본"),
             ("결제수단", "결제수단_원본"), ("결제상태", "결제상태_원본"),
             ("접수상태", "접수상태_원본"), ("접수일시", "접수일시_원본")]
    for row in merged:
        bad = [s for s, o in pairs if row[s] == "" and row[o].strip() != ""]
        row["확인필요"] = ",".join(bad)

    out = os.path.join(HERE, f"통합_접수_{n}.csv")
    with io.open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(merged)

    # ----- 리포트 -----
    print("=" * 62)
    print(f"  DB 통합 결과  ({folder})")
    print("=" * 62)
    print(f"\n[합친 행 수]")
    for k, v in counts.items():
        print(f"  {k:8} {v:>5}행")
    print(f"  {'합계':8} {len(merged):>5}행")

    print(f"\n[칸 수] {len(COLUMNS)}칸")

    need = [r for r in merged if r["확인필요"]]
    print(f"\n[사람이 확인해야 하는 행] {len(need)}행", "✅ 없음" if not need else "⚠️")
    if need:
        for r in need[:10]:
            print(f"  {r['출처']:6} {r['접수번호']:14} → {r['확인필요']}")

    print(f"\n[판정 못 한 값] {len(NOT_JUDGED)}건", "✅ 없음" if not NOT_JUDGED else "⚠️")
    if NOT_JUDGED:
        for k, v in Counter((x["칸"], x["원본값"]) for x in NOT_JUDGED).most_common(10):
            print(f"  {k[0]:10} '{k[1]}'  {v}건")

    print(f"\n[표준화 결과 확인]")
    for col in ["성별", "결제수단", "결제상태", "접수상태", "감면유형"]:
        print(f"  {col:8} {dict(Counter(r[col] for r in merged))}")

    print(f"\n[빈 칸이 있는 표준 칸]")
    for col in ["시험지역", "회차", "차수", "교육기관"]:
        empty = sum(1 for r in merged if r[col].strip() == "")
        print(f"  {col:8} 빈 칸 {empty:>4}행 / 전체 {len(merged)}행")

    print(f"\n저장: {out}")
    print("=" * 62)


if __name__ == "__main__":
    main()
