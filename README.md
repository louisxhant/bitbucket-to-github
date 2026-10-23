# Bitbucket → GitHub Migrator

Tool chạy local có giao diện web để chuyển toàn bộ nhánh và tag của một repo Bitbucket sang GitHub.
Không cần cài thư viện — chỉ cần **Node.js ≥ 18** và **git** (tuỳ chọn: **git-lfs**).

## Chuẩn bị

1. Clone repo Bitbucket về máy (clone đầy đủ, không dùng `--depth`):
   ```
   git clone https://bitbucket.org/<workspace>/<repo>.git repo-bitbucket
   ```
2. Tạo repo **trống** trên GitHub, rồi clone về:
   ```
   git clone https://github.com/<org>/<repo>.git repo-github
   ```
   Tool đọc URL GitHub từ remote của thư mục này, nên chỉ cần thư mục có remote `origin` trỏ tới GitHub.
3. Đảm bảo git đã đăng nhập được cả hai nơi (Git Credential Manager, SSH key, hoặc token).

## Chạy

```bash
npm start
```

Hoặc nhấp đúp `start.bat` trên Windows. Trình duyệt sẽ tự mở `http://localhost:5178`
(đổi cổng bằng biến môi trường `PORT`, thêm `--no-open` để không tự mở trình duyệt).

## Sử dụng

1. **Repo nguồn (Bitbucket)** và **Repo đích (GitHub)**: nhập đường dẫn, hoặc
   - **Chọn…** — mở hộp thoại chọn thư mục của hệ điều hành,
   - **Duyệt** — duyệt thư mục ngay trong trang web (thư mục là git repo có nhãn `git`).
2. Kiểm tra remote, URL và cảnh báo của từng repo.
3. Chọn nhánh cần chuyển. Cột *Trên GitHub* cho biết nhánh là `mới`, `đã giống` hay `khác`
   so với thông tin tracking của repo GitHub local.
4. Bấm **Chạy thử (dry-run)** để xem trước, rồi **Migrate**.

### Cách hoạt động

| Bước | Lệnh |
| --- | --- |
| Fetch Bitbucket | `git fetch origin --prune --tags` trong repo nguồn |
| Đẩy nhánh | `git push <url GitHub> refs/remotes/origin/<b>:refs/heads/<b> …` (theo lô 40 nhánh) |
| Đẩy tag | `git push <url GitHub> refs/tags/*:refs/tags/*` |
| Git LFS | `git lfs fetch --all` rồi `git lfs push --all <url GitHub>` |
| Kiểm tra | `git ls-remote` trên GitHub, so SHA từng nhánh/tag với nguồn |
| Đồng bộ đích | `git fetch origin --prune --tags` trong repo GitHub local |

- Mặc định lấy nhánh từ remote-tracking (`origin/*`) — tức là trạng thái trên Bitbucket — nên mọi nhánh
  đều được chuyển dù chưa checkout local. Chọn *Ưu tiên ref: nhánh local* nếu muốn đẩy bản local.
- Không có **force** thì nhánh đã tồn tại trên GitHub với lịch sử khác sẽ bị `rejected` (an toàn).
  Bật **Force push** chỉ khi chắc chắn muốn ghi đè.
- Tool không xoá nhánh nào trên GitHub, không đổi remote của repo nguồn.

### Sau khi migrate

- Đặt nhánh mặc định trên GitHub (Settings → Branches) nếu cần.
- Pull request, issue, wiki, pipeline của Bitbucket **không** được chuyển — chỉ chuyển dữ liệu git.

## Bảo mật

Server chỉ lắng nghe `127.0.0.1`, chỉ nhận request có Host là `localhost`/`127.0.0.1`,
và ẩn thông tin đăng nhập trong URL khi hiển thị log.
