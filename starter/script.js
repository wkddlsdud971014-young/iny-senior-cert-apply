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


// ----- 2. 연락처 하이픈 -----
// 숫자만 넣으셔도 010-1234-5678 모양으로 보이게 합니다.
// 전화번호 모양이 아니면(자릿수가 안 맞으면) 손대지 않고 그대로 둡니다.

function hyphenPhone(value) {
  const d = String(value == null ? "" : value).replace(/[^0-9]/g, "");
  if (d.startsWith("02")) {
    if (d.length <= 2)  return d;
    if (d.length <= 5)  return d.slice(0, 2) + "-" + d.slice(2);
    if (d.length <= 9)  return d.slice(0, 2) + "-" + d.slice(2, 5) + "-" + d.slice(5);
    return d.slice(0, 2) + "-" + d.slice(2, 6) + "-" + d.slice(6, 10);
  }
  if (d.length <= 3)  return d;
  if (d.length <= 7)  return d.slice(0, 3) + "-" + d.slice(3);
  if (d.length <= 10) return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
  return d.slice(0, 3) + "-" + d.slice(3, 7) + "-" + d.slice(7, 11);
}


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


// ----- 4. 안내 문구 -----

function showMessage(text) { msgBox.textContent = text; msgBox.className = "warn"; }
function clearMessage()    { msgBox.textContent = "";   msgBox.className = "";     }


// ----- 5. 신청서 보내기 -----

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  clearMessage();

  // 화면에서 안내만 합니다. DB에는 이런 제약을 걸지 않았습니다.
  if (nameBox.value.trim() === "") {
    showMessage("이름을 넣어 주십시오.");
    nameBox.focus();
    return;
  }
  if (agP && !agP.checked) {
    showMessage("개인정보 수집 · 이용에 동의해 주십시오.");
    agP.focus();
    return;
  }
  if (agT && !agT.checked) {
    showMessage("이용약관에 동의해 주십시오.");
    agT.focus();
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
    channel:         "온라인"
  };

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
  if (nameBox.value.trim() !== "") goTo(phoneBox);
});

// 연락처 칸에서 엔터 → 동의로
phoneBox.addEventListener("keydown", function (e) {
  if (e.key !== "Enter" || isTypingHangul(e)) return;
  e.preventDefault();
  goTo(agP);
});

phoneBox.addEventListener("input", function () {
  phoneBox.value = hyphenPhone(phoneBox.value);

  // 번호를 다 넣으시면(11자리) 저절로 동의 칸으로 넘어갑니다.
  const digits = phoneBox.value.replace(/[^0-9]/g, "");
  if (digits.length === 11) setTimeout(function () { goTo(agP); }, 250);
});

// 첫 번째 동의에 체크하시면 두 번째로
if (agP) agP.addEventListener("change", function () {
  if (agP.checked && agT && !agT.checked) setTimeout(function () { goTo(agT); }, 150);
});
// 두 가지 다 체크하시면 보내기 버튼으로
if (agT) agT.addEventListener("change", function () {
  if (agT.checked && agP && agP.checked) setTimeout(function () { goTo(sendBtn); }, 150);
});
[nameBox, phoneBox, noteBox].forEach(function (el) {
  el.addEventListener("input", updateNext);
  el.addEventListener("focus", updateNext);
  el.addEventListener("blur", function () { setTimeout(updateNext, 0); });
});
[agP, agT].forEach(function (c) { if (c) c.addEventListener("change", updateNext); });
updateNext();
