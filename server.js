"use strict";
/* =====================================================================
   Emoji Tahmin + Bingo — sunucu
   Oyunun tüm mantığı ve durumu burada tutulur. Tarayıcılar sadece
   ekranı çizer; doğru cevap, ipucu ve başkalarının tahminleri
   oyunculara yalnızca izin verilen anda gönderilir.
   ===================================================================== */
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

/* ---------------------------------------------------------------------
   AYARLAR VE İÇERİK
   --------------------------------------------------------------------- */
const ON_RENDER = !!process.env.RENDER;
// Yönetici PIN'i ortam değişkeninden gelir. Yerelde ayarlanmamışsa 1234 kullanılır;
// Render'da ayarlanmamışsa yönetici girişi kapalı kalır (güvenlik için).
const ADMIN_PIN = String(process.env.ADMIN_PIN || (ON_RENDER ? "" : "1234")).trim();

const LIMITS = { name: 20, guess: 60, guessesPerRound: 40, players: 100, qText: 100000, bingoText: 5000 };

function readContent(file, fallback){
  try{ const t = fs.readFileSync(path.join(__dirname, "icerik", file), "utf8").replace(/\r/g, "").trim(); return t || fallback; }
  catch(e){ return fallback; }
}
const DEFAULT_QS = readContent("sorular.txt", "🦁👑🌅 | Aslan Kral | 🌍 Film | 🐗🐒");
const DEFAULT_BINGO = readContent("bingo.txt", "“Sesim geliyor mu?”");
const DEFAULT_SETTINGS = (function(){
  const base = { duration: 90, numQ: 20, shuffle: true, showCat: true, pts: "3,2,1", bingoPts: "5,3,2", bingoExtra: 1 };
  let j = {};
  try{ j = JSON.parse(readContent("ayarlar.json", "{}")); }catch(e){ console.warn("icerik/ayarlar.json okunamadı, varsayılan ayarlar kullanılıyor:", e.message); }
  return sanitizeSettings({
    duration: j.soruSuresiSaniye, numQ: j.soruSayisi, shuffle: j.karisikSira, showCat: j.kategoriyiGoster,
    pts: j.dogruTahminPuanlari, bingoPts: j.bingoPuanlari, bingoExtra: j.sonrakiHerBingoPuani
  }, base);
})();

/* ---------------------------------------------------------------------
   YARDIMCILAR (prototipteki ile aynı)
   --------------------------------------------------------------------- */
function uid(p){ return (p || "") + Date.now().toString(36) + crypto.randomBytes(4).toString("hex"); }
function secret(){ return crypto.randomBytes(24).toString("hex"); }
function nums(s, def){ const a = String(s == null ? "" : s).split(/[,;\s]+/).map(x => parseInt(x, 10)).filter(x => !isNaN(x) && x >= 0).map(x => Math.min(x, 99)); return a.length ? a : def; }
function three(s, def){ const a = nums(s, def).slice(0, 3); while(a.length < 3) a.push(a[a.length - 1]); return a; }
function cleanPts(s, def){ return /^[\d\s,;]+$/.test(String(s == null ? "" : s)) ? three(s, def).join(",") : def.join(","); }
function clampInt(v, min, max, def){ const n = parseInt(v, 10); return isNaN(n) ? def : Math.max(min, Math.min(max, n)); }
function norm(s){
  return String(s || "").toLocaleLowerCase("tr").replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}
function nameKey(n){ return norm(n) || String(n).toLocaleLowerCase("tr").replace(/\s+/g, ""); }
function lev(a, b){
  if(a === b) return 0; if(!a.length) return b.length; if(!b.length) return a.length;
  let prev = [], cur, i, j; for(j = 0; j <= b.length; j++) prev[j] = j;
  for(i = 1; i <= a.length; i++){ cur = [i]; for(j = 1; j <= b.length; j++){ cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1)); } prev = cur; }
  return prev[b.length];
}
function parseQs(text){
  return String(text).split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const p = l.split("|").map(x => x.trim());
    return { emojis: p[0] || "❓", answer: p[1] || "", cat: p[2] || "", extra: p[3] || "" };
  });
}
function answerVariants(ans){
  const out = [ans], m = ans.match(/^(.*?)\s*\((.*)\)\s*$/);
  if(m){ out.push(m[1]); m[2].split(/[\/,]/).forEach(x => out.push(x)); }
  out.slice().forEach(x => { const t = x.replace(/^\s*the\s+/i, ""); if(t !== x) out.push(t); });
  return out.map(norm).filter(x => x.length);
}
function isCorrect(guess, ans){
  const g = norm(guess); if(!g) return false;
  return answerVariants(ans).some(a => {
    if(g === a) return true;
    const tol = a.length >= 9 ? 2 : a.length >= 5 ? 1 : 0;
    if(tol && lev(g, a) <= tol) return true;
    if(a.length >= 6 && g.indexOf(a) !== -1 && g.length <= a.length + 6) return true;
    return false;
  });
}
const LINES = (function(){ const L = []; for(let i = 0; i < 4; i++){ L.push([i*4,i*4+1,i*4+2,i*4+3]); L.push([i,i+4,i+8,i+12]); } L.push([0,5,10,15]); L.push([3,6,9,12]); return L; })();
function lineCount(marks){ return LINES.filter(l => l.every(i => marks.indexOf(i) !== -1)).length; }

