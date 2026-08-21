// =============================================================
// 접수 화면 동작
//
// 자격증은 홈 화면에서 고르고 주소로 넘어옵니다 (apply.html?cert=...).
// 여기서는 신청하시는 분 정보와 동의만 받습니다.
//
// 원칙: 사용자가 넣은 값을 고치지 않고 그대로 저장합니다.
//       연락처의 하이픈을 지우거나 이름의 공백을 다듬지 않습니다.
//       정리된 값이 필요하면 DB가 파생 컬럼에서 따로 계산합니다.
// =============================================================

const form     = document.getElementById("apply-form");
const noCert   = document.getElementById("no-cert");
const nameBox  = document.getElementById("name");
const phoneBox = document.getElementById("phone");
const noteBox  = document.getElementById("note");
const msgBox   = document.getElementById("msg");
const sendBtn  = document.getElementById("send-btn");
const doneBox  = document.getElementById("done");
const sumBox   = document.getElementById("summary");
const agP      = document.getElementById("ag-privacy");
const agT      = document.getElementById("ag-terms");

let picked = null;      // 고른 자격증 이름
let pickedFee = null;   // 고른 자격증 응시료


// ----- 1. 홈에서 고르고 넘어온 자격증 확인 -----

(function () {
  const want = new URLSearchParams(location.search).get("cert");
  const cert = want ? certByName(want) : null;

  if (!cert) {
    // 자격증 없이 들어오셨으면 신청서를 감추고 홈으로 안내합니다.
    form.hidden = true;
    if (noCert) noCert.hidden = false;
    return;
  }

  // 지금 접수할 수 없는 자격증이면 신청서를 열지 않습니다.
  // "올해는 접수할 수 없다고 안내해야 합니다" (02_안내규정.md 81줄)
  if (cert.open === false) {
    form.hidden = true;
    if (noCert) {
      noCert.hidden = false;
      noCert.querySelector("h2").textContent = cert.name + " 는 지금 접수하실 수 없습니다";
      noCert.querySelector("p").textContent = cert.closed;
    }
    return;
  }

  picked = cert.name;
  pickedFee = cert.fee;

  const fee = cert.fee
    ? '<span class="fee">필기 응시료 ' + cert.fee + '</span>'
    : '<span class="fee na">필기 응시료 확인 필요</span>';
  sumBox.innerHTML =
    '<span class="lbl">고르신 자격증</span>' +
    '<span class="cert">' + certLabel(cert) + '</span>' +
    '<span class="sub">' + cert.org + '<br>' + cert.method + '</span>' +
    fee +
    (cert.note ? '<span class="note">' + cert.note + '</span>' : '') +
    '<a class="change" href="index.html?open=1">다른 자격증으로 바꾸기</a>';
  sumBox.hidden = false;
})();


// ----- 2. 연락처 -----
// 하이픈 붙이기(hyphenPhone) 와 검사(phoneCheck) 는 phone.js 에 있습니다.
// 접수 확인 화면(check.html)도 같은 파일을 씁니다. 두 화면의 판정이 어긋나지
// 않게 하려고 한 곳으로 모았습니다.


// ----- 3. 다음에 하실 차례를 표시 -----
// 지금 채우실 곳 하나에만 테두리를 밝힙니다.

function updateNext() {
  ["f-name", "f-phone", "f-note", "agree-box", "send-btn"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("next-up");
  });

  // 지금 쓰고 계신 칸이 있으면 그 칸에 머뭅니다.
  // 글자를 한 자 넣었다고 표시가 다음 칸으로 넘어가면 헷갈리십니다.
  const now = document.activeElement;
  let id = null;
  if (now === nameBox)       id = "f-name";
  else if (now === phoneBox) id = "f-phone";
  else if (now === noteBox)  id = null;              // 선택사항이라 표시하지 않음
  else if (now === agP || now === agT) id = "agree-box";
  else if (nameBox.value.trim() === "")                     id = "f-name";
  else if (phoneBox.value.trim() === "")                    id = "f-phone";
  else if (!(agP && agP.checked) || !(agT && agT.checked))  id = "agree-box";
  else                                                      id = "send-btn";

  const el = id ? document.getElementById(id) : null;
  if (el) el.classList.add("next-up");

  [agP, agT].forEach(function (c) {
    if (c) c.closest("label.agree").classList.toggle("done", c.checked);
  });
}


// ----- 입력 검사 -----
// 화면에서만 봅니다. DB 에는 제약을 걸지 않습니다.
// 원본 데이터를 거부하지 않는다는 원칙은 그대로입니다.

