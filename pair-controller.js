// ===== 操作側: 連携パネル（右上の実時計をダブルタップして開く全画面時計ビューの「連携」ボタンから開く） =====
// 方式は WebRTC の端末同士の直接接続（サーバーなし）。接続の取り次ぎは QR の往復:
//   1) このパネルで接続用QR（表示ページURL＋接続コード）を表示する
//   2) 相手端末がカメラで読むと表示ページが開き、応答用QRが出る
//   3) このパネルのカメラ読み取りで応答QRを読むと接続が成立する
// PC中継（WebSocket）の従来同期はそのまま併用される（このファイルは __tkSyncSend を
// 包んで P2P 送信を追加するだけで、元の送信処理は変更しない）。
(function () {
  "use strict";

  // ---- 状態送信: 従来のWebSocket送信に P2P 送信を追加で包む ----
  var origSend = window.__tkSyncSend;
  window.__tkSyncSend = function (state) {
    if (origSend) { try { origSend(state); } catch (e) {} }
    if (window.TKP2P) { try { TKP2P.sendState(state); } catch (e) {} }
  };

  var STATUS_TEXT = {
    idle: "未接続",
    offering: "コードを作成中…",
    waiting: "相手の応答待ち",
    connecting: "接続中…",
    connected: "接続完了（連携中）",
    closed: "切断されました",
    error: "エラー（やり直してください）",
    icefailed: "つながりませんでした"
  };

  // ICE失敗時（別ネットワーク等で端末同士が届かなかったとき）の案内
  var ICE_GUIDE = "つながりませんでした。2台が同じWi-Fiか、片方の「インターネット共有」にそろっているか確認してください。そのうえで、下の「最初からやり直す（リセット）」からやり直してください。";

  var panel = null, els = {};
  var scanStream = null, scanTimer = null;

  function injectStyle() {
    if (document.getElementById("tk-pair-style")) return;
    var st = document.createElement("style");
    st.id = "tk-pair-style";
    st.textContent = [
      "#tk-pair-panel{position:fixed;inset:0;z-index:1000;background:rgba(4,4,10,.92);display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:18px 12px;box-sizing:border-box;font-family:sans-serif;}",
      "#tk-pair-panel.open{display:flex;}",
      ".tk-pair-card{background:#0f0f1c;border:1px solid #2a2a44;border-radius:16px;max-width:430px;width:100%;padding:16px;color:#dce0f8;box-sizing:border-box;}",
      ".tk-pair-card h2{font-size:16px;margin:0 0 4px;color:#28e07a;letter-spacing:1px;}",
      ".tk-pair-card .sub{font-size:11px;color:#8888aa;margin-bottom:10px;line-height:1.5;}",
      ".tk-pair-card .status{font-size:13px;font-weight:bold;padding:8px 10px;border:1px solid #2a2a44;border-radius:10px;margin-bottom:12px;background:#131325;}",
      ".tk-pair-card .status.ok{color:#28e07a;border-color:#28e07a88;}",
      ".tk-pair-card .step{font-size:12px;font-weight:bold;color:#f0a030;margin:12px 0 6px;letter-spacing:1px;}",
      ".tk-pair-card button.act{display:block;width:100%;padding:11px;border-radius:10px;border:1px solid #28e07a;background:rgba(40,224,122,.12);color:#28e07a;font-size:14px;font-weight:bold;cursor:pointer;margin:6px 0;}",
      ".tk-pair-card button.sub-act{display:block;width:100%;padding:9px;border-radius:10px;border:1px solid #44445a;background:#131325;color:#dce0f8;font-size:13px;cursor:pointer;margin:6px 0;}",
      ".tk-pair-card textarea{width:100%;box-sizing:border-box;background:#06060e;color:#aab;border:1px solid #2a2a44;border-radius:8px;font-size:10px;padding:6px;word-break:break-all;}",
      ".tk-pair-card canvas.qr{display:block;margin:8px auto;background:#fff;border-radius:8px;max-width:78vw;height:auto;}",
      ".tk-pair-card video{width:100%;border-radius:10px;background:#000;display:none;}",
      ".tk-pair-card .note{font-size:11px;color:#8888aa;line-height:1.6;margin-top:10px;}",
      ".tk-pair-card .err{font-size:12px;color:#ff4a4a;min-height:1em;margin-top:4px;}",
      ".tk-pair-card .info{font-size:12px;color:#28e07a;min-height:1em;margin-top:4px;}",
      ".tk-pair-card .diag{font-size:10px;color:#777799;line-height:1.6;margin-top:6px;word-break:break-all;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function buildPanel() {
    injectStyle();
    panel = document.createElement("div");
    panel.id = "tk-pair-panel";
    panel.innerHTML =
      '<div class="tk-pair-card">' +
        '<h2>連携（iPhone同士テスト）</h2>' +
        '<div class="sub">方式: 端末同士の直接接続（サーバーなし）<br>PC中継（WebSocket）の従来同期も、使える環境ではそのまま併用されます。</div>' +
        '<div class="status" id="tk-pair-status">未接続</div>' +
        '<div class="diag" id="tk-pair-diag">診断（この端末の接続候補）: （候補なし）</div>' +
        '<div class="step">手順1: 接続用QRを出す</div>' +
        '<button class="act" id="tk-pair-gen">接続用QRを表示</button>' +
        '<canvas class="qr" id="tk-pair-qr" width="264" height="264" style="display:none"></canvas>' +
        '<textarea id="tk-pair-offer-text" rows="3" readonly style="display:none"></textarea>' +
        '<div class="note">相手の端末のカメラでこのQRを読むと、表示ページが開きます。' +
        'QRが読めない場合は、上の文字列（URL）を相手の表示ページに貼り付けても接続できます。</div>' +
        '<div class="step">手順2: 相手の応答QRを読む</div>' +
        '<button class="act" id="tk-pair-scan">カメラで応答QRを読む</button>' +
        '<video id="tk-pair-video" playsinline muted></video>' +
        '<textarea id="tk-pair-answer-text" rows="3" placeholder="応答コードを貼り付けても接続できます"></textarea>' +
        '<button class="sub-act" id="tk-pair-accept">貼り付けた応答コードで接続</button>' +
        '<div class="err" id="tk-pair-err"></div>' +
        '<div class="info" id="tk-pair-info"></div>' +
        '<div class="note">サーバーを使わない方式のため、QRの往復（出す → 読む → 応答を読む）が必要です。' +
        '両方の端末を、同じWi-Fiか、片方の「インターネット共有」にそろえてください。</div>' +
        '<button class="sub-act" id="tk-pair-reset">最初からやり直す（リセット）</button>' +
        '<button class="sub-act" id="tk-pair-close">閉じる</button>' +
      '</div>';
    document.body.appendChild(panel);
    els.status = panel.querySelector("#tk-pair-status");
    els.diag = panel.querySelector("#tk-pair-diag");
    els.qr = panel.querySelector("#tk-pair-qr");
    els.offerText = panel.querySelector("#tk-pair-offer-text");
    els.answerText = panel.querySelector("#tk-pair-answer-text");
    els.video = panel.querySelector("#tk-pair-video");
    els.err = panel.querySelector("#tk-pair-err");
    els.info = panel.querySelector("#tk-pair-info");

    panel.querySelector("#tk-pair-close").addEventListener("click", closePanel);
    panel.querySelector("#tk-pair-gen").addEventListener("click", generateOffer);
    panel.querySelector("#tk-pair-scan").addEventListener("click", startScan);
    panel.querySelector("#tk-pair-accept").addEventListener("click", function () {
      acceptAnswer(els.answerText.value);
    });
    panel.querySelector("#tk-pair-reset").addEventListener("click", resetAll);

    TKP2P.onStatus = function (s) {
      setStatus(s);
      if (s === "connected") setErr("");
      else if (s === "icefailed") setErr(ICE_GUIDE);
    };
    TKP2P.onCandidates = function () { refreshDiag(); };
    setStatus(TKP2P.status);
    refreshDiag();
  }

  // 診断表示: この端末が集めたICE候補の概要（失敗時の切り分け用に小さく出す）
  function refreshDiag() {
    if (!els.diag) return;
    els.diag.textContent = "診断（この端末の接続候補）: " + TKP2P.candidateSummaryText();
  }

  function setStatus(s) {
    if (!els.status) return;
    els.status.textContent = "P2P接続: " + (STATUS_TEXT[s] || s);
    els.status.className = "status" + (s === "connected" ? " ok" : "");
  }

  function setErr(msg) { if (els.err) els.err.textContent = msg || ""; }
  function setInfo(msg) { if (els.info) els.info.textContent = msg || ""; }

  // 失敗時に出す案内（生の英語エラーをそのまま表示しない）
  var GUIDE = "うまくいきませんでした。両方の端末でページを再読み込みして、手順1から1回だけ、順番にやってみてください。";

  function displayUrl(code) {
    var u = new URL("display.html", window.location.href);
    u.hash = "tk=" + encodeURIComponent(code);
    return u.toString();
  }

  var lastOfferUrl = null;
  function generateOffer() {
    setErr("");
    setInfo("");
    // すでにオファーを出している場合は TKP2P 側で同じコードが返る（作り直されない）。
    // 最初からやり直すときだけ「最初からやり直す（リセット）」を使う。
    TKP2P.createOfferCode().then(function (code) {
      lastOfferUrl = displayUrl(code);
      window.__tkPair.getOfferUrl = function () { return lastOfferUrl; };
      els.qr.style.display = "block";
      TKQR.draw(els.qr, lastOfferUrl, 264);
      els.offerText.style.display = "block";
      els.offerText.value = lastOfferUrl;
    }).catch(function (e) {
      if (window.console && console.error) console.error("接続用QRの作成に失敗:", e);
      setErr(GUIDE);
    });
  }

  function acceptAnswer(text) {
    setErr("");
    setInfo("");
    if (!text || !text.trim()) { setErr("応答コードが空です"); return; }
    TKP2P.acceptAnswerCode(text).then(function (res) {
      if (res && res.alreadyApplied) {
        setInfo("その応答はすでに取り込み済みです。接続が進んでいるので、そのままお待ちください。");
      }
      // 接続完了は onStatus で表示される
    }).catch(function (e) {
      if (window.console && console.error) console.error("応答コードの取り込みに失敗:", e);
      // 読み取り不良など、対処が明確なものだけ内容を表示し、それ以外は案内文にする
      if (e && /読み取れませんでした|先に接続用QR/.test(e.message || "")) setErr(e.message);
      else setErr(GUIDE);
    });
  }

  // 明示的なリセット: 接続を破棄し、パネル表示も最初の状態に戻す
  function resetAll() {
    stopScan();
    try { TKP2P.reset(); } catch (e) {}
    lastOfferUrl = null;
    els.qr.style.display = "none";
    els.offerText.style.display = "none";
    els.offerText.value = "";
    els.answerText.value = "";
    setErr("");
    setStatus(TKP2P.status);
    refreshDiag();
    setInfo("リセットしました。手順1からやり直してください。");
  }

  // ---- カメラ読み取り（jsQR） ----
  function startScan() {
    setErr("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setErr("この環境ではカメラが使えません。応答コードの貼り付けを使ってください");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(function (stream) {
        scanStream = stream;
        els.video.srcObject = stream;
        els.video.style.display = "block";
        return els.video.play();
      })
      .then(function () {
        var cvs = document.createElement("canvas");
        var ctx = cvs.getContext("2d", { willReadFrequently: true });
        var tick = function () {
          if (!scanStream) return;
          if (els.video.readyState === els.video.HAVE_ENOUGH_DATA) {
            cvs.width = els.video.videoWidth;
            cvs.height = els.video.videoHeight;
            ctx.drawImage(els.video, 0, 0, cvs.width, cvs.height);
            var img = ctx.getImageData(0, 0, cvs.width, cvs.height);
            var found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (found && found.data) {
              stopScan();
              els.answerText.value = found.data;
              acceptAnswer(found.data);
              return;
            }
          }
          scanTimer = setTimeout(function () { requestAnimationFrame(tick); }, 120);
        };
        tick();
      })
      .catch(function () { setErr("カメラを起動できませんでした。応答コードの貼り付けを使ってください"); });
  }

  function stopScan() {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
    if (els.video) { els.video.style.display = "none"; els.video.srcObject = null; }
  }

  function openPanel() {
    if (!panel) buildPanel();
    panel.classList.add("open");
    setStatus(TKP2P.status);
  }
  function closePanel() {
    stopScan();
    if (panel) panel.classList.remove("open");
  }

  window.__tkOpenPairPanel = openPanel;
  window.__tkClosePairPanel = closePanel;
})();
