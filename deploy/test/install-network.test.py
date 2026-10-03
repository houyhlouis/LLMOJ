#!/usr/bin/env python3
"""Validate generated and edited network configuration without starting services."""
import argparse
import base64
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import io
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

import yaml

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_support", DEPLOY / "install-support.py")
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


@unittest.skipUnless(os.geteuid() == 0 and Path("/usr/sbin/nginx").exists(), "root and nginx required")
class LoopbackConfiguration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="libreoj-network-test-", dir="/var/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        (self.root / "config").mkdir()
        for source in (DEPLOY.parent / "config").glob("*.example"):
            shutil.copyfile(source, self.root / "config" / source.name)
        self.args = argparse.Namespace(root=self.root, port=39817, origin="http://127.0.0.1:39817",
                                       listen_address="127.0.0.1")
        subprocess.run(["/usr/bin/python3", str(DEPLOY / "configure-local.py")], check=True,
                       stdout=subprocess.DEVNULL, env={**os.environ, "HYHOJ_ROOT": str(self.root),
                       "HYHOJ_PORT": str(self.args.port), "HYHOJ_PUBLIC_ORIGIN": self.args.origin,
                       "OJ_LISTEN_ADDRESS": self.args.listen_address})
        support.permissions(self.args)
        self.nginx_file = self.root / "config/nginx.conf"
        self.nginx_original = self.nginx_file.read_text()

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()):
            support.verify_network(self.args)

    def test_generated_configuration_uses_only_loopback(self):
        self.verify()
        self.assertIn("listen 127.0.0.1:39817;", self.nginx_original)
        config = yaml.safe_load((self.root / "config/backend.yaml").read_text())
        self.assertEqual(config["preference"]["siteName"], "LLMOJ")

    def test_wildcard_ipv4_and_ipv6_listeners_are_rejected(self):
        for listener in ("39817", "0.0.0.0:39817", "[::]:39817"):
            with self.subTest(listener=listener):
                self.nginx_file.write_text(self.nginx_original.replace("127.0.0.1:39817", listener))
                with self.assertRaises(support.InstallerError):
                    self.verify()

    def test_one_line_public_listener_in_an_include_is_rejected(self):
        include = self.root / "config/extra.conf"
        include.write_text("server { listen 0.0.0.0:39818; }\n")
        self.nginx_file.write_text(self.nginx_original.replace("http {", f"http {{\ninclude {include};"))
        with self.assertRaises(support.InstallerError):
            self.verify()

    def test_edited_backend_public_listener_is_rejected(self):
        file = self.root / "config/backend.yaml"
        config = yaml.safe_load(file.read_text())
        config["server"]["hostname"] = "0.0.0.0"
        file.write_text(yaml.safe_dump(config))
        with self.assertRaises(support.InstallerError):
            self.verify()

    def test_selected_public_listener_is_accepted_without_exposing_internal_services(self):
        self.args.listen_address = "0.0.0.0"
        self.nginx_file.write_text(self.nginx_original.replace("127.0.0.1:39817", "0.0.0.0:39817"))
        self.verify()  # nginx -T only: no listener is started.

    def test_remote_judge_download_endpoint_and_websocket_proxy(self):
        backend = yaml.safe_load((self.root / "config/backend.yaml").read_text())
        judge = backend["services"]["minio"]["forJudge"]
        self.assertEqual(judge["endpoint"], "http://127.0.0.1:19000")
        self.assertEqual(judge["urlEndpoint"], self.args.origin + "/storage/")
        self.assertIn("location /api/socket", self.nginx_original)
        self.assertIn("proxy_set_header Upgrade $http_upgrade", self.nginx_original)
        self.assertIn('"$request_method $uri $server_protocol"', self.nginx_original)
        self.assertNotIn("$request_uri", self.nginx_original)

    def test_web_only_target_does_not_depend_on_judge_or_mounts(self):
        units = self.root / "deploy/systemd"
        (units / "libreoj-judge.service").write_text("[Unit]\nDescription=LibreOJ judge\n")
        (units / "old.mount").write_text("[Unit]\nDescription=LibreOJ judge workspace\n")
        subprocess.run(["/usr/bin/python3", str(DEPLOY / "configure-local.py")], check=True,
                       stdout=subprocess.DEVNULL, env={**os.environ, "HYHOJ_ROOT": str(self.root),
                       "HYHOJ_PORT": str(self.args.port), "HYHOJ_PUBLIC_ORIGIN": self.args.origin,
                       "OJ_LISTEN_ADDRESS": self.args.listen_address, "OJ_INSTALL_ROLE": "web"})
        self.assertNotIn("libreoj-judge.service", (units / "libreoj.target").read_text())
        self.assertFalse((units / "libreoj-judge.service").exists())
        self.assertEqual(list(units.glob("*.mount")), [])

    def test_websocket_upgrade_reaches_backend_without_logging_query_keys(self):
        received = []

        class Backend(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                received.append((self.path, self.headers.get("Upgrade"), self.headers.get("Connection")))
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    self.connection.settimeout(3)
                    accept = base64.b64encode(hashlib.sha1(
                        (self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                    ).digest()).decode()
                    self.send_response(101)
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        backend = HTTPServer(("127.0.0.1", 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(backend.server_close)
        self.addCleanup(backend.shutdown)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.nginx_file.write_text(self.nginx_original
            .replace("127.0.0.1:39817", f"127.0.0.1:{port}")
            .replace("127.0.0.1:2002", f"127.0.0.1:{backend.server_port}"))
        nginx = subprocess.Popen(["/usr/sbin/nginx", "-c", str(self.nginx_file), "-g", "daemon off;"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def stop_nginx():
            nginx.terminate()
            try:
                nginx.wait(timeout=5)
            except subprocess.TimeoutExpired:
                nginx.kill()
                nginx.wait(timeout=5)
        self.addCleanup(stop_nginx)
        for _ in range(100):
            if nginx.poll() is not None:
                self.fail("Temporary Nginx failed to start")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.02)
        else:
            self.fail("Temporary loopback Nginx did not become ready")
        marker = "SYNTHETIC_QUERY_SECRET_ONLY"
        request_path = f"/api/socket/?EIO=4&transport=websocket&key={marker}"
        with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
            client.sendall((f"GET {request_path} HTTP/1.1\r\nHost: localhost\r\n"
                           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                           "Sec-WebSocket-Version: 13\r\n"
                           "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").encode())
            response = client.recv(4096)
            self.assertIn(b"101 Switching Protocols", response)
        self.assertEqual(received[0], (request_path, "websocket", "upgrade"))
        with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
            client.sendall((f"GET /api/test?key={marker} HTTP/1.1\r\n"
                           "Host: localhost\r\nConnection: close\r\n\r\n").encode())
            while client.recv(4096):
                pass
        stop_nginx()
        logs = list((self.root / "logs/nginx").glob("*.log"))
        self.assertTrue(logs)
        self.assertIn("/api/test", (self.root / "logs/nginx/access.log").read_text())
        for log in logs:
            self.assertNotIn(marker, log.read_text())


if __name__ == "__main__":
    unittest.main()