// 연락처(phoneCheck)와 같은 꼴로 돌려줍니다. { code, message }
//   empty  아직 안 넣으심
//   short  아직 모자람   ← 넣고 계시는 중일 수 있어 바로 다그치지 않습니다
//   long   너무 김
//   format 이름에 없는 글자가 섞임
function nameCheck(v) {
  const t  = (v || "").trim();
  const no = function (code, message) { return { code: code, message: message }; };

  if (t === "")      return no("empty", "이름을 넣어 주십시오.");
  if (t.length < 2)  return no("short", "이름을 두 글자 이상 넣어 주십시오.");
  if (t.length > 30) return no("long",  "이름이 너무 깁니다. 30자 안으로 넣어 주십시오.");
  // 한글(완성된 글자)과 영문, 띄어쓰기만 받습니다.
  // "ㅎ" 같은 자음 하나, 숫자, 기호는 이름이 아닙니다.
  if (!/^[가-힣a-zA-Z\s]+$/.test(t))
    return no("format", "이름에는 한글이나 영문만 넣어 주십시오. 숫자나 기호는 넣지 마십시오.");
  return no("", "");
}

// 오류 문구만 필요할 때.
function checkName(v) { return nameCheck(v).message; }

// 연락처 검사는 phone.js 의 phoneCheck 하나만 씁니다.


// ----- 칸의 네 가지 상태 -----
// 2026-08-21 추가.
//
// 전에는 칸마다 안내가 제각각이었습니다.
//   이름 칸  — "다 넣으시면 엔터를 누르십시오" 가 다 넣으신 뒤에도 남아 있었습니다.
//   연락처 칸 — 안내가 아예 없어, 무엇을 어떻게 넣어야 하는지 알 수 없었습니다.
//   동의     — 오류가 화면 아래 한 곳에만 떠서 어느 칸이 문제인지 찾아 내려가셔야 했습니다.
//
// 그래서 모든 칸을 아래 네 가지 상태 가운데 하나로 두고, 상태마다 할 말을 정했습니다.
//   empty   아직 안 넣으심      → 무엇을 넣는 곳인지
//   typing  넣고 계심           → 얼마나 남았는지 · 다 넣으면 무엇을 하는지
//   ok      제대로 넣으심        → 무엇으로 접수되는지 (확인시켜 드림)
//   bad     틀리게 넣으심        → 무엇이 틀렸고 어떻게 고치는지
//
// 규칙 두 가지
//   1. 한 칸에는 한 줄만 보입니다. 안내와 오류가 같이 떠 있지 않습니다.
//   2. 다 넣으신 칸에는 시키는 말이 남지 않습니다.

const FIELD_TEXT = {
  name: {
    empty:  "주민등록증에 적힌 이름 그대로 넣어 주십시오.",
    typing: "다 넣으시면 <b>엔터</b>를 누르십시오.",
    ok:     function (v) { return "✓ " + v.trim() + " 님으로 접수합니다."; },
  },
  phone: {
    empty:  "숫자만 넣으셔도 됩니다. 사이의 줄(-)은 저희가 넣어 드립니다.",
    typing: function (v) {
      const rule = phoneRule(v);
      const n    = phoneDigits(v).length;
      if (!rule) return "휴대폰은 010, 집 전화는 02 나 031 같은 지역번호부터 넣어 주십시오.";
      return "지금 " + n + "자리입니다. " + rule.label + "는 " + rule.range + "입니다.";
    },
    ok:     function (v) { return "✓ " + v + " 로 연락드립니다."; },
  },
  note: {
    // 선택사항입니다. 안 쓰셔도 되는 칸에서 "넣으십시오"라고 하면 안 됩니다.
    empty:  "안 쓰셔도 접수됩니다. 하실 말씀이 있으실 때만 적어 주십시오.",
    typing: "다 쓰시면 아래 <b>동의</b>로 내려가십시오.",
    ok:     function () { return "✓ 적어 주셨습니다. 담당자가 함께 봅니다."; },
  },
  agree: {
    empty:  "아래 두 가지에 <b>모두 체크</b>하셔야 접수가 됩니다.",
    typing: "한 가지 더 남았습니다.",
    ok:     function () { return "✓ 두 가지 모두 동의하셨습니다."; },
  },
};

