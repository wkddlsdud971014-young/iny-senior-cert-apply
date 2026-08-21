// =============================================================
// 연락처 규칙 — 접수 화면(apply)과 접수 확인 화면(check)이 같이 씁니다.
//
// 왜 파일로 뺐나
//   전에는 두 화면이 하이픈 함수를 따로 갖고 있었습니다. 그래서 접수 화면은
//   02-123-4567 로 보여 주는데 확인 화면은 021-234-567 로 보여 줬습니다.
//   같은 번호가 화면마다 다르게 보이면 어르신은 "내가 잘못 넣었나" 하십니다.
//   규칙을 한 곳에만 적어 두면 어긋날 수가 없습니다.
//
// 원본 불변 원칙과의 관계
//   여기서 하는 일은 "화면에서 안내하기"와 "보내기 전에 막기"까지입니다.
//   이미 저장된 값을 고치지 않습니다. DB 에도 제약을 걸지 않습니다.
//   (supabase.sql 설계 원칙 — 원본 컬럼에는 check/not null 을 걸지 않는다)
//
// 2026-08-21 새로 만듦.
//   사용성 테스트에서 자릿수가 모자란 번호와 없는 번호대가 그대로 접수되는
//   일이 반복되어, 검증을 한 곳으로 모으고 규칙을 세웠습니다.
// =============================================================


// ----- 숫자만 뽑기 -----
// 하이픈을 넣으셨든 안 넣으셨든 같은 번호로 봅니다.
// DB 의 phone_digits 파생 컬럼과 같은 계산입니다.
function phoneDigits(value) {
  return String(value == null ? "" : value).replace(/[^0-9]/g, "");
}


// ----- 번호대별 자릿수 -----
//
// 실제로 쓰이는 번호대만 적었습니다. 여기 없는 번호대(055-1234-5678 처럼
// 지역번호 자리에 없는 숫자가 온 것)는 "없는 번호"로 봅니다.
//
// 0505(안심번호) · 080(수신자부담) 은 넣지 않았습니다.
// 접수하신 분께 저희가 거는 번호라서, 걸 수 없는 번호는 받을 이유가 없습니다.
//
// min 과 max 가 다른 줄이 있는 까닭
//   011·016~019 는 010 으로 합치기 전 번호라 10자리인 분도 계십니다.
//   지역번호는 국번이 3자리인 곳과 4자리인 곳이 섞여 있습니다.
const PHONE_RULES = [
  { heads: ["010"],
    min: 11, max: 11, label: "휴대폰 번호", range: "숫자 11자리" },

  { heads: ["011", "016", "017", "018", "019"],
    min: 10, max: 11, label: "휴대폰 번호", range: "숫자 10자리나 11자리" },

  { heads: ["02"],
    min: 9,  max: 10, label: "서울 번호", range: "숫자 9자리나 10자리" },

  { heads: ["031", "032", "033", "041", "042", "043", "044",
            "051", "052", "053", "054", "055",
            "061", "062", "063", "064", "070"],
    min: 10, max: 11, label: "집 전화 번호", range: "숫자 10자리나 11자리" },
];

// 앞자리를 보고 어느 규칙인지 찾습니다.
// 아직 짧게 넣으신 중이면(01 만 넣으신 때) null 이 나옵니다.
// 그때는 오류로 보지 않습니다. 아직 넣고 계시는 중이기 때문입니다.
function phoneRule(digits) {
  const d = phoneDigits(digits);
  // 긴 앞자리(3자리)를 먼저 봅니다. 02 와 031 이 헷갈리지 않게 하려고요.
  for (const len of [3, 2]) {
    const head = d.slice(0, len);
    if (head.length < len) continue;
    const rule = PHONE_RULES.find(r => r.heads.includes(head));
    if (rule) return rule;
  }
  return null;
}

// 지금 넣으신 번호가 몇 자리까지 갈 수 있는지.
// 앞자리를 아직 모르면 가장 긴 11자리로 둡니다. 넣으시는 것을 막지 않기 위해서입니다.
function phoneMaxDigits(digits) {
  const rule = phoneRule(digits);
  return rule ? rule.max : 11;
}


// ----- 하이픈 붙이기 -----
// 숫자만 넣으셔도 010-1234-5678 모양으로 보이게 합니다.
// 자릿수를 넘긴 숫자는 받지 않습니다. 넘긴 것을 알려 드리는 일은
// 화면 쪽에서 합니다 (phoneOverflow 참고).
function hyphenPhone(value) {
  const all = phoneDigits(value);
  const d   = all.slice(0, phoneMaxDigits(all));

  if (d.startsWith("02")) {
    if (d.length <= 2) return d;
    if (d.length <= 5) return d.slice(0, 2) + "-" + d.slice(2);
    if (d.length <= 9) return d.slice(0, 2) + "-" + d.slice(2, 5) + "-" + d.slice(5);
    return d.slice(0, 2) + "-" + d.slice(2, 6) + "-" + d.slice(6, 10);
  }
  if (d.length <= 3)  return d;
  if (d.length <= 7)  return d.slice(0, 3) + "-" + d.slice(3);
  if (d.length <= 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
  return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7, 11);
}

