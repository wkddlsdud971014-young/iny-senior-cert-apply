// =============================================================
// 문의 챗봇 화면
//
// 두 곳에서 씁니다.
//   1) faq.html  — 페이지 안에 넓게
//   2) 그 밖의 화면 — 오른쪽 아래 「물어보기」를 누르면 뜨는 창
//
// 답은 우리 서버(/api/chat)가 만듭니다.
// 문서와 규칙은 파이썬 챗봇(chatbot/app.py)과 같은 것을 씁니다.
// =============================================================

// 파일을 직접 열면(file://) 우리 서버가 없어 답을 못 받습니다.
// 그럴 때는 배포된 주소의 서버를 부릅니다. 내 컴퓨터에서 확인하실 때를 위한 것입니다.
const CHAT_API = location.protocol === "file:"
  ? "https://iny-senior-cert-apply.vercel.app/api/chat"
  : "/api/chat";

const CHAT_EXAMPLES = [
  "한식조리기능사 응시료가 얼마예요?",
  "접수비 얼마나 해요?",
  "전기기능사는 언제 접수해요?",
  "포크레인 자격증도 되나요?",
  "시험 볼 때 뭘 가져가나요?",
];

function makeChat(root, opts = {}) {
  root.innerHTML =
    '<div class="chat-log" id="' + opts.id + '-log"></div>' +
    '<div class="chat-ex" id="' + opts.id + '-ex">' +
      CHAT_EXAMPLES.map(function (t) {
        return '<button type="button" class="ex">' + t + '</button>';
      }).join("") +
    '</div>' +
    '<form class="chat-in" id="' + opts.id + '-form">' +
      '<input type="text" placeholder="궁금하신 것을 적어 주십시오" autocomplete="off">' +
      '<button type="submit">보내기</button>' +
    '</form>';

  const log  = root.querySelector(".chat-log");
  const form = root.querySelector(".chat-in");
  const box  = form.querySelector("input");
  const btn  = form.querySelector("button");
  const exs  = root.querySelector(".chat-ex");

  say("bot",
    "안녕하십니까. 무엇이든 물어보십시오.\n" +
    "응시료, 접수 기간, 준비물 같은 것을 문서에 있는 대로 답해 드립니다.");

  function say(who, text, source) {
    const d = document.createElement("div");
    d.className = "msg " + who;
    d.innerHTML = '<div class="bubble">' + esc(text).replace(/\n/g, "<br>") +
      (source ? '<span class="src">' + esc(source) + "</span>" : "") + "</div>";
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    // 대화창이 화면 밖이면 그 자리로 옮겨 줍니다.
    if (who === "bot") {
      requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
    }
    return d;
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function ask(text) {
    text = (text || "").trim();
    if (text === "") return;
    exs.hidden = true;
    say("me", text);
    box.value = "";
    btn.disabled = true;
    const waiting = say("bot", "찾아보고 있습니다...");

    try {
      const res = await fetch(CHAT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      waiting.remove();
      say("bot", data.answer || "답을 만들지 못했습니다.", data.source);
    } catch (e) {
      waiting.remove();
      say("bot", "지금은 답해 드리기 어렵습니다. 잠시 뒤에 다시 물어봐 주십시오.");
    }
    btn.disabled = false;

    // 휴대폰에서는 입력칸에 커서를 두지 않습니다.
    // 커서를 두면 자판이 올라오면서 화면이 입력칸으로 내려가
    // 정작 답이 안 보입니다.
    const small = window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
    if (!small) box.focus();

    log.scrollTop = log.scrollHeight;   // 답이 보이게 대화창을 아래로
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); ask(box.value); });
  exs.addEventListener("click", function (e) {
    if (e.target.classList.contains("ex")) ask(e.target.textContent);
  });

  return { focus: function () { box.focus(); } };
}


// ---------- 오른쪽 아래 떠 있는 창 ----------

function setupFloatingChat() {
  const opener = document.querySelector(".float-chat");
  if (!opener || document.getElementById("chat-modal")) return;

  const wrap = document.createElement("div");
  wrap.className = "chat-modal";
  wrap.id = "chat-modal";
  wrap.hidden = true;
  wrap.innerHTML =
    '<div class="chat-box" role="dialog" aria-modal="true" aria-label="문의 챗봇">' +
      '<div class="chat-top">' +
        '<b>무엇이든 물어보십시오</b>' +
        '<button type="button" class="chat-close" aria-label="닫기">✕</button>' +
      '</div>' +
      '<div class="chat-body" id="mchat"></div>' +
    '</div>';
  document.body.appendChild(wrap);

  const chat = makeChat(document.getElementById("mchat"), { id: "m" });

  function open(e) {
    if (e) e.preventDefault();
    wrap.hidden = false;
    document.body.style.overflow = "hidden";
    chat.focus();
  }
  function close() {
    wrap.hidden = true;
    document.body.style.overflow = "";
  }

  opener.addEventListener("click", open);
  wrap.querySelector(".chat-close").addEventListener("click", close);
  wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !wrap.hidden) close();
  });
}

document.addEventListener("DOMContentLoaded", function () {
  const page = document.getElementById("page-chat");
  if (page) makeChat(page, { id: "p" });
  setupFloatingChat();
});