// 칸 하나를 한 상태로 맞춥니다. 셋 가운데 한 줄만 보이게 합니다.
function setFieldState(key, state, value) {
  const box  = document.getElementById(key === "agree" ? "agree-box" : "f-" + key);
  const err  = document.getElementById("e-" + key);
  const ok   = document.getElementById("k-" + key);
  const help = document.getElementById("h-" + key);
  const text = FIELD_TEXT[key];

  const set = function (el, html) {
    if (!el) return;
    if (html == null) { el.hidden = true; return; }
    el.innerHTML = html; el.hidden = false;
  };

  if (state === "bad") {
    set(err, value); set(ok, null); set(help, null);
    if (box) box.classList.add("bad");
    return;
  }
  if (box) box.classList.remove("bad");

  if (state === "ok") { set(err, null); set(ok, text.ok(value)); set(help, null); return; }

  const line = typeof text[state] === "function" ? text[state](value) : text[state];
  set(err, null); set(ok, null); set(help, line);
}


// ----- 지금 값을 보고 상태를 정하기 -----
//
// 한 번 틀리신 칸은 표시해 둡니다.
// 전에는 오류가 뜬 뒤 한 글자만 지우셔도 오류 표시가 사라졌습니다.
// 아직 틀린 번호인데 화면은 멀쩡해 보이고, 보내기를 누르시면 다시 막혔습니다.
// 한 번 틀린 칸은 제대로 고치실 때까지 계속 알려 드립니다.
const wrong = { name: false, phone: false, agree: false };

const BOXES = { name: nameBox, phone: phoneBox, note: noteBox };

// force 가 참이면 아직 넣고 계셔도 모자란 것까지 알려 드립니다.
// 엔터를 누르셨을 때 · 칸을 떠나실 때 · 보내기를 누르셨을 때만 참입니다.
function refreshField(key, force) {
  if (key === "note") {
    // 선택사항이라 검사하지 않습니다. 안 쓰셔도 되는 칸을 틀렸다고 하면 안 됩니다.
    const v = noteBox.value;
    if (v.trim() === "") { setFieldState("note", "empty"); return { code: "", message: "" }; }
    setFieldState("note", document.activeElement === noteBox ? "typing" : "ok", v);
    return { code: "", message: "" };
  }

  const v   = BOXES[key].value;
  const bad = key === "name" ? nameCheck(v) : phoneCheck(v);

  if (!bad.code) { wrong[key] = false; setFieldState(key, "ok", v); return bad; }

  // empty 와 short 는 "아직 넣고 계시는 중"일 수 있습니다.
  // 이미 한 번 틀리셨거나(wrong) 다 넣었다고 하신 뒤(force)에만 오류로 봅니다.
  // 나머지(없는 번호대 · 이름에 숫자)는 더 넣으셔도 맞아지지 않으니 바로 알려 드립니다.
  const soft = (bad.code === "empty" || bad.code === "short") && !force && !wrong[key];
  if (soft) {
    setFieldState(key, bad.code === "empty" ? "empty" : "typing", v);
    return bad;
  }

  wrong[key] = true;
  setFieldState(key, "bad", bad.message);
  return bad;
}

// 동의 두 가지도 같은 네 가지 상태를 씁니다.
function refreshAgree(force) {
  const p = !!(agP && agP.checked), t = !!(agT && agT.checked);

  if (p && t) { wrong.agree = false; setFieldState("agree", "ok"); return true; }

  if (force || wrong.agree) {
    wrong.agree = true;
    setFieldState("agree", "bad",
      !p && !t ? "아래 두 가지에 모두 체크해 주십시오."
      : p      ? "이용약관에도 체크해 주십시오."
               : "개인정보 수집 · 이용에도 체크해 주십시오.");
    return false;
  }

  setFieldState("agree", (!p && !t) ? "empty" : "typing");
  return false;
}

// 틀린 칸으로 데려다 드립니다. 보내기를 누르셨을 때만 씁니다.
// 화면 아래 버튼 옆에만 띄우면 위에 있는 칸이 문제일 때 못 보십니다.
function goToProblem(key) {
  const box = BOXES[key] || (agP && !agP.checked ? agP : agT);
  const el  = document.getElementById(key === "agree" ? "agree-box" : "f-" + key);
  if (box) box.focus({ preventScroll: true });
  if (el)  el.scrollIntoView({ behavior: "smooth", block: "center" });
}


// ----- 4. 안내 문구 -----

function showMessage(text) { msgBox.textContent = text; msgBox.className = "warn"; }
function clearMessage()    { msgBox.textContent = "";   msgBox.className = "";     }


