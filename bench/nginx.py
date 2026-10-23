"""Matched-body Nginx native vs QuickJS routing microbenchmark. Requires Docker."""
import hashlib,json,os,pathlib,subprocess,urllib.request,time
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'results'/'nginx';OUT.mkdir(parents=True,exist_ok=True)
DATA=ROOT/'var'/'nginx-bench';DATA.mkdir(parents=True,exist_ok=True)
CLIENT=os.environ.get('BENCH_IMAGE','webhaven-bench')
NAME='webhaven-nginx-benchmark';NET='webhaven-benchmark'
def run(*args):return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.STDOUT)
(DATA/'nginx.conf').write_text('''load_module /usr/lib/nginx/modules/ngx_http_js_module.so;
worker_processes 4;
events { worker_connections 8192; }
http {
 sendfile on; tcp_nopush on; keepalive_timeout 65; keepalive_requests 100000; access_log off; gzip off;
 js_engine qjs; js_import routes from /etc/nginx/routes.js;
 server { listen 8080; location /native/ { alias /data/; } location /quickjs/ { js_content routes.asset; } }
}''')
(DATA/'routes.js').write_text("function asset(r) { r.internalRedirect('/native/' + r.uri.slice('/quickjs/'.length)); } export default { asset };\n")
for size in (1024,65536,1048576):(DATA/f'{size}.bin').write_bytes(bytes(range(256))*(size//256))
created=False;started=False;rows=[]
try:
 run('network','create',NET);created=True
 run('run','--pull=never','--rm','-d','--name',NAME,'--network',NET,'--cpus','4','--memory','256m','-p','127.0.0.1:19080:8080','-v',f'{DATA}:/data:ro','-v',f'{DATA}/nginx.conf:/etc/nginx/nginx.conf:ro','-v',f'{DATA}/routes.js:/etc/nginx/routes.js:ro','nginx:stable');started=True
 time.sleep(1)
 for size in (1024,65536,1048576):
  for mode in ('native','quickjs'):
   with urllib.request.urlopen(f'http://127.0.0.1:19080/{mode}/{size}.bin') as r:
    assert hashlib.sha256(r.read()).digest()==hashlib.sha256((DATA/f'{size}.bin').read_bytes()).digest()
   for repeat in range(3):
    def wrk(duration):return run('run','--pull=never','--rm','--network',NET,'--cpus','2','--memory','256m','-v',f'{ROOT}/bench:/bench:ro','--entrypoint','wrk',CLIENT,'-t2','-c32',f'-d{duration}s','--latency','--timeout','2s','-s','/bench/latency.lua',f'http://{NAME}:8080/{mode}/{size}.bin')
    wrk(1);raw=wrk(3);(OUT/f'{size}-{mode}-{repeat}.txt').write_text(raw)
    metrics={k:int(v) for k,v in __import__('re').findall(r'(\w+)=(\d+)',raw.split('METRICS ')[1])}
    assert not any(metrics[k] for k in ('status_errors','connect_errors','read_errors','write_errors','timeouts')),metrics
    row=dict(size=size,mode=mode,repeat=repeat,concurrency=32,rps=metrics['requests']*1e6/metrics['duration_us'],**metrics);rows.append(row);print(json.dumps(row),flush=True)
 (OUT/'comparison.json').write_text(json.dumps({'scope':'Nginx routing microbenchmark, identical bodies; not full Consumer performance','nginx':run('exec',NAME,'nginx','-V'),'image':run('image','inspect','nginx:stable','--format','{{.Id}}'),'client':run('image','inspect',CLIENT,'--format','{{.Id}}'),'rows':rows},indent=2))
finally:
 if started:run('stop',NAME)
 if created:run('network','rm',NET)
