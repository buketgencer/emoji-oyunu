"use strict";
// Uçtan uca test: gerçek sunucuyu başlatır, bir yönetici ve 4 oyuncu bağlantısıyla oyunu oynar.
// Çalıştırmak için: npm test
process.env.ADMIN_PIN = "4321";
const test = require("node:test");
const assert = require("node:assert/strict");
const { io } = require("socket.io-client");
const { start } = require("../server.js");

let srv, url;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor(name){
    this.name = name; this.pub = null; this.priv = null; this.adm = null; this.notices = []; this.raw = []; this.token = null; this.id = null;
    this.s = io(url, { transports: ["websocket"], forceNew: true });
    this.s.on("state", d => { this.pub = d.pub; this.priv = d.priv; this.raw.push(JSON.stringify(d)); });
    this.s.on("adminState", d => { this.adm = d.st; this.raw.push("ADMIN" + JSON.stringify(d)); });
    this.s.on("notice", d => { this.notices.push(d); this.raw.push(JSON.stringify(d)); if(d.joined === true){ this.id = d.id; if(d.token) this.token = d.token; } });
  }
  ready(){ return new Promise(r => this.s.connected ? r() : this.s.once("connect", r)); }
  send(kind, m){ this.s.emit(kind, Object.assign({ kind: kind }, m || {})); }
  ask(kind, m){ return new Promise(r => this.s.emit(kind, Object.assign({ kind: kind }, m || {}), r)); }
  cmd(name, ...args){ this.send("cmd", { name: name, args: args }); }
  me(){ return this.pub && this.pub.players.find(p => p.id === this.id); }
  async waitFor(fn, ms = 3000, what = "koşul"){
    const t0 = Date.now();
    while(Date.now() - t0 < ms){ try{ if(fn()) return; }catch(e){} await sleep(15); }
    throw new Error(this.name + ": beklenen " + what + " gerçekleşmedi");
  }
  async join(name){
    const n = this.notices.length;
    this.send("join", { name: name, token: this.token || undefined });
    await this.waitFor(() => this.notices.slice(n).some(x => x.joined === true || x.joinError), 3000, "katılma yanıtı");
    return this.notices.slice(n).find(x => x.joined === true || x.joinError);
  }
  close(){ this.s.close(); }
}

let admin, A, B, C, D;
const pts = (c, who) => c.pub.players.find(p => p.id === who.id);

test.before(async () => {
  srv = await start(0);
  url = "http://localhost:" + srv.port;
});
test.after(async () => { [admin, A, B, C, D].forEach(c => c && c.close()); await srv.close(); });

test("sayfa ve socket.io istemcisi sunuluyor", async () => {
  const html = await (await fetch(url + "/")).text();
  assert.match(html, /Emoji <span>Tahmin<\/span> \+ Bingo/);
  assert.match(html, /\/socket\.io\/socket\.io\.js/);
  assert.doesNotMatch(html, /sPin|Demo PIN/, "PIN alanı/ipucu sayfada olmamalı");
  const js = await fetch(url + "/socket.io/socket.io.js");
  assert.equal(js.status, 200);
});

test("yönetici girişi: yanlış PIN reddedilir, doğru PIN kabul edilir", async () => {
  admin = new Client("yönetici"); await admin.ready();
  const bad = await admin.ask("admin", { pin: "0000" });
  assert.equal(bad.ok, false);
  const good = await admin.ask("admin", { pin: "4321" });
  assert.equal(good.ok, true); assert.ok(good.session);
  await admin.waitFor(() => admin.adm, 2000, "yönetici durumu");
});

test("katılma, isim sınırları ve aynı isim engeli", async () => {
  A = new Client("A"); B = new Client("B"); C = new Client("C"); D = new Client("D");
  await Promise.all([A, B, C, D].map(c => c.ready()));
  assert.equal((await A.join("Ayşe")).joined, true);
  assert.equal((await B.join("Burak")).joined, true);
  assert.equal((await C.join("Cem")).joined, true);

  // aynı isim (büyük/küçük harf ve Türkçe karakter farkıyla) reddedilir
  for(const n of ["Ayşe", "AYŞE", "ayse", "  Ayşe  "]){
    const r = await D.join(n);
    assert.equal(r.joinError, true, n + " reddedilmeliydi"); assert.match(r.text, /alınmış/);
  }
  assert.equal((await D.join("X")).joinError, true, "1 harfli isim reddedilmeli");
  const long = await D.join("Dilara".repeat(5));
  assert.equal(long.joined, true);
  assert.equal(Array.from(long.name).length, 20, "isim 20 karaktere kısaltılmalı");
  await admin.waitFor(() => admin.pub.players.length === 4, 2000, "4 oyuncu");
  assert.ok(A.token && A.token.length >= 40, "oyuncuya gizli anahtar verilmeli");
  // gizli anahtarlar kimseye yayınlanmamalı
  assert.ok(!B.raw.join("").includes(A.token), "A'nın anahtarı B'ye gitmemeli");
  assert.ok(!admin.raw.join("").includes(A.token), "anahtar yöneticiye de gitmemeli");
});

