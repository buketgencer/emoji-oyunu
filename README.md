# 🎬🎯 Emoji Tahmin + Bingo

Ekip toplantıları için canlı oyun. 15–30 kişi kendi bilgisayarından aynı anda katılır:
emojilerden filmi/diziyi tahmin ederler, bir yandan da toplantıda duydukları cümlelerle bingo kartlarını doldururlar.

- **Oyuncular:** `https://SİTE-ADRESİN.onrender.com`
- **Yönetici:** `https://SİTE-ADRESİN.onrender.com/#yonetici` (PIN ile girilir)

Oyunun tüm mantığı sunucuda çalışır. Doğru cevap sadece tur bitince, ekstra ipucu sürenin yarısında gönderilir.
Her oyuncu sadece kendi tahminlerini ve kendi bingo kartını görür.

---

## 1. Render'da nasıl yayınlanır?

İlk kurulum yaklaşık 10 dakika sürer ve bir kere yapılır.

1. <https://render.com> adresine gidip **GitHub hesabınla** giriş yap.
2. Sağ üstten **New → Web Service** seç.
3. Depo listesinden **emoji-oyunu**'nu seç (görünmüyorsa "Configure account" ile Render'a bu depoya erişim izni ver).
4. Ayarları şöyle doldur:

   | Alan | Değer |
   |---|---|
   | **Name** | `emoji-oyunu` (adres buna göre oluşur) |
   | **Branch** | kodun bulunduğu dal (ör. `main`) |
   | **Runtime / Language** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | `Free` |

5. Aynı sayfada **Environment Variables** bölümünde **Add Environment Variable**'a tıkla:
   - **Key:** `ADMIN_PIN`
   - **Value:** yönetici şifren (ör. `4827`). Tahmin edilmesi zor bir şey seç ve kimseyle paylaşma.
6. **Deploy Web Service**'e bas. Birkaç dakika sonra sayfanın üstünde `https://emoji-oyunu-xxxx.onrender.com` gibi bir adres görünür. Bu adres oyuncuların linki.

**Notlar**
- `ADMIN_PIN` ayarlanmazsa yönetici girişi güvenlik için **kapalı** kalır. PIN'i değiştirmek için Render'da servisin **Environment** sekmesinden değeri güncelle, servis kendiliğinden yeniden başlar.
- Ücretsiz planda site 15 dakika kimse girmezse uykuya geçer. İlk açılış 30–60 saniye sürebilir, bu normal.
- Sunucu yeniden başlarsa (uykudan uyanma, yeni yayın, PIN değişikliği) **o anki oyun ve puanlar silinir**. Oyuncular sayfayı açık tutuyorsa isimleriyle otomatik olarak yeniden katılır. Bu yüzden toplantı sırasında ayar veya kod değiştirme.
- GitHub'a yeni bir değişiklik gönderdiğinde Render siteyi otomatik olarak yeniden yayınlar.

---

## 2. Sorular ve bingo cümleleri nasıl değiştirilir?

İki yol var:

### A) Kalıcı olarak (önerilen)
Değişiklikler `icerik` klasöründeki dosyalarda yapılır. GitHub'da dosyayı aç, sağ üstteki **kalem (✏️) simgesine** tıkla, düzenle ve **Commit changes** ile kaydet. Render birkaç dakika içinde yeni hâli yayınlar.

- **`icerik/sorular.txt`**: her satır bir soru:
  ```
  emojiler | cevap (alternatif cevap) | kategori | ekstra ipucu
  🦁👑🌅 | Aslan Kral | 🌍 Film | 🐗🐒
  🏎️🔴⚡ | Arabalar (Cars) | 🌍 Film | 🏁🚜
  ```
  - Parantez içindeki isim de doğru kabul edilir. Birden fazla alternatifi `/` ile ayırabilirsin: `Avengers (Yenilmezler / Avengers Endgame)`.
  - Küçük yazım hataları ve Türkçe karakter farkları (ş/s, ı/i…) otomatik olarak kabul edilir.
  - Ekstra ipucu sürenin yarısında oyunculara gösterilir.
