# Hướng dẫn cho Claude

## Issue trước, PR tự đóng issue

- Khi được giao việc, **tạo issue trên chính repo này trước** (tiêu đề, yêu cầu, tiêu chí hoàn thành) rồi mới bắt đầu làm. Nếu việc đã có issue thì dùng issue đó, không tạo trùng. Không tạo được issue (thiếu quyền, lỗi mạng…) thì báo người dùng, không âm thầm bỏ qua.
- Làm trên nhánh riêng tách từ nhánh mặc định (`main`); commit message tham chiếu issue (`#<số>`).
- PR nhắm vào `main`, mô tả PR phải có dòng `Closes #<số>` (mỗi issue một dòng) để GitHub **tự đóng issue khi PR được merge vào `main`**. GitHub chỉ tự đóng khi merge vào nhánh mặc định và chỉ nhận từ khoá `Closes`/`Fixes`/`Resolves` — "Liên quan #<số>" không đóng được.
- PR chỉ giải quyết một phần thì dùng `Refs #<số>` và để issue mở.
