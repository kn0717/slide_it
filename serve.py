"""Local dev server for Slide It !! that tells the browser never to cache, so
edits to the HTML, CSS and JS show up on a normal refresh.

Usage: python serve.py [port]   (default 8780)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8780
http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
