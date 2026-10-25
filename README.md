# Hashdesk Miner

Miner cho [zpool.ca](https://zpool.ca) chạy bằng WebAssembly trong Chrome headless, kèm giao diện web và một TUI kiểu xmrig.

Không cần GPU, không cần root, không cần cài đặt hệ thống. Chỉ cần Node 20+.

```
 * ABOUT        Hashdesk/1.0.0 node/24.22.1
 * LIBS         wasm/engine-core chromium/153.0.8010.0
 * CPU          AMD EPYC (1) 8C/8T 64-bit AES
 * MEMORY       1.2/31.4 GB (4%)
 * POOL #1      minotaurx.na.mine.zpool.ca algo minotaurx
[2026-10-24 16:18:48.081]  net    use pool minotaurx.na.mine.zpool.ca:7019
[2026-10-24 16:18:48.081]  cpu     READY threads 8/8 (8)
[2026-10-24 16:18:52.077]  cpu    accepted (1/0) diff 0.000008
[2026-10-24 16:18:54.083]  miner  speed 10s/60s/15m 4.8k 4.7k n/a H/s max 4898.2 H/s
```

---

## Cài đặt

```bash
git clone https://github.com/phantrongkien12/hashdesk-miner.git
cd hashdesk-miner
bash setup.sh
```

`setup.sh` làm hết: kiểm tra Node, cài pnpm qua corepack, `pnpm install`, build, cài Chrome, rồi khởi động server ở cổng 3100.

Các biến thể:

```bash
bash setup.sh --clean        # xoá node_modules/.next rồi build lại
bash setup.sh ~/other        # cài vào thư mục khác
PORT=4000 bash setup.sh      # đổi cổng
```

Xong thì chạy:

```bash
node scripts/mine-tui.mjs --serve --threads 8
```

---

## Bốn cách chạy

| Cách | Lệnh | Dùng khi |
|---|---|---|
| **TUI** | `node scripts/mine-tui.mjs --serve` | Muốn xem log kiểu xmrig, một lệnh lo hết |
| **Web UI** | `pnpm dev` rồi mở `localhost:3000` | Muốn bấm nút, xem biểu đồ |
| **CLI** | `node scripts/mine-cli.mjs` | Không cần trình duyệt, chạy trong Node |
| **Schedule** | `node scripts/mine-schedule.mjs` | Đào theo chu kỳ, tự kết nối lại |

### TUI

```bash
node scripts/mine-tui.mjs --serve --threads 8
```

Tự tìm cổng trống, tự bật server, tự mở Chrome, rồi hiển thị log. Phím tắt khi đang chạy:

```
h  hashrate      p  pause        r  resume
c  connection    s  results      q  quit
```

Nếu server đã chạy sẵn ở cổng khác:

```bash
node scripts/mine-tui.mjs --port 3100 --threads 8
```

### Web UI

```bash
pnpm dev
```

Mở `localhost:3000`. Dashboard có panel cấu hình, hashrate realtime, ước tính payout, log console và thống kê share.

Cấu hình được qua query string:

```
/?algo=minotaurx&payout=LTC&threads=8&wallet=ltc1q...&autostart=1
```

`autostart=1` để trang tự bấm Start — cần cho Chrome headless vì nó không click được.

### CLI

```bash
node scripts/mine-cli.mjs --threads 8 --duration 300
```

Cùng engine wasm, chạy thẳng trong Node, không cần Chrome. Nhẹ hơn nhiều.

### Schedule

```bash
node scripts/mine-schedule.mjs --window 600 --gap 120
```

Đào 10 phút, nghỉ 2 phút, lặp lại. Mỗi chu kỳ là một kết nối pool mới nên socket rớt không làm chết lịch.

---

## Tuỳ chọn

### Thuật toán

| ID | Pool | Diff khởi điểm |
|---|---|---|
| `minotaurx` | `minotaurx.na.mine.zpool.ca:7019` | 0.000008 — khuyến nghị |
| `yescrypt` | `yescrypt.na.mine.zpool.ca:6233` | 0.5 |
| `yespower` | `yespower.na.mine.zpool.ca:6234` | 0.1 |
| `power2b` | `power2b.na.mine.zpool.ca:6242` | 0.1 |

Diff càng thấp thì share về càng nhanh, nên `minotaurx` là lựa chọn mặc định.

### Tiền payout

`LTC` (mặc định) · `DOGE` · `DGB` · `RVN`

Pool tự đổi coin khai thác sang đơn vị bạn chọn. Ngưỡng payout tối thiểu: LTC 0.05, DOGE 5, DGB 5, RVN 0.05.

### Relay

Pool chặn kết nối WebSocket trực tiếp từ trình duyệt, nên phải đi qua relay:

```
wss://technical-dasha-devdev-ccf19728.koyeb.app     (mặc định)
wss://wss--server--gccv7jh7vmb6.code.run
wss://wss--server2--gccv7jh7vmb6.code.run
```

Đổi bằng `--relay <url>` hoặc `MINER_RELAY`. Bất kỳ địa chỉ `wss://` nào cũng được, không
cần sửa code — relay tự dựng cũng chạy.

**Tự chuyển relay.** Relay chọn trước, hai cái còn lại làm dự phòng. Khi một relay lỗi
2 lần liên tiếp, client tự chuyển sang cái kế tiếp và kết nối lại với backoff tăng dần
(1s → 2s → 4s → 8s → 16s → 30s, tối đa 30s). Kết nối lại thành công thì bộ đếm reset.
Nhờ vậy chạy nhiều giờ không bị chết khi relay restart.

### Share bị từ chối

Ba bộ đếm tách biệt, đừng nhầm lẫn:

| Bộ đếm | Nghĩa |
|---|---|
| `accepted` | Pool nhận, được trả tiền |
| `rejected` | Pool từ chối, kèm lý do trong ngoặc |
| `lost` | Không có phản hồi trong 20s — **không phải** pool từ chối |
| `stale` | Share tìm ra sau khi job đã bị thay, tự bỏ tại chỗ |

Lý do reject hiện ngay trên dòng log, ví dụ:

```
cpu  rejected (3/1) diff 0.000008 [21,"Invalid job id"]
cpu  rejected (3/2) diff 0.000008 [23,"Low difficulty share"]
```

- `Invalid job id` — share gửi lên quá muộn, job đã bị thay. Thường do relay chậm hoặc
  máy quá tải. Giảm `--threads` hoặc đổi relay.
- `Low difficulty share` — target tính sai, hoặc pool vừa nâng difficulty mà worker chưa
  kịp cập nhật.
- `Duplicate share` — cùng một nonce gửi hai lần.

Nếu `lost` cao mà `rejected` thấp, vấn đề nằm ở đường truyền chứ không phải ở máy đào.

### Biến môi trường

Chép `.env.example` thành `.env.local`:

```bash
MINER_WALLET=ltc1qkdfz6awelxenp8lc8v7hr2k8m4xamawmk2sgzg
MINER_PAYOUT=LTC
MINER_ALGO=minotaurx
MINER_RELAY=wss://technical-dasha-devdev-ccf19728.koyeb.app
```

Cờ dòng lệnh luôn thắng biến môi trường.

---

## Chrome

Đây là phần khó nhất khi chạy trên VPS trần.

Chrome cần khoảng 21 thư viện hệ thống. Trên máy không có `apt`, không có `dpkg`, không có root — như box Amazon Linux 2023 — thì không cài được theo cách thường.

Cách giải: dùng `@sparticuz/chromium`, bản Chromium đã nhúng sẵn 18 trong 21 thư viện đó. Chỉ còn thiếu `nss`, `nspr` và `fontconfig`, tải từ archive Debian công khai rồi giải nén bằng `ar` + `tar` vào `./libs`.

```bash
bash scripts/fix-chrome-libs.sh
```

Script tự chọn bản Debian cũ nhất, vì bản mới cần glibc mới hơn box thường có. `setup.sh` gọi script này tự động nếu Chrome chưa chạy được.

Kiểm tra:

```bash
node scripts/mine-tui.mjs --doctor
```

```
 * LIBS         wasm/engine-core chromium/153.0.8010.0
```

Nếu bạn có root và dùng Debian/Ubuntu thì không cần script trên:

```bash
sudo apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libatspi2.0-0 libcups2 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 \
  libasound2 libx11-6 libxcb1 libxext6
```

---

## Cách hoạt động

```
┌──────────────┐   wasm    ┌──────────────┐   stratum   ┌──────────┐
│  Web Worker  │ ────────► │  MinerEngine │ ──────────► │ zpool.ca │
│  (engine-core)│  share   │  (lib/miner) │             └──────────┘
└──────────────┘           └──────┬───────┘
                                  │ telemetry
                           ┌──────▼───────┐
                           │  Next.js API │
                           └──────┬───────┘
                                  │ poll
                           ┌──────▼───────┐
                           │     TUI      │
                           └──────────────┘
```

| File | Vai trò |
|---|---|
| `public/miner/engine-core.js` | Engine wasm, tính hash |
| `public/miner/worker.js` | Web Worker bọc engine |
| `lib/miner/stratum.ts` | Client stratum, quản lý job và share |
| `lib/miner/engine.ts` | `MinerEngine`, spawn worker, gộp hashrate |
| `lib/miner/telemetry-store.ts` | Store trong bộ nhớ, cầu nối web ↔ TUI |
| `app/api/miner/telemetry/route.ts` | POST/GET/DELETE telemetry |
| `app/api/miner/command/route.ts` | Hàng đợi lệnh pause/resume/stop |
| `hooks/use-miner.ts` | React hook bọc engine |
| `scripts/mine-tui.mjs` | TUI, poll telemetry, gửi lệnh |

TUI không tự đào. Nó bật server, mở Chrome vào trang có `?autostart=1&telemetry=1`, rồi đọc telemetry từ API. Phím `p`/`r` gửi lệnh qua `/api/miner/command`, trang poll lấy và thực thi.

---

## Xử lý sự cố

**Chrome không chạy**

```bash
node scripts/mine-tui.mjs --doctor
bash scripts/fix-chrome-libs.sh
```

**Cổng bị chiếm**

```bash
pkill -f "next start"
```

Hoặc để TUI tự tìm cổng trống bằng `--serve`.

**Server không lên**

```bash
tail -f server.log
```

**Tỉ lệ reject cao**

Đọc lý do trong ngoặc trên dòng `rejected` trước, rồi mới sửa — mỗi lý do có nguyên nhân
khác nhau. Xem mục [Share bị từ chối](#share-bị-từ-chối).

Nếu là `Invalid job id`, thử giảm thread xuống bằng số core trừ 1:

```bash
node scripts/mine-tui.mjs --serve --threads 1
```

Máy 2 core chạy 8 thread thì luồng chính bận xử lý worker, share gửi lên bị trễ và job
đã đổi trước khi tới pool.

**Không thấy màu trong TUI**

```bash
echo $TERM          # cần xterm-256color trở lên
export TERM=xterm-256color
```

Tắt màu hẳn bằng `--no-color` hoặc `NO_COLOR=1`. File `--log` luôn là text thuần.

**Build lỗi**

```bash
bash setup.sh --clean
```

**Không có share nào**

Kiểm tra `--doctor` xem Chrome có chạy không. Nếu Chrome ổn mà vẫn 0 share sau vài phút, thử `--algo yescrypt` — diff khởi điểm khác nhau giữa các thuật toán.

---

## Lưu ý

Hashrate của engine wasm chỉ vài kH/s, thấp hơn GPU hàng nghìn lần. Panel payout hiển thị số ngày tới ngưỡng thanh toán dựa trên hashrate thực — con số đó thường rất lớn, và đó là sự thật, không phải lỗi.

Dự án này để học cách một miner hoạt động: stratum protocol, share, difficulty, worker. Đừng kỳ vọng lợi nhuận.

Giá coin trong `lib/miner/payout.ts` là giá tĩnh chốt ngày 2026-10-24, cố ý không gọi API để panel render được khi offline.

---

## Yêu cầu

- Node 20 trở lên
- pnpm (setup.sh tự cài qua corepack)
- Chrome hoặc Chromium (chỉ TUI và `mine-chrome` cần; `mine-cli` thì không)
- Kết nối ra `*.mine.zpool.ca` và relay WebSocket

## Máy nhiều core

Mặc định là `cores - 1`, chừa một core cho Chrome và socket stratum. Trần là **64 thread**,
vì mỗi thread là một tiến trình Chrome riêng chứ không phải một luồng trong cùng tiến trình.

| Máy | Thread mặc định | RAM cho Chrome |
|---|---|---|
| 4 core | 3 | ~120 MB |
| 8 core | 7 | ~280 MB |
| 16 core | 15 | ~600 MB |
| 32 core | 31 | ~1.2 GB |

Đo thực tế: 20 thread dùng 730 MB, tức khoảng 37 MB mỗi thread. Cộng thêm khoảng 700 MB
cho Next.js, nên máy 32 core cần tối thiểu 2 GB trống.

Đặt tay khi muốn chừa nhiều core hơn:

```bash
node scripts/mine-tui.mjs --serve --threads 24
```

Vượt trần sẽ báo rõ chứ không cắt âm thầm:

```
--threads 100 is above the 64 limit, using 64
```

**Nên chừa 2 core nếu máy còn chạy việc khác.** Share gửi lên trễ sẽ bị pool trả
`Invalid job id`, và tỉ lệ reject tăng dù hashrate vẫn đẹp.
