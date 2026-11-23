// ===== 表示側: iPhone同士連携（P2P）の受け付け画面 =====
// 操作側のQR（表示ページURL＋接続コード）を読んで開かれた場合、URLの #tk= から
// 接続コードを取り込んで自動で応答コードを作り、応答用QRを大きく表示する。
// 操作側がその応答QRを読む（またはコードを貼り付ける）と接続が成立し、
// この画面は通常の表示ページに切り替わる。
// URLにコードがない場合は、貼り付けフォームから手動で開始できる。
(function () {
  "use strict";

  // P2Pで届いた状態を、表示ページ本体の受信処理へ渡す
  TKP2P.onState = function (text) {
    if (window.__tkReceiveStateText) window.__tkReceiveStateText(text);
  };

  var STATUS_TEXT = {
    idle: "未接続",
    offering: "応答コードを作成中…",
    waiting: "応答コードを表示中（操作側で読んでください）",
    connecting: "接続中…",
    connected: "接続完了",
    closed: "切断されました",
    error: "エラー（やり直してください）"
  };

  var overlay = null, els = {};

  function injectStyle() {
    if (document.getElementById("tk-pair-style")) return;
    var st = document.createElement("style");
    st.id = "tk-pair-style";
    st.textContent = [
      "#tk-pair-overlay{position:fixed;inset:0;z-index:1000;background:#06060e;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:sans-serif;overflow-y:auto;}",
      "#tk-pair-overlay.hidden{display:none;}",
      ".tk-pair-card{max-width:520px;width:100%;text-align:center;color:#f5f2ea;}",
      ".tk-pair-card h2{font-size:20px;letter-spacing:2px;color:#28e07a;margin:0 0 6px;}",
      ".tk-pair-card .sub{font-size:13px;color:#9a97a8;line-height:1.6;margin-bottom:12px;}",
      ".tk-pair-card .status{font-size:15px;font-weight:bold;padding:10px;border:1px solid #2a2a44;border-radius:10px;background:#0f0f1c;margin-bottom:14px;}",
      ".tk-pair-card .status.ok{color:#28e07a;border-color:#28e07a88;}",
      ".tk-pair-card canvas.qr{display:block;margin:10px auto;background:#fff;border-radius:10px;max-width:86vw;height:auto;}",
      ".tk-pair-card textarea{width:100%;box-sizing:border-box;background:#0f0f1c;color:#aab;border:1px solid #2a2a44;border-radius:8px;font-size:10px;padding:6px;word-break:break-all;}",
      ".tk-pair-card button.act{display:block;width:100%;padding:12px;border-radius:10px;border:1px solid #28e07a;background:rgba(40,224,122,.12);color:#28e07a;font-size:15px;font-weight:bold;cursor:pointer;margin:8px 0;}",
      ".tk-pair-card .err{font-size:13px;color:#ff5252;min-height:1em;margin-top:6px;}",
      "#tk-pair-reopen{position:fixed;right:10px;bottom:10px;z-index:900;padding:8px 14px;border-radius:999px;border:1px solid #28e07a88;background:rgba(6,6,14,.85);color:#28e07a;font-size:13px;font-weight:bold;cursor:pointer;display:none;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function build() {
    injectStyle();
    overlay = document.createElement("div");
    overlay.id = "tk-pair-overlay";
    overlay.innerHTML =
      '<div class="tk-pair-card">' +
        '<h2>iPhone同士 連携</h2>' +
        '<div class="sub">操作側のTimeKeeperと直接つながります（サーバーなし）。<br>' +
        '応答用QRが表示されたら、操作側の「連携」パネルで読んでください。</div>' +
        '<div class="status" id="tk-disp-status">未接続</div>' +
        '<canvas class="qr" id="tk-disp-qr" width="300" height="300" style="display:none"></canvas>' +
        '<textarea id="tk-disp-answer" rows="3" readonly style="display:none"></textarea>' +
        '<div id="tk-disp-manual">' +
          '<textarea id="tk-disp-offer" rows="3" placeholder="操作側の接続コード（またはURL）を貼り付け"></textarea>' +
          '<button class="act" id="tk-disp-start">貼り付けたコードで接続を開始</button>' +
        '</div>' +
        '<div class="err" id="tk-disp-err"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    els.status = overlay.querySelector("#tk-disp-status");
    els.qr = overlay.querySelector("#tk-disp-qr");
    els.answer = overlay.querySelector("#tk-disp-answer");
    els.offer = overlay.querySelector("#tk-disp-offer");
    els.manual = overlay.querySelector("#tk-disp-manual");
    els.err = overlay.querySelector("#tk-disp-err");
    overlay.querySelector("#tk-disp-start").addEventListener("click", function () {
      startWith(els.offer.value);
    });

    var reopen = document.createElement("button");
    reopen.id = "tk-pair-reopen";
    reopen.textContent = "連携";
    reopen.addEventListener("click", function () { overlay.classList.remove("hidden"); });
    document.body.appendChild(reopen);
    els.reopen = reopen;

    TKP2P.onStatus = function (s) {
      setStatus(s);
      if (s === "connected") {
        overlay.classList.add("hidden");
        els.reopen.style.display = "block";
        if (window.__tkSetP2PConnected) window.__tkSetP2PConnected(true);
      } else if (s === "closed" || s === "error") {
        if (window.__tkSetP2PConnected) window.__tkSetP2PConnected(false);
      }
    };
    setStatus(TKP2P.status);
  }

  function setStatus(s) {
    if (!els.status) return;
    els.status.textContent = STATUS_TEXT[s] || s;
    els.status.className = "status" + (s === "connected" ? " ok" : "");
  }
  function setErr(msg) { if (els.err) els.err.textContent = msg || ""; }

  function startWith(codeText) {
    setErr("");
    if (!codeText || !String(codeText).trim()) { setErr("接続コードが空です"); return; }
    TKP2P.acceptOfferCode(codeText).then(function (answerCode) {
      els.qr.style.display = "block";
      TKQR.draw(els.qr, answerCode, 300);
      els.answer.style.display = "block";
      els.answer.value = answerCode;
      els.manual.style.display = "none";
    }).catch(function (e) { setErr(e.message || "接続コードを取り込めませんでした"); });
  }

  build();

  // URL（#tk=...）に接続コードが入っていれば自動で開始する
  var m = window.location.hash.match(/[#?&]tk=([^&\s]+)/) ||
          window.location.search.match(/[#?&]tk=([^&\s]+)/);
  if (m) {
    var code = m[1];
    try { code = decodeURIComponent(code); } catch (e) {}
    startWith(code);
  }
})();
