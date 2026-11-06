#!/usr/bin/env python3
"""Serve the Conductor demo page: python3 server.py → http://localhost:8079/"""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(os.path.join(HERE, "demo.html"), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    print("Conductor demo → http://localhost:8079/")
    ThreadingHTTPServer(("127.0.0.1", 8079), H).serve_forever()
