// ===== TimeKeeper iPhone同士連携（WebRTC P2P）コア =====
// サーバーなしで端末同士を直接つなぐ。接続の取り次ぎ（シグナリング）は
// 接続コード文字列（QRコード／貼り付け）の手動交換で行う。
// STUN等の外部サーバーは使わない（ホスト候補同士でローカル接続する）。
//
// 使い方:
//   操作側: TKP2P.createOfferCode() -> 接続コード（オファー）
//           TKP2P.acceptAnswerCode(code) で応答を取り込むと接続が始まる
//   表示側: TKP2P.acceptOfferCode(code) -> 応答コード（アンサー）を返す
//   状態送信: TKP2P.sendState(state)（操作側。未接続時は最新分だけ保持し、接続時に送る）
//   状態受信: TKP2P.onState = function (jsonText) {}（表示側）
//   状態変化: TKP2P.onStatus = function (status) {} status: idle|offering|waiting|connecting|connected|closed|error|icefailed
//             icefailed は「シグナリングは成立したが端末同士が届かなかった」状態（別ネットワーク等）
(function () {
  "use strict";

  function encodePayload(obj) {
    return LZString.compressToEncodedURIComponent(JSON.stringify(obj));
  }

  // コード文字列／URL（#tk=... や ?tk=...）のどちらからでも payload を取り出す
  function decodePayload(str) {
    if (!str) return null;
    str = String(str).trim();
    var m = str.match(/[#?&]tk=([^&\s]+)/);
    if (m) {
      try { str = decodeURIComponent(m[1]); } catch (e) { str = m[1]; }
    }
    try {
      var s = LZString.decompressFromEncodedURIComponent(str);
      if (!s) return null;
      return JSON.parse(s);
    } catch (e) { return null; }
  }

  function waitIceComplete(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === "complete") return resolve();
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(); } }, 6000);
      pc.addEventListener("icegatheringstatechange", function () {
        if (pc.iceGatheringState === "complete" && !done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  var TKP2P = {
    pc: null,
    dc: null,
    latestState: null,
    status: "idle",
    lastOfferCode: null,
    lastAnswerCode: null,
    answerApplied: false,   // 操作側: 応答を取り込み済みか（二重適用ガード用）
    acceptedOfferSdp: null, // 表示側: 取り込み済みオファーのSDP（二重適用ガード用）
    _offerPromise: null,    // オファー作成中のPromise（作成の二重実行ガード用）
    _answerPromise: null,   // 応答作成中のPromise
    onStatus: null,
    onState: null,

    _setStatus: function (s) {
      this.status = s;
      if (this.onStatus) { try { this.onStatus(s); } catch (e) {} }
    },

    _newPc: function () {
      if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; this.dc = null; }
      this.answerApplied = false;
      this.acceptedOfferSdp = null;
      if (this._iceTimer) { clearTimeout(this._iceTimer); this._iceTimer = null; }
      var pc = new RTCPeerConnection(); // iceServers なし = ホスト候補のみ
      var self = this;
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === "connected") self._setStatus("connected");
        else if (pc.connectionState === "failed") self._setStatus("icefailed");
        else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
          if (self.status === "connected") self._setStatus("closed");
        }
      };
      // ICEの失敗を汎用エラーと区別する（別ネットワーク等で相手に届かないケース）。
      // disconnected は一時的なこともあるため、少し待って回復しなければ失敗として案内する。
      pc.oniceconnectionstatechange = function () {
        var s = pc.iceConnectionState;
        if (s === "failed") {
          if (self._iceTimer) { clearTimeout(self._iceTimer); self._iceTimer = null; }
          self._setStatus("icefailed");
        } else if (s === "disconnected") {
          if (self._iceTimer) clearTimeout(self._iceTimer);
          self._iceTimer = setTimeout(function () {
            self._iceTimer = null;
            if (pc.iceConnectionState === "disconnected") self._setStatus("icefailed");
          }, 4000);
        } else {
          if (self._iceTimer) { clearTimeout(self._iceTimer); self._iceTimer = null; }
        }
      };
      this.pc = pc;
      return pc;
    },

    _wireChannel: function (dc) {
      var self = this;
      this.dc = dc;
      dc.onopen = function () {
        self._setStatus("connected");
        if (self.latestState) {
          try { dc.send(JSON.stringify({ type: "state", state: self.latestState })); } catch (e) {}
        }
      };
      dc.onclose = function () { if (self.status === "connected") self._setStatus("closed"); };
      dc.onmessage = function (ev) {
        if (self.onState) { try { self.onState(ev.data); } catch (e) {} }
      };
    },

    // ---- 明示的なリセット: 接続を破棄して最初の状態に戻す ----
    // やり直しはこのメソッド経由でのみ行う（他の処理が黙って接続を作り直さない）。
    reset: function () {
      if (this.pc) { try { this.pc.close(); } catch (e) {} }
      if (this._iceTimer) { clearTimeout(this._iceTimer); this._iceTimer = null; }
      this.pc = null;
      this.dc = null;
      this.lastOfferCode = null;
      this.lastAnswerCode = null;
      this.answerApplied = false;
      this.acceptedOfferSdp = null;
      this._offerPromise = null;
      this._answerPromise = null;
      this._setStatus("idle");
    },

    // ---- 操作側: オファーを作って接続コードを返す ----
    createOfferCode: function () {
      var self = this;
      // 作成中なら同じ処理を使い回す（接続オブジェクトを作り直さない）
      if (this._offerPromise) return this._offerPromise;
      // すでに出したオファーが生きている間は、同じコードを返す。
      // 最初からやり直したい場合は reset() を明示的に呼ぶこと
      // （パネルの「最初からやり直す（リセット）」ボタン）。
      if (this.pc && this.lastOfferCode && this.pc.signalingState !== "closed") {
        return Promise.resolve(this.lastOfferCode);
      }
      this._setStatus("offering");
      var pc = this._newPc();
      var dc = pc.createDataChannel("tk");
      this._wireChannel(dc);
      var p = pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { return waitIceComplete(pc); })
        .then(function () {
          var code = encodePayload({ v: 1, kind: "offer", sdp: pc.localDescription.sdp });
          self.lastOfferCode = code;
          self._setStatus("waiting");
          return code;
        })
        .catch(function (e) { self._setStatus("error"); throw e; });
      this._offerPromise = p;
      var clear = function () { if (self._offerPromise === p) self._offerPromise = null; };
      p.then(clear, clear);
      return p;
    },

    // ---- 操作側: 応答コードを取り込む ----
    acceptAnswerCode: function (codeStr) {
      var self = this;
      var obj = decodePayload(codeStr);
      if (!obj || obj.kind !== "answer" || !obj.sdp) {
        return Promise.reject(new Error("応答コードを読み取れませんでした"));
      }
      if (!this.pc) return Promise.reject(new Error("先に接続用QRを表示してください"));
      var pc = this.pc;
      // 二重適用ガード: すでに応答を取り込み済み（シグナリング状態が stable で
      // リモート説明が入っている）なら、例外にせず穏やかに無視する。
      // カメラ読み取りと貼り付けの両経路がここを通るので、両方にガードが効く。
      if (this.answerApplied || (pc.signalingState === "stable" && pc.remoteDescription)) {
        this.answerApplied = true;
        return Promise.resolve({ alreadyApplied: true });
      }
      if (pc.signalingState !== "have-local-offer") {
        return Promise.reject(new Error("先に接続用QRを表示してください"));
      }
      this._setStatus("connecting");
      return pc.setRemoteDescription({ type: "answer", sdp: obj.sdp })
        .then(function () {
          self.answerApplied = true;
          return { alreadyApplied: false };
        })
        .catch(function (e) {
          // 状態ずれで失敗しても、取り込み済みの状態になっていれば成功扱いにする
          if (pc.remoteDescription && pc.signalingState === "stable") {
            self.answerApplied = true;
            return { alreadyApplied: true };
          }
          if (window.console && console.error) console.error("応答の適用に失敗:", e);
          self._setStatus("error");
          throw e;
        });
    },

    // ---- 表示側: オファーコードを取り込んで応答コードを返す ----
    acceptOfferCode: function (codeStr) {
      var self = this;
      var obj = decodePayload(codeStr);
      if (!obj || obj.kind !== "offer" || !obj.sdp) {
        return Promise.reject(new Error("接続コードを読み取れませんでした"));
      }
      // 二重適用ガード: 同じオファーは一度だけ取り込み、同じ応答コードを返す
      if (this.acceptedOfferSdp === obj.sdp) {
        if (this._answerPromise) return this._answerPromise;
        if (this.lastAnswerCode) return Promise.resolve(this.lastAnswerCode);
      }
      this._setStatus("offering");
      var pc = this._newPc();
      this.acceptedOfferSdp = obj.sdp;
      pc.ondatachannel = function (ev) { self._wireChannel(ev.channel); };
      var p = pc.setRemoteDescription({ type: "offer", sdp: obj.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (ans) { return pc.setLocalDescription(ans); })
        .then(function () { return waitIceComplete(pc); })
        .then(function () {
          var code = encodePayload({ v: 1, kind: "answer", sdp: pc.localDescription.sdp });
          self.lastAnswerCode = code;
          self._setStatus("waiting");
          return code;
        })
        .catch(function (e) { self._setStatus("error"); throw e; });
      this._answerPromise = p;
      var clear = function () { if (self._answerPromise === p) self._answerPromise = null; };
      p.then(clear, clear);
      return p;
    },

    // ---- 操作側: 状態を送る（表示側の受信形式 {type:"state", state} に合わせる） ----
    sendState: function (state) {
      this.latestState = Object.assign({}, state, { sentAt: Date.now() });
      if (this.dc && this.dc.readyState === "open") {
        try { this.dc.send(JSON.stringify({ type: "state", state: this.latestState })); } catch (e) {}
      }
    },

    isOpen: function () { return !!(this.dc && this.dc.readyState === "open"); }
  };

  // ---- QR描画ヘルパー（qrcode-generator使用） ----
  function drawQR(canvas, text, targetSize) {
    var qr = qrcode(0, "L");
    qr.addData(text, "Byte");
    qr.make();
    var n = qr.getModuleCount();
    var quiet = 4;
    var total = n + quiet * 2;
    var scale = Math.max(2, Math.floor((targetSize || 264) / total));
    canvas.width = total * scale;
    canvas.height = total * scale;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return { modules: n, scale: scale };
  }

  window.TKP2P = TKP2P;
  window.TKQR = { draw: drawQR, encodePayload: encodePayload, decodePayload: decodePayload };

  // テスト・検証用フック（カメラの代わりにコード文字列を直接受け渡すためにも使う）
  window.__tkPair = {
    createOfferCode: function () { return TKP2P.createOfferCode(); },
    acceptAnswerCode: function (code) { return TKP2P.acceptAnswerCode(code); },
    acceptOfferCode: function (code) { return TKP2P.acceptOfferCode(code); },
    getOfferCode: function () { return TKP2P.lastOfferCode; },
    getAnswerCode: function () { return TKP2P.lastAnswerCode; },
    status: function () { return TKP2P.status; },
    isOpen: function () { return TKP2P.isOpen(); },
    reset: function () { TKP2P.reset(); },
    signalingState: function () { return TKP2P.pc ? TKP2P.pc.signalingState : null; },
    answerApplied: function () { return TKP2P.answerApplied; },
    pc: function () { return TKP2P.pc; },
    decodePayload: decodePayload
  };
})();
