"""模型提供方。业务代码不直接使用这里的类，一律经过 gateway。"""

import json
import re
from typing import Protocol

import httpx


class LLMError(Exception):
    """模型调用失败（网络、鉴权、返回格式不对等）。"""


class Provider(Protocol):
    name: str
    model: str

    def complete(self, system: str, user: str) -> str: ...


class OpenAICompatibleProvider:
    """兼容 OpenAI Chat Completions 接口的服务。

    多数云端模型服务和本地推理服务都提供这种接口，所以私有化部署时
    只需要把 base_url 指向内网的推理服务。
    """

    name = "openai_compatible"

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float) -> None:
        if not base_url or not model:
            raise LLMError("未配置 LLM_BASE_URL 或 LLM_MODEL")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def complete(self, system: str, user: str) -> str:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
        try:
            resp = httpx.post(
                f"{self.base_url}/chat/completions", headers=headers, json=body, timeout=self.timeout
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"无法连接模型服务：{exc}") from exc
        if resp.status_code != 200:
            raise LLMError(f"模型服务返回 {resp.status_code}：{resp.text[:500]}")
        try:
            content = resp.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"模型服务返回的格式无法识别：{resp.text[:500]}") from exc
        if not isinstance(content, str) or not content.strip():
            raise LLMError("模型返回了空内容")
        return content


_MOCK_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("price", ("价格", "太贵", "便宜", "报价", "折扣", "付款")),
    ("availability", ("交期", "交货", "缺货", "供货", "渠道", "买不到")),
    ("packaging", ("外观", "尺寸", "体积", "包装", "颜色", "配置")),
    ("ease_of_use", ("操作", "易用", "界面", "上手", "学习", "安装", "说明书", "文档")),
    ("assurances", ("可靠", "故障", "质量", "售后", "安全", "保修", "响应")),
    ("lifecycle_cost", ("维护", "能耗", "耗材", "升级", "运维")),
    ("social_acceptance", ("认证", "品牌", "口碑", "环保", "合规", "法规")),
    ("performance", ("性能", "速度", "功能", "精度", "容量", "支持", "慢", "卡")),
]


class MockProvider:
    """不调用任何模型的演示实现。

    只按标点把材料拆成句子、按关键词归类，结果质量远低于真实模型，
    用途是在没有模型密钥时跑通流程，以及让测试不依赖外部服务。
    """

    name = "mock"
    model = "mock-rules-v1"

    def complete(self, system: str, user: str) -> str:
        if "<需求清单>" in user:
            # 发现潜在需求需要真正的推理，规则做不到，演示模式下如实返回空。
            return json.dumps({"hypotheses": []})
        material = _between(user, "<材料", "</材料>")
        material = material.split(">", 1)[1] if ">" in material else material
        existing_raw = _between(user, "<已有需求>", "</已有需求>").removeprefix("<已有需求>")
        try:
            existing = json.loads(existing_raw) if existing_raw.strip() else []
        except ValueError:
            existing = []
        by_title = {e["title"]: e["id"] for e in existing if isinstance(e, dict)}

        items = []
        for sentence in re.split(r"[。！？!?；;\n]+", material):
            s = re.sub(r"^[\s\-•·*]*(\d+[.、)）]\s*)?", "", sentence).strip()
            if len(s) < 6:
                continue
            title = s[:30]
            appeals = next((k for k, words in _MOCK_KEYWORDS if any(w in s for w in words)), None)
            items.append(
                {
                    "title": title,
                    "description": s,
                    "stated_request": s,
                    "underlying_problem": "",
                    "reasoning": "演示模式不做需求分析，标题只是原话的截取。",
                    "confidence": "low",
                    "open_questions": [],
                    "source_quote": s,
                    "appeals": appeals,
                    "priority": "medium",
                    "priority_reason": "演示模式未做优先级判断，统一标为中。",
                    "duplicate_of": by_title.get(title),
                }
            )
        return json.dumps({"requirements": items}, ensure_ascii=False)


def _between(text: str, start: str, end: str) -> str:
    i = text.find(start)
    j = text.find(end, i + len(start)) if i >= 0 else -1
    return text[i:j] if i >= 0 and j >= 0 else ""
