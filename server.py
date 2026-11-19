import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import re
import ssl

PORT = 8080

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/youtube-search':
            qs = urllib.parse.parse_qs(parsed.query)
            q = qs.get('q', [''])[0].strip()
            if not q:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'[]')
                return

            results = self.search_youtube(q)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(results).encode('utf-8'))
            return

        super().do_GET()

    def search_youtube(self, query):
        url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
        req = urllib.request.Request(
            url,
            headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        )
        try:
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=7) as resp:
                html = resp.read().decode('utf-8', errors='ignore')
                
                match = re.search(r'var ytInitialData\s*=\s*({.*?});</script>', html)
                if not match:
                    match = re.search(r'ytInitialData\s*=\s*({.*?});', html)

                videos = []
                seen_ids = set()

                if match:
                    try:
                        data = json.loads(match.group(1))
                        contents = data.get('contents', {}).get('twoColumnSearchResultsRenderer', {}).get('primaryContents', {}).get('sectionListRenderer', {}).get('contents', [])
                        for section in contents:
                            item_section = section.get('itemSectionRenderer', {}).get('contents', [])
                            for item in item_section:
                                vr = item.get('videoRenderer')
                                if vr and 'videoId' in vr:
                                    vid = vr['videoId']
                                    if vid in seen_ids:
                                        continue
                                    seen_ids.add(vid)
                                    title = vr.get('title', {}).get('runs', [{}])[0].get('text', '')
                                    channel = vr.get('ownerText', {}).get('runs', [{}])[0].get('text', '') or vr.get('longBylineText', {}).get('runs', [{}])[0].get('text', '')
                                    duration = vr.get('lengthText', {}).get('simpleText', '') or ''
                                    thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                                    videos.append({
                                        'videoId': vid,
                                        'title': title,
                                        'artist': channel or 'YouTube Artist',
                                        'duration': duration or '--:--',
                                        'thumbnail': thumb
                                    })
                                    if len(videos) >= 8:
                                        break
                            if len(videos) >= 8:
                                break
                    except Exception as parse_err:
                        print('ytInitialData parse error:', parse_err)

                # Fallback extraction
                if len(videos) < 4:
                    raw_ids = re.findall(r'\"videoRenderer\":\{\"videoId\":\"([a-zA-Z0-9_-]{11})\"', html)
                    for vid in raw_ids:
                        if vid not in seen_ids:
                            seen_ids.add(vid)
                            videos.append({
                                'videoId': vid,
                                'title': f"YouTube Video ({vid})",
                                'artist': 'YouTube Creator',
                                'duration': '--:--',
                                'thumbnail': f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                            })
                            if len(videos) >= 8:
                                break

                return videos
        except Exception as e:
            print(f"Error fetching YouTube search for '{query}':", e)
            return []

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Serving HTTP on port {PORT} with /api/youtube-search...")
        httpd.serve_forever()
