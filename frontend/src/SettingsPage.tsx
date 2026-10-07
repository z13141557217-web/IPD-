import { useEffect, useState } from "react";

import { api, type AppSettings, type LLMTestResult } from "./api";

interface Props {
  /** 保存成功后通知外层刷新“当前用的是哪个模型” */
  onSaved: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "发生未知错误";
}

export default function SettingsPage({ onSaved }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [provider, setProvider] = useState<"mock" | "openai_compatible">("mock");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  // 密钥输入框始终从空开始：留空表示不改，后端不会把已保存的密钥发回来。
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test">(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<LLMTestResult | null>(null);

  function apply(next: AppSettings) {
    setSettings(next);
    setProvider(next.llm.provider === "openai_compatible" ? "openai_compatible" : "mock");
    setBaseUrl(next.llm.base_url);
    setModel(next.llm.model);
    setApiKey("");
  }

  useEffect(() => {
    api.getSettings().then(apply).catch((err) => setError(messageOf(err)));
  }, []);

  const dirty =
    settings !== null &&
    (provider !== settings.llm.provider ||
      baseUrl !== settings.llm.base_url ||
      model !== settings.llm.model ||
      apiKey !== "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    setTest(null);
    try {
      const llm = await api.saveLlmSettings({
        provider,
        base_url: baseUrl,
        model,
        api_key: apiKey === "" ? null : apiKey,
      });
      apply({ ...settings, llm });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    if (!settings) return;
    setBusy("save");
    setError(null);
    try {
      const llm = await api.saveLlmSettings({
        provider: settings.llm.provider === "openai_compatible" ? "openai_compatible" : "mock",
        base_url: settings.llm.base_url,
        model: settings.llm.model,
        api_key: "",
      });
      apply({ ...settings, llm });
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    setError(null);
    setTest(null);
    try {
      setTest(await api.testLlm());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  if (!settings) {
    return <div className="settings">{error ? <div className="banner banner-error">{error}</div> : <p className="muted">正在读取设置…</p>}</div>;
  }

  const usesModel = provider === "openai_compatible";

  if (settings.llm.provider === "hosted") {
    return (
      <div className="settings">
        <h2>设置</h2>
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
        <section className="panel">
          <h3>模型</h3>
          <p>
            在线版由这个页面直接调用 Claude 做分析，不需要填写地址和密钥。它用的是你自己的 Claude
            账号用量，第一次分析时会请你确认是否允许。
          </p>
          <div className="actions">
            <button className="btn" disabled={busy !== null} onClick={() => void runTest()}>
              {busy === "test" ? "正在测试…" : "测试能否调用模型"}
            </button>
          </div>
          {test && (
            <p className={test.ok ? "test-ok" : "test-bad"} role="status">
              {test.ok ? test.message : `调用失败：${test.message}`}
              {test.latency_ms > 0 && `（耗时 ${(test.latency_ms / 1000).toFixed(1)} 秒）`}
            </p>
          )}
        </section>
        <section className="panel">
          <h3>数据保存在哪里</h3>
          <p>
            项目、材料、需求和每一次模型调用的记录，都保存在这个页面自带的存储里，刷新或换设备后仍然在。
            这个页面默认只有你能打开；如果你把它分享给别人，对方也能看到这些数据。
          </p>
        </section>
        <section className="panel">
          <h3>关于</h3>
          <dl className="about">
            <dt>版本</dt>
            <dd>{settings.version}</dd>
          </dl>
        </section>
      </div>
    );
  }

  return (
    <div className="settings">
      <h2>设置</h2>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        <h3>模型接入</h3>
        <p className="muted">
          {settings.llm.source === "env"
            ? "当前使用的是部署时环境变量里的配置。在这里保存后，以这里的为准。"
            : "当前使用的是在这里保存的配置。保存后立即生效，不需要重启。"}
        </p>
        <form onSubmit={save}>
          <label className="setting">
            接入方式
            <select
              id="llm-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              <option value="mock">演示模式（不调用模型）</option>
              <option value="openai_compatible">OpenAI 兼容接口</option>
            </select>
            <small>
              {usesModel
                ? "多数云端模型服务和本地推理服务都提供这种接口。"
                : "演示模式只按标点拆句，不做任何分析，用来跑通流程。"}
            </small>
          </label>

          {usesModel && (
            <>
              <label className="setting">
                接口地址
                <input
                  id="llm-base-url"
                  value={baseUrl}
                  maxLength={500}
                  placeholder="https://模型服务的域名"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <small>
                  填服务商文档里的 base_url，不要带 /chat/completions，程序会自动加上。有的服务商要求以 /v1
                  结尾，有的不要，以它的文档为准。
                </small>
              </label>
              <label className="setting">
                模型名称
                <input
                  id="llm-model"
                  value={model}
                  maxLength={100}
                  placeholder="服务商文档里的模型标识"
                  onChange={(e) => setModel(e.target.value)}
                />
              </label>
              <label className="setting">
                密钥
                <input
                  id="llm-api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  maxLength={500}
                  placeholder={
                    settings.llm.api_key_set
                      ? `已保存（${settings.llm.api_key_hint || "已设置"}），留空表示不修改`
                      : "粘贴密钥"
                  }
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <small>
                  密钥只保存在你部署的这套程序的数据库里，保存后不再显示，也不会写入调用记录。
                  {settings.llm.api_key_set && settings.llm.source === "settings" && (
                    <>
                      {" "}
                      <button type="button" className="link" disabled={busy !== null} onClick={() => void clearKey()}>
                        清除已保存的密钥
                      </button>
                    </>
                  )}
                </small>
              </label>
            </>
          )}

          <div className="actions">
            <button className="btn btn-primary" disabled={busy !== null || !dirty}>
              {busy === "save" ? "正在保存…" : "保存"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || dirty}
              title={dirty ? "先保存，再测试" : undefined}
              onClick={() => void runTest()}
            >
              {busy === "test" ? "正在测试…" : "测试连接"}
            </button>
            {saved && !dirty && <span className="test-ok">已保存</span>}
            {dirty && <span className="muted">有未保存的修改</span>}
          </div>
          {test && (
            <p className={test.ok ? "test-ok" : "test-bad"} role="status">
              {test.ok ? test.message : `连接失败：${test.message}`}
              {test.latency_ms > 0 && `（耗时 ${(test.latency_ms / 1000).toFixed(1)} 秒）`}
            </p>
          )}
        </form>
      </section>

      <section className="panel">
        <h3>关于</h3>
        <dl className="about">
          <dt>版本</dt>
          <dd>{settings.version}</dd>
          <dt>更新记录</dt>
          <dd>见仓库根目录的 CHANGELOG.md</dd>
        </dl>
      </section>
    </div>
  );
}