// 넘겨서 넣으신 숫자가 몇 개인지.
// 0 보다 크면 화면에서 "그만 넣으셔도 됩니다"라고 알려 드립니다.
// 전에는 말없이 사라져서, 다 넣으신 줄 알고 넘어가셨습니다.
function phoneOverflow(value) {
  const all = phoneDigits(value);
  return Math.max(0, all.length - phoneMaxDigits(all));
}


// ----- 검사 -----
//
// 화면 세 곳(엔터 · 고치실 때 · 보내기)에서 모두 이 함수 하나만 부릅니다.
// 전에는 보내기에서만 불러서, 엔터로 넘어가면 검사를 건너뛰었습니다.
//
// 오류 종류를 code 로 함께 돌려줍니다. 화면이 종류에 따라 다르게 굴어야 해서입니다.
//   empty   아직 안 넣으심
//   short   숫자가 모자람        ← 넣고 계시는 중일 수 있어 바로 다그치지 않습니다
//   long    숫자가 넘침
//   unknown 없는 번호대
//   same    같은 숫자만 이어짐
// short 만 "아직 넣는 중"일 수 있고, 나머지는 더 넣으셔도 맞아지지 않습니다.
// 그래서 short 를 뺀 나머지는 넣으시는 도중에도 바로 알려 드립니다.
function phoneCheck(value) {
  const d  = phoneDigits(value);
  const no = (code, message) => ({ code: code, message: message });

  if (d === "") return no("empty", "연락처를 넣어 주십시오.");

  if (!d.startsWith("0"))
    return no("unknown",
      "연락처는 0 으로 시작합니다. 휴대폰은 010, 집 전화는 지역번호부터 넣어 주십시오.");

  const rule = phoneRule(d);
  if (!rule) {
    // 아직 앞자리도 다 안 넣으신 것과, 없는 번호대를 넣으신 것은 다릅니다.
    // 두 자리까지는 010 인지 011 인지 알 수 없으니 없는 번호라고 하지 않습니다.
    if (d.length < 3)
      return no("short",
        "연락처를 끝까지 넣어 주십시오. 휴대폰은 숫자 11자리입니다. (지금 " + d.length + "자리)");
    return no("unknown",
      "없는 번호입니다. 휴대폰은 010 으로, 집 전화는 02 나 031 같은 지역번호로 시작합니다.");
  }

  if (d.length < rule.min)
    return no("short",
      "숫자가 " + (rule.min - d.length) + "자 모자랍니다. " +
      rule.label + "는 " + rule.range + "입니다. (지금 " + d.length + "자리)");

  if (d.length > rule.max)
    return no("long",
      "숫자가 " + (d.length - rule.max) + "자 많습니다. " +
      rule.label + "는 " + rule.range + "입니다. (지금 " + d.length + "자리)");

  const head = rule.heads.find(h => d.startsWith(h));
  const tail = d.slice(head.length);

  // 국번(앞자리 다음 자리)이 0 으로 시작하는 번호는 없습니다.
  // 02-0123-4567 처럼 지역번호 뒤에 0 을 이어 넣으신 것을 잡습니다.
  // 1 은 막지 않습니다. 010-1234-5678 처럼 실제로 쓰이는 번호가 있습니다.
  if (tail.startsWith("0"))
    return no("unknown", "없는 번호입니다. " + head + " 다음 자리는 0 으로 시작하지 않습니다.");

  // 010-1111-1111 처럼 앞자리를 뺀 나머지가 모두 같은 숫자인 것.
  // 급하실 때 아무 숫자나 채우고 넘어가시는 일이 있어 막습니다.
  if (/^(\d)\1+$/.test(tail))
    return no("same", "연락처를 다시 확인해 주십시오. 같은 숫자만 이어져 있습니다.");

  return no("", "");
}

// 오류 문구만 필요할 때. 없으면 빈 글자입니다.
function checkPhone(value) {
  return phoneCheck(value).message;
}

// 넣기를 마치셨는지. 다음 칸으로 저절로 넘겨 드릴지 정할 때 씁니다.
// 자릿수만 세지 않고 검사를 통째로 지나야 넘어갑니다.
function phoneDone(value) {
  return checkPhone(value) === "";
}
