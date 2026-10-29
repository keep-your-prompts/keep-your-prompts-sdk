from __future__ import annotations

import dataclasses
import http.server
import json
import logging
import threading
import time

import pytest

from keepyourprompts import (
    AsyncClient,
    Client,
    KypError,
    Mirror,
    MissingVariableError,
    NotFoundError,
    Options,
    UnavailableError,
)
from keepyourprompts.__main__ import main as cli

from .conftest import FIXTURES, GREETING_V5, KEY, deploy, eventually, net_options, snapshot_of

V12 = FIXTURES / "v12"
GREETING_SHA = "5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d"


def test_embedded_snapshot_round_trip():
    snap = snapshot_of("v12")
    with Client(app="demo", embedded_snapshot=snap) as c:
        assert c.status().source == "embedded"
        assert c.prompt("greeting").version == 4
        assert c.to_snapshot() == snap
        assert c.refresh() is False  # nothing to poll


def test_embedded_tampered_is_rejected():
    with pytest.raises(UnavailableError):
        Client(app="demo", embedded_snapshot=snapshot_of("tampered-v14"))


def test_newest_local_copy_wins(tmp_path):
    deploy("v13", tmp_path / "cache" / "acme" / "demo" / "prod")
    with Client(app="demo", snapshot_dir=str(V12), cache_dir=str(tmp_path / "cache")) as c:
        assert c.revision == 13
        assert c.status().source == "disk-cache"


def test_snapshot_folder_is_polled_without_network(tmp_path):
    d = deploy("v12", tmp_path / "snap")
    with Client(app="demo", snapshot_dir=str(d), auto_refresh=False) as c:
        deploy("v13", d)
        assert c.refresh()
        assert c.revision == 13


def test_tampered_blob_is_fetched_from_another_mirror(cdn, tmp_path, caplog):
    bad = deploy("v13", tmp_path / "bad")
    (bad / "blobs/a413e0e86cf132f04fbac888b900733641d384cd0e9b42fd0042cf6942701cf2").write_text("evil")
    s = cdn(cdn=bad, origin=FIXTURES / "v13")
    with caplog.at_level(logging.WARNING, logger="keepyourprompts"), Client(**net_options(s)) as c:
        assert c.get("greeting") == GREETING_V5
        assert c.status().source == "cdn"
    assert any("failed sha256 verification" in r.getMessage() for r in caplog.records)


def test_startup_timeout_and_start_empty(cdn):
    s = cdn(cdn=V12, origin=V12)
    s.down("cdn")
    s.down("origin")
    start = time.monotonic()
    with pytest.raises(UnavailableError, match=r"HTTP 503|timed out|deadline exceeded"):
        Client(**net_options(s, startup_timeout=0.4))
    assert 0.25 <= time.monotonic() - start < 2
    with Client(**net_options(s, startup_timeout=0.2, start_empty=True)) as c:
        assert not c.status().ready
        assert c.try_get("greeting") is None
        with pytest.raises(NotFoundError, match="nothing loaded"):
            c.get("greeting")
        s.up("origin")
        assert c.refresh()
        assert c.status().source == "origin"


def test_unreachable_host_respects_startup_timeout():
    start = time.monotonic()
    with pytest.raises(UnavailableError):
        Client(
            app="demo",
            delivery_key=KEY,
            cdn_url="http://127.0.0.1:9/v1/d",
            origin_url="http://127.0.0.1:9/v1/delivery",
            startup_timeout=0.3,
        )
    assert time.monotonic() - start < 2


def test_invalid_configuration():
    with pytest.raises(UnavailableError):
        Client(app="demo")
    with Client(app="demo", start_empty=True) as c:
        assert not c.status().ready
    with pytest.raises(KypError, match="slug"):
        Client(app="Bad App")
    with pytest.raises(KypError, match="invalid character"):
        Client(app="demo", delivery_key="kypd_x/../y")
    with pytest.raises(KypError, match="app is not set"):
        Client()


def test_backoff_between_background_rounds(cdn):
    s = cdn(cdn=V12, origin=V12)
    with Client(**net_options(s, auto_refresh=True, poll_interval=0.1, max_backoff=10)) as c:
        s.down("cdn")
        time.sleep(1.5)
        st = s.stats()
        assert st["origin"]["200"] + st["origin"]["304"] >= 8
        assert st["cdn"]["503"] <= 5
        assert next(m for m in c.status().mirrors if m.name == "cdn").consecutive_failures >= 2


def test_render_and_prompt_objects():
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        with pytest.raises(MissingVariableError) as e:
            c.render("greeting", name="Ana")
        assert e.value.names == ("company",)
        assert c.render("greeting", {"name": "Ana"}, strict=False) == "Hello Ana, welcome to {{ company }}."
        assert c.render("greeting", name="Ana", on_missing="empty") == "Hello Ana, welcome to ."
        assert c.render("greeting", {"name": "Ana"}, company=7) == "Hello Ana, welcome to 7."
        p = c.prompt("greeting")
        assert (p.name, p.version, p.sha256, p.variables) == ("greeting", 4, GREETING_SHA, ("name", "company"))
        assert p.render(name="A", company="B") == "Hello A, welcome to B."
        with pytest.raises(dataclasses.FrozenInstanceError):
            p.text = "x"  # type: ignore[misc]
        assert sorted(c.names()) == ["agents/reviewer", "empty", "greeting", "triage"]
        assert "agents/reviewer" in c
        with pytest.raises(NotFoundError, match=r'"nope" \(demo/prod revision 12\)'):
            c.prompt("nope")
        with pytest.raises(KeyError):  # NotFoundError is a KeyError
            c.get("nope")


