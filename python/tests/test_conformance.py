"""The 12 required behaviours of conformance/README.md, with its exact fixtures,
for the sync Client and for the AsyncClient (with httpx and with the urllib fallback)."""

from __future__ import annotations

import asyncio
import builtins
import json
import socket
import threading
import time
import urllib.request

import pytest

import keepyourprompts._async as async_mod
from keepyourprompts import (
    AsyncClient,
    Client,
    MissingVariableError,
    ProtocolError,
    UnavailableError,
    parse_manifest,
    render_template,
    sha256_hex,
    template_variables,
)

from .conftest import CONFORMANCE, FIXTURES, GREETING_V4, GREETING_V5, KEY, deploy, net_options

CASES = json.loads((CONFORMANCE / "cases.json").read_text("utf-8"))
V12, V13, STALE, TAMPERED = (FIXTURES / n for n in ("v12", "v13", "v11-stale", "tampered-v14"))


# 1. Render ------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES["render"], ids=lambda c: c["template"])
def test_1_render(case):
    if "error" in case:
        assert case["error"] == "missing_variable"
        with pytest.raises(MissingVariableError) as e:
            render_template(case["template"], case["vars"])
        assert e.value.names == (case["variable"],)
    else:
        assert render_template(case["template"], case["vars"], strict=not case.get("lenient")) == case["out"]


# 2. Variables -------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES["variables"])
def test_2_variables(case):
    assert template_variables(case["template"]) == case["out"]


# 3. Manifest ------------------------------------------------------------------
@pytest.mark.parametrize("case", CASES["manifest"], ids=lambda c: c.get("why", c.get("file", "")))
def test_3_manifest(case):
    data = (CONFORMANCE / case["file"]).read_text("utf-8") if "file" in case else case["json"]
    if not case["valid"]:
        with pytest.raises(ProtocolError):
            parse_manifest(data)
        return
    m = parse_manifest(data)
    if "prompts" in case:
        assert sorted(m.prompts) == case["prompts"]
    for p in m.prompts.values():
        assert isinstance(p.variables, tuple)
    if "json" in case:
        assert m.prompts["p"].variables == ()


@pytest.mark.parametrize("case", CASES["sha256"])
def test_3_sha256(case):
    assert sha256_hex(case["in"]) == case["out"]


# 4. Hash check -------------------------------------------------------------------
def test_4_tampered_manifest_is_refused(cdn, tmp_path):
    s = cdn(cdn=TAMPERED, origin=TAMPERED)
    with Client(**net_options(s, snapshot_dir=str(V12), cache_dir=str(tmp_path / "cache"))) as c:
        assert c.revision == 12
        assert c.refresh() is False
        assert c.revision == 12
        assert c.prompt("greeting").version == 4
        assert "failed sha256 verification" in c.status().last_error
    with pytest.raises(UnavailableError, match="sha256"):
        Client(**net_options(s, startup_timeout=0.3))


# 5. Start from local ------------------------------------------------------------------
def test_5_start_from_snapshot_without_network():
    start = time.monotonic()
    with Client(
        app="demo",
        delivery_key=KEY,
        cdn_url="http://127.0.0.1:9/v1/d",
        origin_url="http://127.0.0.1:9/v1/delivery",
        snapshot_dir=str(V12),
    ) as c:
        assert time.monotonic() - start < 0.5
        p = c.prompt("greeting")
        assert p.version == 4
        assert p.text == GREETING_V4
        assert c.status().source == "snapshot"
        assert c.render("greeting", name="Ana", company="Acme") == "Hello Ana, welcome to Acme."
        assert c.render("greeting", {"name": "Ana", "company": "Acme"}) == "Hello Ana, welcome to Acme."
        assert c.render("triage", company="Acme") == "You are a support agent for Acme. Literal {{braces}} stay."
        assert c.get("agents/reviewer") == "Review the diff."
        assert c.get("empty") == ""


# 6. Mirror order and fallback ------------------------------------------------------------
def test_6_mirror_order(cdn):
    s = cdn(cdn=V12, origin=V12, git=V12)
    with Client(**net_options(s, git_mirror=s.base + "/acme/prompts/main/.kyp", git_token="github_pat_test")) as c:
        assert c.status().source == "cdn"
        st = s.stats()
        assert st["origin"]["200"] == 0 and st["git"]["200"] == 0
        s.down("cdn")
        assert c.refresh() is True
        assert c.status().source == "origin"
        assert "cdn: HTTP 503" in c.status().last_error
        s.down("origin")
        assert c.refresh() is True
        assert c.status().source == "git"
        st = s.stats()
        assert st["git"]["auth"] == "Bearer github_pat_test"
        assert st["cdn"]["auth"] is None  # the delivery key travels in the path
        assert all(KEY not in m.url for m in c.status().mirrors)
        s.up("cdn")
        assert c.refresh() is True
        assert c.status().source == "cdn"
        assert c.status().last_error == ""


