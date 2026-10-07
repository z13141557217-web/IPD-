# IPD App

一款以大模型能力为核心的 IPD（集成产品开发，Integrated Product Development）应用。

当前版本只做一件事：**产品经理的需求分析**。目标不是照单全收地记录客户的话，也不是闭门想象客户要什么，而是做到两件事：

1. **抓住本质**。把客户反馈、访谈记录、会议纪要粘贴进来，应用找出每条诉求，并分析它背后真正要解决的问题：客户的表面诉求是什么、背后的问题是什么、真实需求是什么、这样推断的把握有多大、还需要向客户追问什么。
2. **发现潜在需求**。从已有需求的共性中，提出客户没有明说、但可能真正需要的东西。这些一律是待验证的假设。

为了不让“分析”滑向想当然，应用设了几道关：

- 每条需求必须引用材料原句，后端会核对这句话是否真的出现在材料里。
- 提示词要求模型写出推理过程和把握程度，把握不高时给出要追问客户的问题，由人判断推得对不对。（这一条靠提示词约束，其余三条由程序强制。）
- 潜在需求假设必须指明依据的是哪些已有需求，给不出依据的直接丢弃。
- 潜在需求在标记为“已向客户验证成立”之前，不能确认为正式需求。

此外，应用按 $APPEALS 维度归类需求、给出优先级建议、标出可能重复的需求。

## 运行

### 用 Docker Compose（推荐）

需要先安装 Docker。

```bash
cp .env.example .env      # 然后编辑 .env，至少填写 POSTGRES_PASSWORD
docker compose up -d --build
```

浏览器打开 <http://localhost:8080>。

### 本地开发

需要 Python 3.13、Node.js 22 和一个 PostgreSQL 16。

```bash
# 后端
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://ipd:ipd@localhost:5432/ipd
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload --port 8000

# 前端（另开一个终端）
cd frontend
npm install
npm run dev               # 打开 http://localhost:5173
```

运行测试：`cd backend && .venv/bin/pytest`

## 接入大模型

默认是**演示模式**（`LLM_PROVIDER=mock`）：不调用任何模型，只按标点拆句、按关键词归类，用来跑通流程，结果没有参考价值。需求分析和潜在需求发现都依赖模型的推理能力，演示模式下不会有分析内容。

接入真实模型时，在 `.env` 中设置：

```
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=模型服务地址，填到 /v1 这一级
LLM_API_KEY=密钥
LLM_MODEL=模型名称
```

应用调用的是 OpenAI Chat Completions 格式的接口（`POST {LLM_BASE_URL}/chat/completions`）。私有化部署时把 `LLM_BASE_URL` 指向内网的推理服务即可。接口格式不同的模型服务需要在 `backend/app/llm/providers.py` 里新增一个提供方。

## 目录结构

```
.
├── backend/
│   ├── app/
│   │   ├── api/          # HTTP 接口
│   │   ├── llm/          # 模型网关与各提供方，业务代码只通过网关调用模型
│   │   ├── rules/        # IPD 规则数据（$APPEALS 维度等），改 YAML 即可调整
│   │   ├── services/     # 业务逻辑：需求提取
│   │   └── models.py     # 数据表定义
│   ├── alembic/          # 数据库迁移脚本
│   └── tests/
├── frontend/             # React + TypeScript 界面
├── docs/                 # 需求、设计与决策记录
└── docker-compose.yml
```

## 设计约定

这几条是为后续扩展和私有化部署预留的，改动代码时请保持：

- **模型调用只走网关**（`app/llm/gateway.py`）。业务代码不直接依赖任何一家模型服务。
- **每次模型调用都有记录**（`llm_calls` 表）：提示词、原始返回、所用模型、提示词版本、耗时。修改提示词时请同步修改 `PROMPT_VERSION`。
- **IPD 规则是数据，不写死在代码里**（`app/rules/*.yaml`）。
- **模型的结论必须能核对**。每条需求带原文依据，后端会检查这句话是否真的出现在材料里，找不到时界面会标红。
- **模型只提建议，人做决定**。模型产出的需求一律是"待确认"状态。
- **推断和事实分开存**。客户原话（`source_quote`）、表面诉求（`stated_request`）是事实；背后的问题、真实需求、潜在需求是推断，必须带推理过程，潜在需求还必须经过验证。
- **数据库结构变更只通过迁移脚本**（`alembic revision --autogenerate`），不手工改库。

## 尚未实现

登录与权限、多用户、文件上传（目前只能粘贴文字）、向量检索、与外部系统的集成。数据表中的 `owner` / `created_by` 字段目前固定为 `local`。