test("oyuncular yönetici komutu gönderemez ve yönetici verisi almaz", async () => {
  const n = A.notices.length;
  A.cmd("start"); A.cmd("bots"); A.cmd("reset");
  await A.waitFor(() => A.notices.length > n, 2000, "yetki uyarısı");
  assert.match(A.notices[n].text, /yönetici girişi gerekli/);
  await sleep(100);
  assert.equal(admin.pub.phase, "lobby");
  assert.equal(admin.pub.players.length, 4, "oyuncu demo oyuncu ekleyememeli");
  for(const c of [A, B, C, D]) assert.ok(!c.raw.some(r => r.startsWith("ADMIN")), c.name + " yönetici durumu almamalı");
  // yönetici bağlantısı yokken bağlanmamış bir soket tahmin gönderemez
  const x = new Client("yabancı"); await x.ready();
  x.send("guess", { text: "deneme" }); x.send("mark", { marks: [0, 1, 2, 3] });
  await sleep(100); x.close();
  assert.equal(admin.pub.players.length, 4);
});

test("ayarlar kaydedilir (süre 10 sn, 3 soru, sırayla)", async () => {
  admin.cmd("saveSettings", { settings: { duration: 10, numQ: 3, shuffle: false, showCat: true, pts: "3,2,1", bingoPts: "5,3,2", bingoExtra: 1, pin: "9999" }, qText: admin.adm.qText, bingoText: admin.adm.bingoText });
  await admin.waitFor(() => admin.adm.settings.duration === 10 && admin.adm.settings.numQ === 3, 2000, "ayarlar");
  assert.equal(admin.adm.settings.pin, undefined, "ayarlarda PIN olmamalı");
  assert.ok(admin.notices.some(n => /Ayarlar kaydedildi/.test(n.text)));
  // PIN ayarlardan değiştirilemez
  const t = new Client("pin"); await t.ready();
  assert.equal((await t.ask("admin", { pin: "9999" })).ok, false); t.close();
});