// ----- 5. 신청서 보내기 -----

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  clearMessage();

  // 화면에서 안내만 합니다. DB에는 이런 제약을 걸지 않았습니다.
  //
  // 세 칸을 모두 본 뒤 위에서부터 첫 번째 문제로 데려다 드립니다.
  // 한 칸씩 막으면 고치고 누르고, 또 막히고 고치기를 되풀이하셔야 합니다.
  // 세 칸의 상태가 한 번에 보여야 몇 군데가 남았는지 아십니다.
  const bads = [];
  if (refreshField("name",  true).code) bads.push("name");
  if (refreshField("phone", true).code) bads.push("phone");
  if (!refreshAgree(true))              bads.push("agree");
  refreshField("note");

  if (bads.length) {
    showMessage(bads.length === 1
      ? "한 곳을 더 봐 주십시오. 아래에 빨갛게 표시해 두었습니다."
      : bads.length + "곳을 더 봐 주십시오. 아래에 빨갛게 표시해 두었습니다.");
    goToProblem(bads[0]);
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = "보내는 중입니다...";

  // 입력한 값을 그대로 저장합니다. 다듬지 않습니다.
  const row = {
    name:            nameBox.value,
    phone:           phoneBox.value,
    note:            noteBox.value,
    certificate:     picked,   // 원본
    certificate_std: picked,   // 판정 (홈에서 고른 값이라 표준명과 같음)
    channel:         "온라인",
    // 발주서 3절의 접수 4단계 가운데 2단계입니다.
    //   1 문의 → 2 접수 → 3 확인(담당자) → 4 완료(두두넷 원서접수)
    staff_app_status: "접수"
  };

  // 보내기 직전에 한 번 더 봅니다.
  // 위에서 본 것은 "칸에 든 값"이고 여기서 보는 것은 "실제로 보낼 값"입니다.
  // 둘 사이에 자동완성이나 붙여넣기가 끼어들 수 있어, 나가는 값을 기준으로 다시 셉니다.
  // 잘못된 값이 원본으로 들어가면 나중에는 고칠 방법이 없습니다.
  // (supabase.sql — update/delete 정책을 일부러 만들지 않았습니다)
  const lastNameErr  = checkName(row.name);
  const lastPhoneErr = checkPhone(row.phone);
  if (lastNameErr || lastPhoneErr) {
    sendBtn.disabled = false;
    sendBtn.textContent = "신청서 보내기";
    if (lastNameErr) showFieldError("f-name", "e-name", nameBox, lastNameErr);
    else             showFieldError("f-phone", "e-phone", phoneBox, lastPhoneErr);
    return;
  }

  const { data, error } = await db
    .from("applications")
    .insert(row)
    .select("id, created_at")
    .single();

  sendBtn.disabled = false;
  sendBtn.textContent = "신청서 보내기";

  if (error) {
    showMessage("접수가 되지 않았습니다. 잠시 뒤에 다시 눌러 주십시오. (" + error.message + ")");
    return;
  }

  showDone(data, row);
});


// ----- 6. 접수 완료 화면 -----

function showDone(saved, row) {
  document.getElementById("done-title").textContent =
    "접수 완료되었습니다";
  document.getElementById("done-no").textContent   = saved.id;
  document.getElementById("done-cert").textContent =
    row.certificate + (pickedFee ? "  (필기 응시료 " + pickedFee + ")" : "  (응시료 확인 필요)");
  document.getElementById("done-name").textContent = row.name;

  const t = new Date(saved.created_at);
  document.getElementById("done-at").textContent =
    t.getFullYear() + "년 " + (t.getMonth() + 1) + "월 " + t.getDate() + "일 " +
    String(t.getHours()).padStart(2, "0") + "시 " +
    String(t.getMinutes()).padStart(2, "0") + "분";

  form.hidden = true;
  doneBox.hidden = false;
  doneBox.scrollIntoView({ behavior: "smooth", block: "start" });

  // 인쇄하기 — 화면 그대로 종이에. 메뉴와 버튼은 인쇄되지 않습니다.
  document.getElementById("btn-print").addEventListener("click", function () {
    window.print();
  });

  // 접수 내용 복사 — 문자로 보내시거나 메모에 붙여 두시라고.
  document.getElementById("btn-copy").addEventListener("click", async function (e) {
    const t =
      "[두두자격지원센터 접수 완료]\n" +
      "접수번호: " + saved.id + "\n" +
      "신청 자격증: " + row.certificate + (pickedFee ? " (필기 응시료 " + pickedFee + ")" : "") + "\n" +
      "이름: " + row.name + "\n" +
      "접수한 때: " + document.getElementById("done-at").textContent;
    try {
      await navigator.clipboard.writeText(t);
      e.target.textContent = "✅ 복사했습니다";
    } catch (err) {
      e.target.textContent = "복사가 안 됩니다. 화면을 사진으로 찍어 주십시오";
    }
    setTimeout(function () { e.target.textContent = "📋 접수 내용 복사"; }, 2500);
  });
}


