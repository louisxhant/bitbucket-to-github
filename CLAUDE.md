# Hướng dẫn cho Claude

## Issue trước, PR tự đóng issue

- Khi được giao việc, **tạo issue trên chính repo này trước** (tiêu đề, yêu cầu, tiêu chí hoàn thành) rồi mới bắt đầu làm. Nếu việc đã có issue thì dùng issue đó, không tạo trùng. Không tạo được issue (thiếu quyền, lỗi mạng…) thì báo người dùng, không âm thầm bỏ qua.
- Làm trên nhánh riêng tách từ nhánh mặc định (`main`); commit message tham chiếu issue (`#<số>`).
- PR nhắm vào `main`, mô tả PR phải có dòng `Closes #<số>` (mỗi issue một dòng) để GitHub **tự đóng issue khi PR được merge vào `main`**. GitHub chỉ tự đóng khi merge vào nhánh mặc định và chỉ nhận từ khoá `Closes`/`Fixes`/`Resolves` — "Liên quan #<số>" không đóng được.
- PR chỉ giải quyết một phần thì dùng `Refs #<số>` và để issue mở.

## CI/CD và runner

- Chủ repo quy định CI, lint, test, build, deploy chạy trên **self-hosted runner** để tiết kiệm phút GitHub Actions. **Ngoại lệ: repo này public**, nên **không** dùng self-hosted runner (ai cũng mở được PR để chạy code trên máy của chủ repo); repo public được GitHub miễn phí phút runner, nên dùng `runs-on: ubuntu-latest` không tốn gì.
- Nếu repo chuyển sang private thì workflow phải chuyển sang `runs-on: [self-hosted, bitbucket-to-github]` và ghi vào docs cách đăng ký runner.