test("soru 1: cevap/ipucu gizli, yanlış tahmin, 3/2/1 puanlama", async () => {
  admin.cmd("start");
  await admin.waitFor(() => admin.pub.phase === "question" && admin.adm.answer, 2000, "ilk soru");
  const answer = admin.adm.answer;
  assert.equal(answer, "Arka Sokaklar");
  await B.waitFor(() => B.pub.phase === "question");
  assert.equal(B.pub.q.answer, ""); assert.equal(B.pub.q.extra, "");
  assert.ok(Math.abs(B.pub.round.now - Date.now()) < 1000, "sunucu saati gönderilmeli");

  // yanlış tahmin: sadece sahibi görür
  A.send("guess", { text: "zzqq yanlış tahmin" });
  await A.waitFor(() => A.priv.guesses.length === 1);
  assert.equal(A.priv.guesses[0].ok, false);
  // çok uzun tahmin 60 karaktere kısaltılır
  D.send("guess", { text: "u".repeat(150) });
  await admin.waitFor(() => admin.adm.guesses.some(g => g.name.startsWith("Dilara")));
  assert.equal(admin.adm.guesses.find(g => g.name.startsWith("Dilara")).text.length, 60);

  // doğru tahminler: A, B, C sırasıyla (C küçük harf + yazım hatası ile)
  A.send("guess", { text: "arka sokaklar" }); await A.waitFor(() => A.priv.rank === 1);
  B.send("guess", { text: "Arka Sokaklar" }); await B.waitFor(() => B.priv.rank === 2);
  C.send("guess", { text: "arka sokaklarr" }); await C.waitFor(() => C.priv.rank === 3);
  // bildikten sonra tekrar tahmin edilemez
  const n = A.notices.length; A.send("guess", { text: "arka sokaklar" });
  await A.waitFor(() => A.notices.length > n); assert.match(A.notices[n].text, /zaten bildin/);
  // puanlar tur bitene kadar verilmez
  assert.equal(pts(B, A).pts, 0);

  // ipucu sürenin yarısında açılır, cevap hâlâ gizli
  await B.waitFor(() => B.pub.q.extra, 7000, "ipucu");
  assert.equal(B.pub.q.extra, "👮‍♂️🏘️"); assert.equal(B.pub.q.answer, "");

  // gizlilik: tur boyunca hiçbir oyuncu cevabı, başkalarının tahminlerini veya erken ipucunu almadı
  for(const c of [A, B, C, D]){
    const all = c.raw.join("\n");
    assert.ok(!all.includes("Arka Sokaklar") || c === B, c.name + " cevabı tur bitmeden almamalı");
    if(c !== A) assert.ok(!all.includes("zzqq"), c.name + " A'nın yanlış tahminini görmemeli");
    if(c !== D) assert.ok(!all.includes("uuuuuuuu"), c.name + " D'nin tahminini görmemeli");
  }
  // B kendi tahmininde "Arka Sokaklar" yazdığı için kendi kaydında görür; başkasında görünmemeli
  for(const c of [C, D]) assert.ok(!c.raw.join("").includes("Arka Sokaklar"));

  admin.cmd("end");
  await B.waitFor(() => B.pub.phase === "reveal", 2000, "tur sonu");
  assert.equal(B.pub.q.answer, answer, "cevap tur sonunda gönderilmeli");
  assert.deepEqual(B.pub.reveal.winners.map(w => [w.name, w.pts]), [["Ayşe", 3], ["Burak", 2], ["Cem", 1]]);
  assert.equal(pts(B, A).pts, 3); assert.equal(pts(B, B).pts, 2); assert.equal(pts(B, C).pts, 1); assert.equal(pts(B, D).pts, 0);
  const n2 = D.notices.length; D.send("guess", { text: "Arka Sokaklar" });
  await D.waitFor(() => D.notices.length > n2); assert.match(D.notices[n2].text, /tahmin alınmıyor/);
});

test("bingo: 5/3/2 bonus ve ek bingo puanı", async () => {
  A.send("mark", { marks: [0, 1, 2, 3] });
  await A.waitFor(() => A.notices.some(n => n.bingo), 2000, "bingo bildirimi");
  await B.waitFor(() => pts(B, A).bonus === 5);
  B.send("mark", { marks: [0, 4, 8, 12, 99, -1, "x"] });
  await B.waitFor(() => pts(B, B).bonus === 3);
  assert.deepEqual(B.priv.marks, [0, 4, 8, 12], "geçersiz işaretler atılmalı");
  C.send("mark", { marks: [0, 5, 10, 15] });
  await C.waitFor(() => pts(C, C).bonus === 2);
  D.send("mark", { marks: [0, 1, 2] });
  await sleep(100); assert.equal(pts(D, D).bonus, 0);
  // A ikinci satırı tamamlar: +1 ek bingo puanı
  A.send("mark", { marks: [0, 1, 2, 3, 4, 5, 6, 7] });
  await A.waitFor(() => A.notices.some(n => n.bingo && n.extra === 1), 2000, "ek bingo bildirimi");
  await B.waitFor(() => pts(B, A).bonus === 6);
  assert.equal(pts(B, A).total, 9);
  assert.deepEqual(B.pub.bingoWinners, ["Ayşe", "Burak", "Cem"]);
  // B, A'nın işaretlerini görmez
  assert.ok(!B.raw.some(r => r.includes("[0,1,2,3,4,5,6,7]")));
  assert.deepEqual(admin.adm.markCount.slice(0, 4), [4, 2, 2, 1]);
});

test("yeniden bağlanma: puan ve bingo işaretleri korunur", async () => {
  const token = A.token, id = A.id;
  A.close();
  await B.waitFor(() => pts(B, { id }).online === false, 2000, "A çevrimdışı");
  A = new Client("A2"); A.token = token; await A.ready();
  A.send("hello", { token: token });
  await A.waitFor(() => A.notices.some(n => n.joined === true), 2000, "yeniden katılma");
  assert.equal(A.id, id);
  await A.waitFor(() => A.priv && A.priv.marks.length === 8);
  assert.equal(pts(A, A).pts, 3); assert.equal(pts(A, A).bonus, 6);
  await B.waitFor(() => pts(B, { id }).online === true, 2000, "A çevrimiçi");
  // geçersiz anahtar tanınmaz
  const x = new Client("sahte"); await x.ready();
  x.send("hello", { token: "f".repeat(48) });
  await x.waitFor(() => x.notices.some(n => n.joined === false)); x.close();
});

