"""演示项目：载入的内容要符合系统自己的规则，载入后和普通项目一样可用。"""

from app.rules import (
    appeals_keys,
    category_keys,
    disposition_keys,
    load_sample_project,
    priority_keys,
    subcategory_keys,
)


def _load(client) -> dict:
    resp = client.post("/api/projects/sample")
    assert resp.status_code == 201
    return resp.json()


def test_sample_content_follows_the_rules():
    sample = load_sample_project()
    inputs = {i["ref"]: i for i in sample["inputs"]}
    refs = [r["ref"] for r in sample["requirements"]]
    assert len(refs) == len(set(refs))

    for item in sample["requirements"]:
        label = item["title"]
        assert item.get("appeals") is None or item["appeals"] in appeals_keys(), label
        assert item.get("priority", "medium") in priority_keys(), label
        category = item.get("category", "unknown")
        assert category in category_keys() | {"unknown"}, label
        if item.get("subcategory"):
            assert item["subcategory"] in subcategory_keys(category), label
        disposition = item.get("disposition", "undecided")
        assert disposition in disposition_keys() | {"undecided"}, label

        if item.get("kind") == "latent":
            # 潜在需求必须有依据，且没验证之前不能是已确认。
            assert item["based_on"], label
            assert set(item["based_on"]) <= set(refs), label
            assert item.get("status", "draft") != "confirmed", label
        else:
            # 客户提出的需求必须能在材料里找到原文。
            assert item["source_quote"] in inputs[item["input"]]["content"], label
        if item.get("status") == "confirmed":
            assert disposition != "undecided", label
        if item.get("status") == "rejected":
            assert item.get("reject_reason"), label
        if "duplicate_of" in item:
            assert item["duplicate_of"] in refs and item["duplicate_of"] != item["ref"], label

    for material in sample["try_materials"]:
        assert material["label"] and material["content"].strip()


def test_load_sample_project(client):
    project = _load(client)
    assert project["is_sample"] is True
    assert "演示" in project["name"]

    sample = load_sample_project()
    inputs = client.get(f"/api/projects/{project['id']}/inputs").json()
    assert len(inputs) == len(sample["inputs"])
    assert all(i["status"] == "processed" for i in inputs)

    reqs = client.get(f"/api/projects/{project['id']}/requirements").json()
    assert len(reqs) == len(sample["requirements"])
    by_title = {r["title"]: r for r in reqs}
    ids = {r["id"] for r in reqs}

    # 引用都换成了这个项目里的真实编号。
    latent = next(r for r in reqs if r["kind"] == "latent")
    assert latent["based_on"] and set(latent["based_on"]) <= ids
    assert latent["input_id"] is None and latent["quote_verified"] is False
    duplicate = by_title["开门不需要等待"]
    assert duplicate["duplicate_of_id"] == by_title["走到门口伸手即开，无需停顿"]["id"]
    assert all(r["quote_verified"] for r in reqs if r["kind"] == "stated")
    assert {r["status"] for r in reqs} >= {"draft", "confirmed", "rejected"}


def test_ordinary_project_is_not_sample(client):
    project = client.post("/api/projects", json={"name": "普通项目"}).json()
    assert project["is_sample"] is False


def test_sample_project_works_like_any_other(client):
    """载入之后：录入、合并、确认、挖掘潜在需求、删除，都和普通项目一样。"""
    project = _load(client)
    pid = project["id"]
    reqs = {r["title"]: r for r in client.get(f"/api/projects/{pid}/requirements").json()}

    resp = client.post(
        f"/api/projects/{pid}/inputs",
        json={"content": "电池用得太快，两个月就要换一次。", "source_type": "客户", "requester": "城西公寓"},
    )
    assert resp.status_code == 201
    assert resp.json()["requirements"]

    source, target = reqs["开门不需要等待"], reqs["走到门口伸手即开，无需停顿"]
    merged = client.post(f"/api/requirements/{source['id']}/merge", json={"target_id": target["id"]})
    assert merged.status_code == 200
    assert merged.json()["target"]["mention_count"] == 2
    assert merged.json()["target"]["requesters"] == ["城北公寓", "城南公寓"]

    confirmed = client.patch(f"/api/requirements/{target['id']}", json={"status": "confirmed"})
    assert confirmed.status_code == 200

    assert client.post(f"/api/projects/{pid}/latent-needs").status_code == 200

    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}/requirements").status_code == 404


def test_loading_twice_gives_independent_projects(client):
    first, second = _load(client), _load(client)
    assert first["id"] != second["id"]
    a = {r["id"] for r in client.get(f"/api/projects/{first['id']}/requirements").json()}
    b = client.get(f"/api/projects/{second['id']}/requirements").json()
    assert a.isdisjoint({r["id"] for r in b})
    # 第二份的引用指向它自己的需求，不会串到第一份上。
    for r in b:
        assert set(r["based_on"]).isdisjoint(a)
        assert r["duplicate_of_id"] not in a
