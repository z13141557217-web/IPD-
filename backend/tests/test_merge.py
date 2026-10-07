MATERIAL_A = "设备开机太慢，要等两分钟。\n报价比竞品高了一成，希望能给折扣。"
MATERIAL_B = "开机速度实在受不了，每次都要等。\n售后响应慢，报修三天没人管。"


def _setup(client):
    pid = client.post("/api/projects", json={"name": "门锁"}).json()["id"]
    a = client.post(
        f"/api/projects/{pid}/inputs", json={"content": MATERIAL_A, "requester": "城南公寓"}
    ).json()["requirements"]
    b = client.post(
        f"/api/projects/{pid}/inputs", json={"content": MATERIAL_B, "requester": "城北公寓"}
    ).json()["requirements"]
    return pid, [r["id"] for r in a], [r["id"] for r in b]


def _get(client, pid, rid):
    return next(r for r in client.get(f"/api/projects/{pid}/requirements").json() if r["id"] == rid)


def test_merge_counts_mentions_and_requesters(client):
    pid, a, b = _setup(client)
    resp = client.post(f"/api/requirements/{b[0]}/merge", json={"target_id": a[0]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["merged"]["status"] == "merged"
    assert body["merged"]["duplicate_of_id"] == a[0]
    assert body["target"]["mention_count"] == 2
    assert body["target"]["requesters"] == ["城北公寓", "城南公寓"]
    # 列表接口给出同样的结果
    assert _get(client, pid, a[0])["mention_count"] == 2
    assert _get(client, pid, a[1])["mention_count"] == 1
    merged_only = client.get(f"/api/projects/{pid}/requirements", params={"status": "merged"}).json()
    assert [r["id"] for r in merged_only] == [b[0]]


def test_merging_a_target_moves_its_children_along(client):
    pid, a, b = _setup(client)
    client.post(f"/api/requirements/{b[0]}/merge", json={"target_id": a[0]})
    # a[0] 又被并入 a[1]：原先并入 a[0] 的 b[0] 应该跟着指向 a[1]
    resp = client.post(f"/api/requirements/{a[0]}/merge", json={"target_id": a[1]})
    assert resp.status_code == 200
    assert resp.json()["target"]["mention_count"] == 3
    assert _get(client, pid, b[0])["duplicate_of_id"] == a[1]


def test_merged_requirement_is_not_offered_to_the_model_again(client):
    pid, a, b = _setup(client)
    client.post(f"/api/requirements/{b[0]}/merge", json={"target_id": a[0]})
    client.post(f"/api/projects/{pid}/inputs", json={"content": "安装说明书看不懂。"})
    prompt = client.get(f"/api/projects/{pid}/llm-calls").json()[0]["request"]["user"]
    existing = prompt.split("<已有需求>")[1].split("</已有需求>")[0]
    assert f'"id": {b[0]},' not in existing
    assert f'"id": {a[0]},' in existing


def test_merge_can_be_undone(client):
    pid, a, b = _setup(client)
    client.post(f"/api/requirements/{b[0]}/merge", json={"target_id": a[0]})
    undone = client.patch(f"/api/requirements/{b[0]}", json={"status": "draft"})
    assert undone.status_code == 200
    assert _get(client, pid, a[0])["mention_count"] == 1


def test_merge_rejects_invalid_targets(client):
    pid, a, b = _setup(client)
    other = client.post("/api/projects", json={"name": "别的项目"}).json()["id"]
    foreign = client.post(f"/api/projects/{other}/inputs", json={"content": MATERIAL_A}).json()[
        "requirements"
    ][0]["id"]

    def merge(source, target):
        return client.post(f"/api/requirements/{source}/merge", json={"target_id": target}).status_code

    assert merge(a[0], a[0]) == 422
    assert merge(a[0], foreign) == 422
    assert merge(a[0], 9999) == 404
    client.patch(f"/api/requirements/{a[1]}", json={"status": "rejected"})
    assert merge(a[0], a[1]) == 409
    assert merge(b[0], a[0]) == 200
    assert merge(b[0], b[1]) == 409  # 已经并入别处
    assert merge(b[1], b[0]) == 409  # 目标已被合并
    # 不能通过普通更新把状态直接设成“已合并”
    assert client.patch(f"/api/requirements/{b[1]}", json={"status": "merged"}).status_code == 422
