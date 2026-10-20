"""Fake OpenAI-compatible endpoint: records every request goose sends (system prompt, tools) and replies with plain text."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
OUT = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({'object': 'list', 'data': [{'id': 'mock-model', 'object': 'model'}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with open(OUT, 'a') as f: f.write(json.dumps({'path': self.path, 'req': req}) + '\n')
        text = 'OK'
        if req.get('stream'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            for d in ({'role': 'assistant', 'content': text}, {}):
                chunk = {'id': 'x', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'mock-model',
                         'choices': [{'index': 0, 'delta': d, 'finish_reason': None if d else 'stop'}]}
                self.wfile.write(f'data: {json.dumps(chunk)}\n\n'.encode())
            self.wfile.write(b'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"mock-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n')
        else:
            body = json.dumps({'id': 'x', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'mock-model',
                               'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                               'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
