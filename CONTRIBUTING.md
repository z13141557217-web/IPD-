# 开发与版本管理约定

## 分支

- `main` 始终是可以运行的最新版本。不直接在 `main` 上开发。
- 每项工作新建一个分支：新功能用 `feat/简短描述`，修复用 `fix/简短描述`。
- 分支上的测试和构建都通过后再合并到 `main`。

## 提交

- 一次提交只做一件事，提交说明的第一行写清楚做了什么，正文用列表补充细节。
- 密钥、`.env`、数据库文件、构建产物不提交。`.gitignore` 已经排除了它们，提交前用 `git status` 再看一眼。

## 发布一个版本

版本号写在三个地方，必须一致（后端测试会检查）：

| 位置 | 用途 |
| --- | --- |
| `VERSION` | 仓库的版本号，自动打标签时读取 |
| `backend/app/version.py` | 后端接口和设置页显示 |
| `frontend/package.json` 的 `version` | 前端构建时注入 |

步骤：

1. 决定新的版本号。有新功能或不兼容的改动，增加中间一位；只有修复，增加最后一位。
2. 把上面三处改成新版本号。
3. 在 `CHANGELOG.md` 最上面新增这一版的小节，写清楚新增、变更、修复；有数据库迁移时写进“升级说明”。
4. 运行全部检查（见下）。
5. 合并到 `main` 并推送。推送后，`.github/workflows/release-tag.yml` 会读取 `VERSION`，在还没有这个标签时自动创建 `v版本号` 标签和对应的发布说明。

## 合并前的检查

```bash
cd backend
.venv/bin/pytest                 # 全部测试
.venv/bin/alembic upgrade head   # 需要一个可连接的 PostgreSQL
.venv/bin/alembic check          # 数据表定义与迁移脚本一致

cd ../frontend
npm test                         # 在线版与后端的一致性测试
npm run build                    # 类型检查并构建
```

推送后 `.github/workflows/ci.yml` 会在 GitHub 上自动重跑这些检查。

## 改动时要保持的约定

- 改了数据表定义：用 `alembic revision --autogenerate -m "说明"` 生成迁移脚本，不手工改库。
- 改了提示词（`backend/app/rules/prompts.yaml`）：把对应的 `version` 加一，这样调用记录能分清是哪一版提示词的结果。
- 改了 `backend/app/rules/*.yaml`，或者后端拼提示词、解析模型输出的逻辑：运行 `backend/.venv/bin/python scripts/export_rules.py`，更新在线版用的副本和对照样例；然后在 `frontend/src/core/analysis.ts` 里做同样的修改，直到 `npm test` 通过。
- 改了界面或在线版的逻辑：运行 `python3 scripts/build_page.py hosted` 重新生成在线版并发布。