test("soru 2: süre dolunca tur sunucuda biter", async () => {
  admin.cmd("next");
  await A.waitFor(() => A.pub.phase === "question" && A.pub.pos === 1, 2000, "soru 2");
  A.send("guess", { text: "Esaretin Bedeli" });
  await A.waitFor(() => A.priv.rank === 1);
  await A.waitFor(() => A.pub.phase === "reveal", 12000, "süre dolması");
  assert.ok(A.pub.chat.some(m => /Süre doldu/.test(m.text)));
  assert.equal(pts(A, A).pts, 6);
});

test("önceki soru: o sorunun puanları geri alınır ve yeniden oynanır", async () => {
  admin.cmd("prev");
  await B.waitFor(() => B.pub.phase === "question" && B.pub.pos === 0, 2000, "önceki soru");
  assert.equal(pts(B, A).pts, 3, "A: soru 1'in 3 puanı silinmeli, soru 2'nin 3 puanı kalmalı");
  assert.equal(pts(B, B).pts, 0); assert.equal(pts(B, C).pts, 0);
  assert.deepEqual(A.priv.guesses, [], "soru 1 tahminleri temizlenmeli");
  C.send("guess", { text: "Arka Sokaklar" }); await C.waitFor(() => C.priv.rank === 1);
  admin.cmd("end");
  await B.waitFor(() => B.pub.phase === "reveal");
  assert.equal(pts(B, C).pts, 3);
  // ileri gidince soru 2 de yeniden başlar ve A'nın soru 2 puanı geri alınır
  admin.cmd("next");
  await B.waitFor(() => B.pub.phase === "question" && B.pub.pos === 1);
  assert.equal(pts(B, A).pts, 0);
});

test("final ekranı", async () => {
  admin.cmd("end");
  await B.waitFor(() => B.pub.phase === "reveal");
  admin.cmd("next");
  await B.waitFor(() => B.pub.phase === "question" && B.pub.pos === 2);
  admin.cmd("final");
  await B.waitFor(() => B.pub.phase === "final", 2000, "final");
  assert.ok(B.pub.q.answer, "finalde son cevap görünür");
  const totals = Object.fromEntries(B.pub.players.map(p => [p.name, p.total]));
  assert.deepEqual(totals, { "Ayşe": 6, "Burak": 3, "Cem": 5, [D.pub.players.find(p => p.id === D.id).name]: 0 });
});

test("demo oyuncular sadece yöneticiyle ve sıfırlama", async () => {
  admin.cmd("bots");
  await admin.waitFor(() => admin.pub.players.length === 8, 2000, "demo oyuncular");
  assert.ok(admin.pub.players.some(p => p.name === "Ayşe 2"), "aynı isimli demo oyuncu yeniden adlandırılmalı");
  admin.cmd("reset");
  await B.waitFor(() => B.pub.phase === "lobby" && B.pub.players.length === 4, 2000, "sıfırlama");
  assert.ok(B.pub.players.every(p => p.total === 0 && !p.bingo));
  assert.deepEqual(B.priv.marks, []);
  assert.equal(B.pub.chat.length, 0);
  assert.equal(admin.adm.settings.duration, 10, "ayarlar sıfırlamadan sonra korunur");
  // sıfırlamadan sonra da aynı isim engeli geçerli
  const E = new Client("E"); await E.ready();
  assert.equal((await E.join("burak")).joinError, true); E.close();
});

test("yönetici oturumu kopan bağlantıda PIN'siz geri gelir, çıkışta geçersiz olur", async () => {
  const x = new Client("yönetici2"); await x.ready();
  const r = await x.ask("admin", { pin: "4321" });
  const y = new Client("yönetici2-yeni"); await y.ready();
  assert.equal((await y.ask("admin", { session: r.session })).ok, true);
  y.send("adminLogout"); await sleep(50);
  const z = new Client("yönetici2-sonra"); await z.ready();
  assert.equal((await z.ask("admin", { session: r.session })).ok, false);
  [x, y, z].forEach(c => c.close());
});

test("PIN deneme sınırı", async () => {
  const x = new Client("saldırgan"); await x.ready();
  for(let i = 0; i < 5; i++) await x.ask("admin", { pin: "000" + i });
  const r = await x.ask("admin", { pin: "4321" });
  assert.equal(r.ok, false); assert.match(r.error, /Çok fazla hatalı deneme/);
  x.close();
});