# 7. Revalidation -------------------------------------------------------------------
def test_7_revalidation_304(cdn):
    s = cdn(cdn=V12)
    updates = []
    with Client(**net_options(s, on_update=updates.append)) as c:
        before = c.prompt("greeting")
        assert c.refresh() and c.refresh()
        assert s.stats()["cdn"]["304"] == 2
        assert c.prompt("greeting") is before  # nothing was swapped
        assert updates == []
        assert c.status().last_success is not None


# 8. Hot update -------------------------------------------------------------------
def test_8_hot_update(cdn, tmp_path):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv, origin=srv)
    with Client(**net_options(s)) as c:
        updates = []
        c.on_update(updates.append)
        assert c.prompt("greeting").version == 4
        deploy("v13", srv)
        assert c.refresh() is True
        assert c.prompt("greeting").version == 5
        assert c.get("greeting") == GREETING_V5
        assert len(updates) == 1
        u = updates[0]
        assert (u.old_revision, u.new_revision, u.source, u.changed) == (12, 13, "cdn", ("greeting",))
        c.refresh()
        assert len(updates) == 1


def test_8_hot_update_background_thread(cdn, tmp_path):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    calls = []
    with Client(**net_options(s, auto_refresh=True, poll_interval=0.1, on_update=calls.append)) as c:
        deploy("v13", srv)
        from .conftest import eventually

        assert eventually(lambda: c.revision == 13)
        time.sleep(0.05)
        assert len(calls) == 1


# 9. Stale mirror -------------------------------------------------------------------
def test_9_stale_mirror_is_ignored(cdn):
    s = cdn(cdn=STALE, origin=STALE)
    with Client(**net_options(s, snapshot_dir=str(V12))) as c:
        assert c.refresh() is False
        assert c.revision == 12
        assert c.prompt("greeting").version == 4
        assert "stale manifest ignored (revision 11 < held 12)" in c.status().last_error


# 10. Failures never evict -------------------------------------------------------------
def test_10_failures_never_evict(cdn):
    s = cdn(cdn=V12, origin=V12)
    with Client(**net_options(s)) as c:
        s.down("cdn")
        s.down("origin")
        time.sleep(0.03)
        for _ in range(3):
            assert c.refresh() is False
        assert c.get("greeting") == GREETING_V4
        st = c.status()
        assert st.ready and st.revision == 12
        assert "cdn: HTTP 503" in st.last_error and "origin: HTTP 503" in st.last_error
        assert st.stale_for >= 0.025
        assert next(m for m in st.mirrors if m.name == "cdn").consecutive_failures == 3


# 11. Disk cache -------------------------------------------------------------------
def test_11_disk_cache_restart(cdn, tmp_path):
    s = cdn(cdn=V12)
    Client(**net_options(s, cache_dir=str(tmp_path / "cache"))).close()
    cached = tmp_path / "cache/acme/demo/prod/envs/demo/prod.json"
    assert '"revision": 12' in cached.read_text()
    start = time.monotonic()
    with Client(app="demo", cache_dir=str(tmp_path / "cache")) as c:
        assert time.monotonic() - start < 0.5
        assert c.status().source == "disk-cache"
        assert c.prompt("greeting").version == 4
        assert c.get("agents/reviewer") == "Review the diff."


# 12. Read path -------------------------------------------------------------------
def test_12_read_path_no_io_and_thread_safe(cdn, tmp_path, monkeypatch):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    c = Client(**net_options(s, cache_dir=str(tmp_path / "cache")))
    try:
        # No I/O: with files, sockets and urllib forbidden, reads still work.
        def boom(*a, **k):
            raise AssertionError("I/O on the read path")

        with monkeypatch.context() as m:
            m.setattr(builtins, "open", boom)
            m.setattr(socket, "socket", boom)
            m.setattr(urllib.request.OpenerDirector, "open", boom)
            for _ in range(10_000):
                c.get("greeting")
            assert c.render("greeting", name="a", company="b") == "Hello a, welcome to b."
            assert c.prompt("triage").version == 7

        # Many threads read while the state is swapped: each read sees one whole state.
        stop = threading.Event()
        errors = []

        def reader():
            try:
                while not stop.is_set():
                    p = c.prompt("greeting")
                    assert p.text == (GREETING_V4 if p.version == 4 else GREETING_V5)
                    assert c.get("greeting") in (GREETING_V4, GREETING_V5)
                    time.sleep(0)  # let the refresher have the GIL now and then
            except Exception as e:  # pragma: no cover
                errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(8)]
        for t in threads:
            t.start()
        deploy("v13", srv)
        assert c.refresh()
        time.sleep(0.05)
        stop.set()
        for t in threads:
            t.join()
        assert errors == []
        assert c.prompt("greeting").version == 5
    finally:
        c.close()