// ----- 7. 연결 -----

// 다음 칸으로 옮겨 드리기
// 어르신이 "이제 뭘 해야 하나" 찾지 않으시도록 자동으로 넘어갑니다.
function goTo(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const box = el.closest(".field") || el.closest(".agree-box") || el;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

// 한글을 칠 때는 엔터가 "글자 완성" 역할도 합니다.
// 조합 중에 누른 엔터는 다음 칸으로 넘어가는 신호가 아닙니다.
//   e.isComposing        — 한글을 조합하는 중
//   e.keyCode === 229    — 옛 브라우저에서 조합 중일 때 오는 값
function isTypingHangul(e) {
  return e.isComposing || e.keyCode === 229;
}

// 이름 칸에서 엔터 → 연락처로
nameBox.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" || isTypingHangul(e)) return;
  e.preventDefault();
  if (refreshField("name", true).code) { nameBox.focus({ preventScroll: true }); return; }
  goTo(phoneBox);
});

// 연락처 칸에서 엔터 → 동의로
// 전에는 검사 없이 그냥 넘어갔습니다. 자릿수가 모자란 번호가 여기로 빠져나갔습니다.
phoneBox.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" || isTypingHangul(e)) return;
  e.preventDefault();
  if (refreshField("phone", true).code) { phoneBox.focus({ preventScroll: true }); return; }
  goTo(agP);
});

phoneBox.addEventListener("input", function () {
  const before = phoneBox.value;
  const over   = phoneOverflow(before);          // 자릿수를 넘겨 넣으신 숫자 개수
  phoneBox.value = hyphenPhone(before);

  // 숫자가 아닌 글자를 넣으시면 왜 안 써지는지 알려 드립니다.
  // 그냥 지워 버리면 "왜 안 되지?" 하고 헤매십니다.
  if (/[^0-9\-\s]/.test(before)) {
    wrong.phone = true;
    setFieldState("phone", "bad", "연락처에는 숫자만 넣어 주십시오.");
    return;
  }

  // 자릿수를 넘기면 더 안 들어갑니다. 전에는 말없이 사라져서
  // 다 넣으신 줄 알고 그대로 넘어가셨습니다.
  if (over > 0) {
    // 틀린 것으로 세지 않습니다. 앞 11자리는 제대로 넣으셨으니까요.
    setFieldState("phone", "bad",
      "숫자를 다 넣으셨습니다. 더 넣으신 " + over + "자는 들어가지 않습니다.");
    return;
  }

  // 번호를 제대로 다 넣으시면 저절로 동의 칸으로 넘어갑니다.
  // 전에는 11자리이기만 하면 넘어갔습니다. 이제는 검사를 지나야 넘어갑니다.
  if (!refreshField("phone", false).code) setTimeout(function () {
    if (document.activeElement === phoneBox) goTo(agP);
  }, 250);
});

// 첫 번째 동의에 체크하시면 두 번째로
if (agP) agP.addEventListener("change", function () {
  if (agP.checked && agT && !agT.checked) setTimeout(function () { goTo(agT); }, 150);
});
// 두 가지 다 체크하시면 보내기 버튼으로
if (agT) agT.addEventListener("change", function () {
  if (agT.checked && agP && agP.checked) setTimeout(function () { goTo(sendBtn); }, 150);
});

// 글자를 넣으실 때마다 그 칸의 상태를 다시 맞춥니다.
// 칸을 떠나실 때는 모자란 것까지 알려 드립니다.
// 마우스로 다음 칸을 눌러 건너뛰고 가시는 분이 계셔서입니다.
["name", "phone", "note"].forEach(function (key) {
  const el = BOXES[key];
  el.addEventListener("input", function () { if (key !== "phone") refreshField(key, false); updateNext(); });
  el.addEventListener("focus", function () { refreshField(key, false); updateNext(); });
  el.addEventListener("blur",  function () {
    refreshField(key, true);
    setTimeout(updateNext, 0);
  });
});
[agP, agT].forEach(function (c) {
  if (c) c.addEventListener("change", function () { refreshAgree(false); updateNext(); });
});

// 화면을 여실 때 네 칸을 모두 "아직 안 넣으심" 상태로 놓습니다.
["name", "phone", "note"].forEach(function (key) { refreshField(key, false); });
refreshAgree(false);
updateNext();