def test_from_env(monkeypatch):
    o = Options.from_env(
        {
            "KYP_APP": "demo",
            "KYP_ENV": "staging",
            "KYP_DELIVERY_KEY": KEY,
            "KYP_POLL_INTERVAL": "2.5",
            "KYP_GIT_MIRROR": "https://raw.githubusercontent.com/acme/prompts/main/.kyp",
            "KYP_GIT_TOKEN": "t",
        }
    )
    assert (o.app, o.env, o.delivery_key, o.poll_interval, o.git_token) == ("demo", "staging", KEY, 2.5, "t")
    monkeypatch.setenv("KYP_APP", "demo")
    monkeypatch.setenv("KYP_SNAPSHOT_DIR", str(V12))
    with Client.from_env() as c:
        assert c.revision == 12
    with pytest.raises(TypeError):
        Options.from_env({}, no_such_option=1)


def test_custom_mirrors(cdn):
    s = cdn(cdn=V12)
    with Client(app="demo", mirrors=[Mirror("mine", s.base + "/v1/d/" + KEY)]) as c:
        assert c.status().source == "mine"


# --- outcomes -------------------------------------------------------------------
class FakeApi:
    def __init__(self, status: int = 202) -> None:
        self.calls: list = []
        self.status = status
        api = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length", "0"))
                api.calls.append((self.path, dict(self.headers), json.loads(self.rfile.read(n))))
                self.send_response(api.status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/" % self.server.server_address[1]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def api():
    a = FakeApi()
    yield a
    a.stop()


def expected_events():
    return [
        {
            "env": "prod",
            "prompt": "greeting",
            "sha256": GREETING_SHA,
            "outcome": "success",
            "latencyMs": 812,
            "inputTokens": 120,
            "outputTokens": 40,
        },
        {
            "env": "prod",
            "prompt": "triage",
            "sha256": "f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf",
            "outcome": "feedback_negative",
        },
    ]


def report_some(c):
    c.report("greeting", "success", latency_ms=812.4, input_tokens=120, output_tokens=40)
    c.report("triage", "feedback_negative")
    c.report("greeting", "meh")  # unknown outcome: dropped
    c.report("unknown", "failure")  # not deployed: dropped


def test_outcomes_are_buffered_and_posted(api):
    c = Client(app="demo", snapshot_dir=str(V12), api_key="kyp_live_secret", api_url=api.url)
    report_some(c)
    assert api.calls == []
    c.close()  # flushes
    assert len(api.calls) == 1
    path, headers, body = api.calls[0]
    assert path == "/v1/apps/demo/outcomes"
    assert headers["Authorization"] == "Bearer kyp_live_secret"
    assert body == expected_events()


def test_outcomes_background_flush(api):
    with Client(app="demo", snapshot_dir=str(V12), api_key="k", api_url=api.url, outcome_flush_interval=0.05) as c:
        c.report("greeting", "success")
        assert eventually(lambda: len(api.calls) == 1)


def test_outcomes_fail_silent_and_bounded(api):
    api.status = 503
    with Client(
        app="demo", snapshot_dir=str(V12), api_key="k", api_url=api.url, outcome_buffer_size=3, outcome_flush_interval=0
    ) as c:
        for i in range(5):
            c.report("greeting", "success", latency_ms=i)
        c.flush()
        assert len(api.calls) == 1
        api.status = 202
        c.flush()
        assert [e["latencyMs"] for e in api.calls[1][2]] == [2, 3, 4]
    down = Client(app="demo", snapshot_dir=str(V12), api_key="k", api_url="http://127.0.0.1:9")
    down.report("greeting", "success")
    down.close()  # must not raise


def test_outcomes_noop_without_api_key(api):
    with Client(app="demo", snapshot_dir=str(V12)) as c:
        c.report("greeting", "success")
        c.flush()
    assert api.calls == []


@pytest.mark.parametrize("httpx", [True, False])
async def test_async_outcomes(api, monkeypatch, httpx):
    import keepyourprompts._async as m

    if not httpx:
        monkeypatch.setattr(m, "optional_httpx", lambda: None)
    c = await AsyncClient(app="demo", snapshot_dir=str(V12), api_key="kyp_live_secret", api_url=api.url)
    report_some(c)
    await c.close()
    assert len(api.calls) == 1
    assert api.calls[0][2] == expected_events()


# --- CLI ----------------------------------------------------------------------
def test_snapshot_cli(cdn, tmp_path, capsys):
    s = cdn(cdn=FIXTURES / "v13")
    out = tmp_path / "prompts"
    args = [
        "snapshot",
        "--app",
        "demo",
        "--out",
        str(out),
        "--key",
        KEY,
        "--cdn",
        s.base + "/v1/d",
        "--origin",
        s.base + "/v1/delivery",
    ]
    assert cli(args) == 0
    assert "revision 13 (4 prompts, workspace acme) from cdn" in capsys.readouterr().out
    with Client(app="demo", snapshot_dir=str(out)) as c:
        assert c.revision == 13
        assert c.get("greeting") == GREETING_V5
    assert cli([*args, "-q"]) == 0
    assert capsys.readouterr().out == ""


def test_snapshot_cli_failures(capsys):
    with pytest.raises(SystemExit) as e:
        cli(["snapshot", "--app", "demo"])
    assert e.value.code == 2
    assert cli([]) == 2
    rc = cli(["snapshot", "--app", "demo", "--out", "x", "--mirror", "http://127.0.0.1:9/x", "--timeout", "0.3"])
    assert rc == 1
    assert "could not load demo/prod" in capsys.readouterr().err