# The same behaviours through the AsyncClient --------------------------------------------
@pytest.fixture(params=["httpx", "urllib"])
def http_mode(request, monkeypatch):
    if request.param == "httpx":
        pytest.importorskip("httpx")
    else:
        monkeypatch.setattr(async_mod, "optional_httpx", lambda: None)
    return request.param


async def test_async_5_start_from_local():
    async with AsyncClient(app="demo", snapshot_dir=str(V12)) as c:
        assert c.prompt("greeting").version == 4
        assert c.status().source == "snapshot"
        assert c.render("greeting", name="Ana", company="Acme") == "Hello Ana, welcome to Acme."


async def test_async_6_7_8_mirrors_revalidation_hot_update(cdn, tmp_path, http_mode):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv, origin=srv, git=srv)
    updates = []

    async def on_update(u):  # coroutine callbacks are awaited
        updates.append(u)

    c = await AsyncClient.from_env(
        {}, **net_options(s, git_mirror=s.base + "/acme/prompts/main/.kyp", git_token="tok", on_update=on_update)
    )
    try:
        assert (c._http is not None) == (http_mode == "httpx")
        assert c.status().source == "cdn"
        assert await c.refresh()
        assert s.stats()["cdn"]["304"] == 1
        s.down("cdn")
        assert await c.refresh() and c.status().source == "origin"
        s.down("origin")
        assert await c.refresh() and c.status().source == "git"
        assert s.stats()["git"]["auth"] == "Bearer tok"
        assert updates == []
        deploy("v13", srv)
        assert await c.refresh()
        assert c.prompt("greeting").version == 5
        assert [(u.old_revision, u.new_revision, u.changed) for u in updates] == [(12, 13, ("greeting",))]
    finally:
        await c.close()


async def test_async_4_9_10_tampered_stale_failures(cdn, http_mode):
    s = cdn(cdn=STALE, origin=TAMPERED)
    async with AsyncClient(**net_options(s, snapshot_dir=str(V12))) as c:
        assert await c.refresh() is False
        assert c.revision == 12
        err = c.status().last_error
        assert "stale manifest ignored" in err and "failed sha256 verification" in err
        s.down("cdn")
        s.down("origin")
        assert await c.refresh() is False
        assert c.get("greeting") == GREETING_V4
        assert "HTTP 503" in c.status().last_error


async def test_async_11_12_cache_and_concurrent_tasks(cdn, tmp_path, http_mode):
    srv = deploy("v12", tmp_path / "srv")
    s = cdn(cdn=srv)
    async with AsyncClient(**net_options(s, cache_dir=str(tmp_path / "cache"))) as c:
        stop = False

        async def reader():
            while not stop:
                p = c.prompt("greeting")
                assert p.text == (GREETING_V4 if p.version == 4 else GREETING_V5)
                await asyncio.sleep(0)

        tasks = [asyncio.ensure_future(reader()) for _ in range(50)]
        deploy("v13", srv)
        assert await c.refresh()
        stop = True
        await asyncio.gather(*tasks)
    async with AsyncClient(app="demo", cache_dir=str(tmp_path / "cache")) as c2:
        assert c2.status().source == "disk-cache"
        assert c2.revision == 13


async def test_async_startup_timeout(cdn, http_mode):
    s = cdn(cdn=V12, origin=V12)
    s.down("cdn")
    s.down("origin")
    start = time.monotonic()
    # A loaded machine may spend the budget on the first connection: either error is fine.
    with pytest.raises(UnavailableError, match=r"HTTP 503|timed out|deadline exceeded"):
        await AsyncClient(**net_options(s, startup_timeout=0.4))
    assert 0.25 <= time.monotonic() - start < 2
    c = await AsyncClient(**net_options(s, startup_timeout=0.2, start_empty=True))
    assert not c.status().ready
    s.up("origin")
    assert await c.refresh()
    assert c.status().source == "origin"
    await c.close()