- **`icerik/bingo.txt`**: her satır bir bingo kutusu. İlk 16 satır kullanılır (4×4 kart).
- **`icerik/ayarlar.json`**: varsayılan ayarlar. Sadece sayıları ve `true`/`false` değerlerini değiştir, tırnak ve virgüllere dokunma:
  | Ayar | Anlamı |
  |---|---|
  | `soruSuresiSaniye` | Soru başına süre (10–600) |
  | `soruSayisi` | Bir oyunda kaç soru sorulacağı |
  | `karisikSira` | `true`: sorular karışık sırada gelir |
  | `kategoriyiGoster` | `false` yapılırsa kategori gizlenir ve puanlar 2 kat olur |
  | `dogruTahminPuanlari` | 1. bilen, 2. bilen, 3. ve sonrası (ör. `"3,2,1"`) |
  | `bingoPuanlari` | 1., 2., 3. ve sonraki bingo bonusu (ör. `"5,3,2"`) |
  | `sonrakiHerBingoPuani` | Aynı oyuncunun her ek satır/sütun/çaprazı için puan |

### B) O günlük, oyun ekranından
Yönetici panelinde **⚙ Ayarlar**'a bas. Soruları, bingo cümlelerini, süreyi ve puanları buradan değiştirip **Kaydet**'e basabilirsin.
Bu değişiklikler sunucu yeniden başlayınca kaybolur. Kalıcı olmasını istiyorsan A yolunu kullan.

---

## 3. Toplantı günü kontrol listesi

**Toplantıdan 10 dakika önce**
- [ ] Oyuncu linkini tarayıcıda aç ve sayfanın geldiğini gör (site uyuyorsa bu onu uyandırır, 1 dakika kadar sürebilir).
- [ ] `/#yonetici` adresini aç, PIN'inle giriş yap.
- [ ] **⚙ Ayarlar**'dan süreyi, soru sayısını ve puanları kontrol et.
- [ ] İstersen **🤖 Demo oyuncular** ile kısa bir deneme yap, sonra **Demoları kaldır** ve **🔄 Oyunu sıfırla**.
- [ ] **👁 Oyuncu gözünden** ile oyuncuların ekranını yeni sekmede kontrol et.

**Toplantı başında**
- [ ] Oyuncu linkini (yönetici linkini değil!) sohbete yapıştır.
- [ ] Herkes ismini yazıp katılsın. Sıralama listesinde ve 👥 sayacında katılanları gör. Aynı isimle ikinci kişi katılamaz, ona farklı bir isim yazmasını söyle.
- [ ] Ekran paylaşacaksan yönetici sekmesini değil, **Oyuncu gözünden** sekmesini paylaş (yönetici ekranında cevap ve herkesin tahminleri görünür).
- [ ] Herkes hazır olunca **▶ Oyunu başlat**.

**Oyun sırasında**
- Süre dolunca tur kendiliğinden biter. Erken bitirmek için **⏹ Turu bitir**, sonra **Sonraki soru →**.
- **⏸ Duraklat**, **+30 sn**, **⏭ Atla** ve **⏮ Önceki** (o sorunun puanları silinip yeniden sorulur) butonlarını gerektiğinde kullan.
- Yanlış değerlendirilen bir tahmini **Tüm tahminler 🔒** sekmesinden **Doğru say / Yanlış say** ile düzelt.
- Haksız bir bingoyu akıştaki **İptal et** butonuyla iptal et.
- Sayfasını yenileyen ya da bağlantısı kopan oyuncu aynı tarayıcıdan tekrar açınca puanı ve bingo kartıyla geri döner.

**Bitiş**
- [ ] Son sorudan sonra **🏁 Sonuçları göster** (ya da istediğin an **🏁 Final**) ile kürsü ekranını göster.
- [ ] Yeni tur için **🔁 Yeni oyun başlat**.

---

## Geliştirici notları

```bash
npm install
ADMIN_PIN=1234 npm start   # http://localhost:3000  (PIN verilmezse yerelde 1234 kullanılır)
npm test                   # 1 yönetici + 4 oyuncu ile uçtan uca otomatik test
```

- `server.js`: oyun mantığı (sorular, süre, puanlama, bingo, önceki soru, sıfırlama, ayarlar, demo oyuncular) ve Socket.IO bağlantıları.
- `public/index.html`: arayüz. Socket.IO mesaj türleri: `hello`, `ping`, `join`, `guess`, `mark`, `state`, `notice`, ayrıca yönetici için `admin`, `cmd`, `adminState`.
- Güvenlik: yönetici komutları sadece PIN'le giriş yapmış bağlantılardan kabul edilir. 5 hatalı PIN denemesinden sonra giriş 1 dakika kilitlenir. İsim en fazla 20, tahmin en fazla 60 karakter olabilir.
- Oyun durumu bellekte tutulur. Sunucu yeniden başlarsa sıfırlanır.