// Metin temizleme: kontrol karakterlerini atar, uzunluğu (emoji dahil) karakter sayısıyla sınırlar
function cleanText(v, max){
  if(typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").trim();
  return Array.from(s).slice(0, max).join("").trim();
}
function sanitizeSettings(s, base){
  s = s || {}; base = base || DEFAULT_SETTINGS;
  return {
    duration: clampInt(s.duration, 10, 600, base.duration),
    numQ: clampInt(s.numQ, 1, 100, base.numQ),
    shuffle: s.shuffle == null ? base.shuffle : !!s.shuffle,
    showCat: s.showCat == null ? base.showCat : !!s.showCat,
    pts: cleanPts(s.pts == null ? base.pts : s.pts, nums(base.pts, [3,2,1])),
    bingoPts: cleanPts(s.bingoPts == null ? base.bingoPts : s.bingoPts, nums(base.bingoPts, [5,3,2])),
    bingoExtra: clampInt(s.bingoExtra, 0, 99, base.bingoExtra)
  };
}

/* ---------------------------------------------------------------------
   OYUN DURUMU (prototipteki "Host" modülü)
   --------------------------------------------------------------------- */
let G = null, lastHint = false;
let io = null;                     // Socket.IO sunucusu (start() içinde atanır)
const conns = new Map();            // oyuncu id → açık bağlantı sayısı
const adminSessions = new Set();    // geçerli yönetici oturum anahtarları

function fresh(){
  const old = G || {};
  return {
    settings: Object.assign({}, DEFAULT_SETTINGS, old.settings || {}),
    qText: old.qText || DEFAULT_QS, bingoText: old.bingoText || DEFAULT_BINGO,
    phase: "lobby", order: [], pos: -1, round: null,
    players: old.players ? Object.keys(old.players).reduce((o, k) => { const p = old.players[k]; o[k] = { id: p.id, name: p.name, token: p.token, bot: p.bot, pts: 0, bonus: 0, marks: [], bingoAt: 0, lines: 0, flashUntil: 0 }; return o; }, {}) : {},
    guesses: {}, awards: {}, chat: [], bingoWinners: [], reveal: null
  };
}
function bots(){ return Object.keys(G.players).filter(k => G.players[k].bot); }
function removeBots(){ bots().forEach(k => { delete G.players[k]; }); recomputeBingo(); }

let qCache = { text: null, list: [] };
function qs(){ if(qCache.text !== G.qText) qCache = { text: G.qText, list: parseQs(G.qText) }; return qCache.list; }
function bingoItems(){ const a = String(G.bingoText).split("\n").map(x => x.trim()).filter(Boolean).slice(0, 16); while(a.length < 16) a.push("—"); return a; }
function curQ(){ const list = qs(), i = G.order[G.pos]; return G.pos >= 0 && i != null && list[i] ? list[i] : null; }
function elapsed(){ const r = G.round; if(!r) return 0; return r.acc + (r.runningSince ? Date.now() - r.runningSince : 0); }
function durMs(){ return (G.round ? G.round.duration : G.settings.duration) * 1000; }
// İpucu sürenin yarısında açılır; bir kez açıldıysa (+30 sn eklense bile) açık kalır
function hintOn(){ return G.phase === "question" && !!G.round && (G.round.hintShown || elapsed() >= durMs() / 2); }
function ptsFor(rank){ const a = nums(G.settings.pts, [3,2,1]); const v = a[Math.min(rank, a.length - 1)]; return G.settings.showCat ? v : v * 2; }
function bingoPtsFor(rank){ const a = nums(G.settings.bingoPts, [5,3,2]); return a[Math.min(rank, a.length - 1)]; }
function online(p){ return !!p.bot || (conns.get(p.id) || 0) > 0; }
function sys(type, text, extra){ G.chat.push(Object.assign({ id: uid("m"), type: type, text: text, t: Date.now() }, extra || {})); if(G.chat.length > 200) G.chat.splice(0, G.chat.length - 200); }
function roundGuesses(){ return G.guesses[G.pos] || (G.guesses[G.pos] = {}); }

/* ---- yayın ---- */
function publicState(){
  const q = curQ(), ps = Object.keys(G.players).map(k => G.players[k]);
  const rg = G.guesses[G.pos] || {};
  return {
    phase: G.phase, pos: G.pos, total: G.order.length || Math.min(G.settings.numQ, qs().length),
    q: q && G.phase !== "lobby" ? {
      emojis: q.emojis,
      cat: G.settings.showCat ? q.cat : "",
      extra: (hintOn() || G.phase === "reveal" || G.phase === "final") ? q.extra : "",
      answer: G.phase === "reveal" || G.phase === "final" ? q.answer : ""
    } : null,
    round: G.round ? { acc: G.round.acc, runningSince: G.round.runningSince, duration: G.round.duration, now: Date.now() } : null,
    showCat: G.settings.showCat,
    players: ps.map(p => {
      const mine = rg[p.id] || [];
      return { id: p.id, name: p.name, pts: p.pts, bonus: p.bonus, total: p.pts + p.bonus, online: online(p), bingo: !!p.bingoAt,
               guessed: mine.length > 0, flash: p.flashUntil > Date.now() };
    }),
    reveal: G.reveal,
    chat: G.chat.slice(-120).map(m => ({ id: m.id, type: m.type, text: m.text, name: m.name, pid: m.pid, t: m.t })),
    bingo: bingoItems(),
    bingoWinners: G.bingoWinners.map(id => G.players[id] ? G.players[id].name : "?"),
    ptsInfo: nums(G.settings.pts, [3,2,1]).join(" / "), bingoInfo: nums(G.settings.bingoPts, [5,3,2]).join(" / ") + (+G.settings.bingoExtra ? " · sonraki her bingo +" + G.settings.bingoExtra : "")
  };
}
// Bir oyuncuya giden özel durum: sadece kendi tahminleri ve kendi bingo işaretleri
function privateFor(k, order){
  const p = G.players[k]; if(!p) return null;
  const rg = G.guesses[G.pos] || {}, log = [];
  Object.keys(G.guesses).forEach(pos => { ((G.guesses[pos] || {})[k] || []).forEach(g => { log.push({ pos: +pos, text: g.text, ok: g.ok, t: g.t }); }); });
  const mine = rg[k] || [];
  return { marks: p.marks, log: log, guesses: mine.map(g => ({ text: g.text, ok: g.ok })),
           rank: mine.some(g => g.ok) ? order.indexOf(k) + 1 : 0 };
}
function adminState(){
  const q = curQ(), rg = G.guesses[G.pos] || {}, list = [];
  Object.keys(rg).forEach(pid => { (rg[pid] || []).forEach((g, gi) => { list.push({ pid: pid, gi: gi, name: G.players[pid] ? G.players[pid].name : "?", text: g.text, ok: g.ok, ms: g.t - (G.round ? G.round.startedAt : g.t) }); }); });
  list.sort((a, b) => a.ms - b.ms);
  const markCount = new Array(16).fill(0);
  Object.keys(G.players).forEach(k => { (G.players[k].marks || []).forEach(i => { markCount[i]++; }); });
  return { answer: q ? q.answer : "", guesses: list, markCount: markCount, settings: G.settings, qText: G.qText, bingoText: G.bingoText, running: !!(G.round && G.round.runningSince), botsOn: bots().length > 0 };
}

let flushPending = false;
function broadcast(){ if(flushPending || !io) return; flushPending = true; setImmediate(flush); }
function flush(){
  flushPending = false;
  const pub = publicState(), order = correctOrder();
  let adm = null;
  for(const s of io.of("/").sockets.values()) sendState(s, pub, order, () => adm || (adm = adminState()));
}
function sendState(s, pub, order, admFn){
  pub = pub || publicState(); order = order || correctOrder();
  s.emit("state", { pub: pub, priv: s.data.pid ? privateFor(s.data.pid, order) : null });
  if(s.data.admin) s.emit("adminState", { st: admFn ? admFn() : adminState() });
}
function noticeSocket(s, text, extra){ s.emit("notice", Object.assign({ text: text || "" }, extra || {})); }
function socketsOf(pid){ const out = []; if(!io) return out; for(const s of io.of("/").sockets.values()) if(s.data.pid === pid) out.push(s); return out; }
function noticePlayer(pid, text, extra){ socketsOf(pid).forEach(s => noticeSocket(s, text, extra)); }

/* ---- oyun akışı ---- */
function correctOrder(){
  const rg = G.guesses[G.pos] || {}, arr = [];
  Object.keys(rg).forEach(pid => { const ok = (rg[pid] || []).filter(g => g.ok)[0]; if(ok) arr.push({ pid: pid, t: ok.t }); });
  arr.sort((a, b) => a.t - b.t);
  return arr.map(x => x.pid);
}
function startGame(){
  const n = qs().length, k = Math.max(1, Math.min(+G.settings.numQ || 20, n)), idx = [];
  if(!n) return false;
  for(let i = 0; i < n; i++) idx.push(i);
  if(G.settings.shuffle){ for(let j = n - 1; j > 0; j--){ const r = crypto.randomInt(j + 1); const t = idx[j]; idx[j] = idx[r]; idx[r] = t; } }
  G.order = idx.slice(0, k); G.pos = -1; G.guesses = {}; G.awards = {}; G.bingoWinners = []; G.reveal = null;
  Object.keys(G.players).forEach(id => { const p = G.players[id]; p.pts = 0; p.bonus = 0; p.marks = []; p.bingoAt = 0; p.lines = 0; });
  sys("sys", "🚀 Oyun başladı! " + k + " soru, her biri " + G.settings.duration + " saniye.");
  nextQuestion();
  return true;
}
// Bir soruyu (yeniden) başlatır: o soruya ait eski tahminler ve verilmiş puanlar temizlenir,
// böylece aynı soru tekrar oynanınca puan iki kez sayılmaz.
function startRoundAt(pos){
  G.awards = G.awards || {};
  (G.awards[pos] || []).forEach(a => { const p = G.players[a.id]; if(p) p.pts = Math.max(0, p.pts - a.pts); });
  delete G.awards[pos]; delete G.guesses[pos];
  G.pos = pos; G.phase = "question"; G.reveal = null; lastHint = false;
  G.round = { duration: +G.settings.duration || 90, acc: 0, runningSince: Date.now(), startedAt: Date.now(), hintShown: false };
  sys("sys", "Soru " + (G.pos + 1) + " / " + G.order.length + " başladı ⏱");
  broadcast();
}
function nextQuestion(){
  if(G.pos + 1 >= G.order.length){ finalize(); return; }
  startRoundAt(G.pos + 1);
}
function prevQuestion(){
  if(!(G.phase === "question" || G.phase === "reveal") || G.pos <= 0) return;
  if(G.phase === "question" && G.round){ G.round.acc = elapsed(); G.round.runningSince = null; }
  sys("sys", "⏮ Önceki soruya dönüldü");
  startRoundAt(G.pos - 1);
}
function endRound(){
  if(G.phase !== "question") return;
  const r = G.round; r.acc = elapsed(); r.runningSince = null;
  const order = correctOrder(), q = curQ(), rg = roundGuesses(), list = [];
  order.forEach((pid, i) => {
    const p = G.players[pid]; if(!p) return;
    const pts = ptsFor(i); p.pts += pts; p.flashUntil = Date.now() + 2500;
    const ok = (rg[pid] || []).filter(g => g.ok)[0];
    list.push({ id: pid, name: p.name, pts: pts, ms: ok.t - r.startedAt });
  });
  G.phase = "reveal"; G.reveal = { winners: list };
  G.awards = G.awards || {}; G.awards[G.pos] = list.map(w => ({ id: w.id, pts: w.pts }));
  sys("reveal", "✅ Doğru cevap: " + (q ? q.answer : "?") + (list.length ? " · " + list.map((w, i) => (i + 1) + ". " + w.name + " +" + w.pts).join(", ") : " · Kimse bilemedi 😅"));
  broadcast();
}
function endRoundSilent(){ const c = G.chat.length; endRound(); G.chat.splice(c, 1); }
function finalize(){
  if(G.phase === "question") endRound();
  G.phase = "final"; sys("sys", "🏁 Oyun bitti! Final sıralaması ekranda."); broadcast();
}
function togglePause(){
  if(G.phase !== "question" || !G.round) return;
  const r = G.round;
  if(r.runningSince){ r.acc = elapsed(); r.runningSince = null; sys("sys", "⏸ Süre durduruldu"); }
  else { r.runningSince = Date.now(); sys("sys", "▶ Süre devam ediyor"); }
  broadcast();
}
function addTime(){ if(G.phase === "question" && G.round){ G.round.duration += 30; sys("sys", "⏱ +30 saniye eklendi"); broadcast(); } }
function skip(){
  if(G.phase === "lobby" || G.phase === "final") return;
  if(G.phase === "question"){ const q = curQ(); G.round.acc = elapsed(); G.round.runningSince = null; sys("sys", "⏭ Soru atlandı (" + (q ? q.answer : "?") + ")"); }
  nextQuestion();
}
function recomputeBingo(){
  const ws = Object.keys(G.players).map(k => G.players[k]).filter(p => p.bingoAt).sort((a, b) => a.bingoAt - b.bingoAt);
  Object.keys(G.players).forEach(k => { G.players[k].bonus = 0; });
  const extra = +G.settings.bingoExtra || 0;
  ws.forEach((p, i) => { p.bonus = bingoPtsFor(i) + Math.max(0, (p.lines || 1) - 1) * extra; });
  G.bingoWinners = ws.map(p => p.id);
}

/* ---- oyuncu eylemleri ---- */
function doGuess(p, rawText, reply){
  if(G.phase !== "question"){ reply("Şu an tahmin alınmıyor."); return; }
  if(!G.round.runningSince){ reply("Süre durduruldu, biraz bekle."); return; }
  const q = curQ(); if(!q) return;
  const text = cleanText(rawText, LIMITS.guess); if(!text) return;
  const rg = roundGuesses(), mine = rg[p.id] || (rg[p.id] = []);
  if(mine.some(g => g.ok)){ reply("Bu soruyu zaten bildin 🎉"); return; }
  if(mine.length >= LIMITS.guessesPerRound){ reply("Bu soru için çok fazla tahmin yaptın, biraz yavaş 🙂"); return; }
  const ok = isCorrect(text, q.answer);
  mine.push({ text: text, ok: ok, t: Date.now() });
  if(ok){ const rank = correctOrder().indexOf(p.id) + 1; sys("correct", "🎉 " + p.name + " doğru cevabı buldu! (" + rank + ". sıra)", { pid: p.id }); p.flashUntil = Date.now() + 2000; }
  broadcast();
}
function doMark(p, rawMarks, reply, notify){
  if(G.phase === "lobby"){ reply("Bingo oyun başlayınca açılacak."); return; }
  const marks = (Array.isArray(rawMarks) ? rawMarks : []).slice(0, 32)
    .map(i => typeof i === "number" ? i : parseInt(i, 10)).filter(i => Number.isInteger(i) && i >= 0 && i < 16);
  p.marks = marks.filter((v, i, a) => a.indexOf(v) === i);
  const lc = lineCount(p.marks);
  if(p.bingoAt && lc > (p.lines || 1)){
    const gained = lc - (p.lines || 1); p.lines = lc; recomputeBingo();
    const add = gained * (+G.settings.bingoExtra || 0);
    sys("bingo", "🎯 " + p.name + " bir bingo daha yaptı! (" + lc + ". bingosu)" + (add ? " · +" + add + " puan" : ""), { pid: p.id });
    p.flashUntil = Date.now() + 2500;
    notify({ bingo: true, extra: add });
  }
  if(!p.bingoAt && lc){
    p.bingoAt = Date.now(); p.lines = lc; recomputeBingo();
    const rk = G.bingoWinners.indexOf(p.id);
    sys("bingo", "🎯 " + p.name + " BİNGO yaptı! " + (rk + 1) + ". bingo · +" + p.bonus + " puan", { pid: p.id });
    p.flashUntil = Date.now() + 2500;
    notify({ bingo: true });
  }
  broadcast();
}

/* ---- yönetici komutları (sadece PIN'le giriş yapmış bağlantılar) ---- */
const cmd = {
  start: function(){ if(G.phase === "lobby" || G.phase === "final") startGame(); },
  pause: togglePause, plus: addTime, end: endRound,
  next: function(){ if(G.phase === "reveal") nextQuestion(); else if(G.phase === "question") endRound(); },
  skip: skip, prev: prevQuestion,
  final: function(){ if(G.phase !== "lobby" && G.phase !== "final") finalize(); },
  kick: function(reply, id){
    const p = G.players[id]; if(!p) return;
    delete G.players[id]; recomputeBingo(); sys("sys", "🚪 " + p.name + " oyundan çıkarıldı");
    socketsOf(id).forEach(s => { noticeSocket(s, "Yönetici seni oyundan çıkardı.", { kicked: true }); s.data.pid = null; });
    conns.delete(id);
    broadcast();
  },
  override: function(reply, pid, gi, ok){
    if(G.phase !== "question" && G.phase !== "reveal") return;
    const rg = roundGuesses(); if(typeof pid !== "string" || !rg[pid] || !rg[pid][gi]) return; rg[pid][gi].ok = !!ok;
    if(G.phase === "reveal"){ // puanları yeniden hesapla
      const prev = (G.reveal && G.reveal.winners) || []; prev.forEach(w => { if(G.players[w.id]) G.players[w.id].pts -= w.pts; });
      G.phase = "question"; G.round.runningSince = null; endRoundSilent();
    }
    broadcast();
  },
  cancelBingo: function(reply, id){
    const p = G.players[id]; if(!p || !p.bingoAt) return;
    p.bingoAt = 0; p.lines = 0; p.marks = []; recomputeBingo();
    sys("sys", "❌ " + p.name + " adlı oyuncunun bingosu iptal edildi");
    noticePlayer(id, "Bingon yönetici tarafından iptal edildi, kartın sıfırlandı.");
    broadcast();
  },
  saveSettings: function(reply, s){
    s = s && typeof s === "object" ? s : {};
    const qText = typeof s.qText === "string" ? s.qText.replace(/\r/g, "").slice(0, LIMITS.qText) : "";
    const bingoText = typeof s.bingoText === "string" ? s.bingoText.replace(/\r/g, "").slice(0, LIMITS.bingoText) : "";
    const newQ = qText.trim() && parseQs(qText).length ? qText : DEFAULT_QS;
    const newB = bingoText.trim() ? bingoText : DEFAULT_BINGO;
    const bingoChanged = newB !== G.bingoText;
    G.settings = sanitizeSettings(s.settings, G.settings); G.qText = newQ; G.bingoText = newB;
    if(bingoChanged){ Object.keys(G.players).forEach(k => { G.players[k].marks = []; G.players[k].bingoAt = 0; G.players[k].lines = 0; }); if(G.phase !== "lobby") sys("sys", "🎯 Bingo kartı güncellendi, işaretler sıfırlandı"); }
    recomputeBingo(); broadcast(); reply("Ayarlar kaydedildi");
  },
  reset: function(reply){ G = fresh(); removeBots(); G.chat = []; lastHint = false; broadcast(); reply("Oyun sıfırlandı"); },   // akış da tamamen temizlenir
  bots: function(reply){
    if(bots().length){ removeBots(); broadcast(); reply("Demo oyuncular kaldırıldı"); return; }
    ["Ayşe","Mehmet","Zeynep","Can"].forEach(n => {
      let name = n, i = 2;
      while(i < 100 && Object.keys(G.players).some(k => nameKey(G.players[k].name) === nameKey(name))){ name = n + " " + i; i++; }
      const id = uid("bot"); G.players[id] = { id: id, name: name, bot: true, pts: 0, bonus: 0, marks: [], bingoAt: 0, lines: 0, flashUntil: 0 };
      sys("sys", "👋 " + name + " oyuna katıldı");
    });
    broadcast(); reply("4 demo oyuncu eklendi 🤖");
  }
};
const SIMPLE_CMDS = ["start", "pause", "plus", "end", "next", "skip", "prev", "final"];

/* ---- demo botlar ---- */
function botTick(){
  const ids = bots();
  if(!ids.length || G.phase === "lobby") return;
  ids.forEach(id => {
    const p = G.players[id]; if(!p) return;
    if(G.phase === "question" && G.round.runningSince && Math.random() < 0.05){
      const rg = roundGuesses(), mine = rg[id] || [], q = curQ();
      if(q && !mine.some(g => g.ok) && mine.length < 4){
        const list = qs();
        const txt = Math.random() < 0.45 ? q.answer.replace(/\s*\(.*\)$/, "") : list[Math.floor(Math.random() * list.length)].answer.replace(/\s*\(.*\)$/, "");
        doGuess(p, txt, () => {});
      }
    }
    if(Math.random() < 0.01 && !p.bingoAt){ const mk = p.marks.slice(), c = Math.floor(Math.random() * 16); if(mk.indexOf(c) === -1) mk.push(c); doMark(p, mk, () => {}, () => {}); }
  });
}

/* ---- zamanlayıcı: süre sunucu saatine göre işler ---- */
function tick(){
  botTick();
  if(G.phase === "question" && G.round){
    if(G.round.runningSince && elapsed() >= durMs()){ sys("sys", "⏰ Süre doldu!"); endRound(); return; }
    const h = hintOn();
    if(h !== lastHint){ lastHint = h; if(h){ G.round.hintShown = true; sys("sys", "💡 Ekstra ipucu açıldı!"); } broadcast(); }
  }
}

/* ---------------------------------------------------------------------
   BAĞLANTILAR
   --------------------------------------------------------------------- */
function makeLimiter(rate, burst){
  let tokens = burst, last = Date.now();
  return function(){ const now = Date.now(); tokens = Math.min(burst, tokens + (now - last) / 1000 * rate); last = now; if(tokens < 1) return false; tokens -= 1; return true; };
}
const pinFails = new Map();   // ip → { n, until }
function clientIp(socket){
  const xf = socket.handshake.headers["x-forwarded-for"];
  return (xf ? String(xf).split(",")[0] : socket.handshake.address || "").trim();
}
function pinOk(pin){
  const a = crypto.createHash("sha256").update(String(pin || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(a, b);
}
function findByToken(tok){
  if(typeof tok !== "string" || tok.length < 20 || tok.length > 100) return null;
  for(const k of Object.keys(G.players)){ const p = G.players[k]; if(p.token && p.token === tok) return p; }
  return null;
}
function bind(socket, p){
  if(socket.data.pid === p.id) return;
  unbind(socket);
  socket.data.pid = p.id; conns.set(p.id, (conns.get(p.id) || 0) + 1);
  broadcast();
}
function unbind(socket){
  const pid = socket.data.pid; if(!pid) return;
  socket.data.pid = null;
  const n = (conns.get(pid) || 1) - 1; if(n > 0) conns.set(pid, n); else conns.delete(pid);
  broadcast();
}
// Bağlantı bir oyuncuya bağlı değilse, mesajdaki gizli anahtarla (token) yeniden bağlanır
function playerFor(socket, m){
  if(socket.data.admin) return null;
  let p = socket.data.pid ? G.players[socket.data.pid] : null;
  if(!p && m && m.token){ p = findByToken(m.token); if(p) bind(socket, p); }
  return p;
}

function onConnection(socket){
  socket.data.pid = null; socket.data.admin = false; socket.data.session = null;
  const allow = makeLimiter(10, 40);
  function on(ev, fn){
    socket.on(ev, function(m, ack){
      if(typeof m === "function"){ ack = m; m = {}; }
      if(!m || typeof m !== "object") m = {};
      if(typeof ack !== "function") ack = null;
      if(!allow()){ if(ack) ack({ ok: false, error: "Çok hızlı, biraz yavaş 🙂" }); return; }
      try{ fn(m, ack); }catch(e){ console.error("[" + ev + "]", e); }
    });
  }
  const reply = t => { if(t) noticeSocket(socket, t); };

  on("hello", function(m){
    if(socket.data.admin) return;
    const p = findByToken(m.token);
    if(p){ bind(socket, p); noticeSocket(socket, "", { joined: true, id: p.id, name: p.name }); }
    else if(m.token){ noticeSocket(socket, "", { joined: false }); }
    sendState(socket);
  });
  on("ping", function(m, ack){
    if(ack) ack({ t: Date.now() });   // saat eşitleme için sunucu zamanı
    if(m.token) playerFor(socket, m);
  });
  on("join", function(m){
    if(socket.data.admin) return;
    const name = cleanText(m.name, LIMITS.name).replace(/\s+/g, " ");
    if(Array.from(name).length < 2){ noticeSocket(socket, "İsim en az 2 harf olmalı.", { joinError: true }); return; }
    const p = playerFor(socket, m);
    const taken = Object.keys(G.players).some(k => (!p || k !== p.id) && nameKey(G.players[k].name) === nameKey(name));
    if(taken){ noticeSocket(socket, "Bu isim alınmış, başka bir isim dene.", { joinError: true }); return; }
    if(p){ p.name = name; noticeSocket(socket, "", { joined: true, id: p.id, name: name }); broadcast(); return; }
    if(Object.keys(G.players).length >= LIMITS.players){ noticeSocket(socket, "Oda dolu.", { joinError: true }); return; }
    const np = { id: uid("p"), token: secret(), name: name, pts: 0, bonus: 0, marks: [], bingoAt: 0, lines: 0, flashUntil: 0 };
    G.players[np.id] = np;
    sys("sys", "👋 " + name + " oyuna katıldı");
    bind(socket, np);
    noticeSocket(socket, "", { joined: true, id: np.id, name: name, token: np.token });
    broadcast();
  });
  on("guess", function(m){
    const p = playerFor(socket, m); if(!p) return;
    doGuess(p, m.text, reply);
  });
  on("mark", function(m){
    const p = playerFor(socket, m); if(!p) return;
    doMark(p, m.marks, reply, extra => noticePlayer(p.id, "", extra));
  });

  /* yönetici girişi: PIN ya da daha önce verilmiş oturum anahtarı ile */
  on("admin", function(m, ack){
    ack = ack || function(){};
    if(m.session && typeof m.session === "string" && adminSessions.has(m.session)){ grant(m.session); return; }
    if(!ADMIN_PIN){ ack({ ok: false, error: "Sunucuda ADMIN_PIN ayarlanmamış." }); return; }
    const ip = clientIp(socket), f = pinFails.get(ip);
    if(f && f.until > Date.now()){ ack({ ok: false, error: "Çok fazla hatalı deneme. " + Math.ceil((f.until - Date.now()) / 1000) + " sn sonra tekrar dene." }); return; }
    if(typeof m.pin === "string" && pinOk(m.pin.trim())){ pinFails.delete(ip); const ses = secret(); adminSessions.add(ses); grant(ses); return; }
    const n = (f && f.until <= Date.now() && f.n >= 5 ? 0 : (f ? f.n : 0)) + 1;
    pinFails.set(ip, { n: n, until: n >= 5 ? Date.now() + 60000 : 0 });
    ack({ ok: false, error: "PIN hatalı." });
    function grant(ses){
      unbind(socket);
      socket.data.admin = true; socket.data.session = ses;
      ack({ ok: true, session: ses });
      sendState(socket);
    }
  });
  on("adminLogout", function(){
    if(socket.data.session) adminSessions.delete(socket.data.session);
    socket.data.admin = false; socket.data.session = null;
  });
  on("cmd", function(m){
    if(!socket.data.admin){ noticeSocket(socket, "Bu işlem için yönetici girişi gerekli."); return; }
    const name = m.name, args = Array.isArray(m.args) ? m.args.slice(0, 3) : [];
    if(!Object.prototype.hasOwnProperty.call(cmd, name)) return;
    if(SIMPLE_CMDS.indexOf(name) !== -1) cmd[name]();
    else cmd[name].apply(null, [reply].concat(args));
  });

  socket.on("disconnect", function(){ unbind(socket); });
  sendState(socket);
}

/* ---------------------------------------------------------------------
   BAŞLAT
   --------------------------------------------------------------------- */
function start(port){
  G = fresh(); lastHint = false; conns.clear(); adminSessions.clear(); pinFails.clear();
  sys("sys", "🎮 Oyun odası açıldı. Oyuncular bekleniyor…");

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.get("/healthz", (req, res) => res.type("text").send("ok"));
  app.use(express.static(path.join(__dirname, "public")));

  const server = http.createServer(app);
  io = new Server(server, { maxHttpBufferSize: 256 * 1024, pingInterval: 20000, pingTimeout: 20000 });
  io.on("connection", onConnection);

  const t1 = setInterval(() => { try{ tick(); }catch(e){ console.error(e); } }, 250);
  const t2 = setInterval(() => broadcast(), 5000);   // çevrimiçi durumunu tazele

  return new Promise(resolve => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        close: () => new Promise(r => { clearInterval(t1); clearInterval(t2); io.close(); server.close(() => r()); })
      });
    });
  });
}

module.exports = { start, isCorrect, norm };

if(require.main === module){
  const port = process.env.PORT || 3000;
  start(port).then(s => {
    console.log("Emoji Tahmin + Bingo çalışıyor: http://localhost:" + s.port);
    if(!process.env.ADMIN_PIN) console.warn(ON_RENDER ? "UYARI: ADMIN_PIN ortam değişkeni ayarlanmamış, yönetici girişi kapalı." : "Not: ADMIN_PIN ayarlanmadı, yerel deneme için PIN 1234.");
  });
}
