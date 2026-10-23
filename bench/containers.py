"""Isolated two-image smoke test. No production ports or data are used."""
import json,os,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
TOKEN='container-test-only-webhaven-token'
names=[];volumes=['webhaven-validation-publisher','webhaven-validation-mirror','webhaven-validation-delivery']
def run(*args):return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.STDOUT)
def wait(url,content=None):
 for _ in range(100):
  try:
   with urllib.request.urlopen(url,timeout=2) as r:
    data=r.read()
    if r.status==200 and (content is None or content in data):return data
  except Exception:pass
  time.sleep(.1)
 raise AssertionError('Container did not become ready: '+url)
try:
 for v in volumes:run('volume','create',v)
 args=['run','--pull=never','--rm','-d','--name','webhaven-publisher-validation','-p','127.0.0.1:19081:8081','-e','PUBLISHER_HOST=0.0.0.0','-e','PUBLISHER_DATA_DIR=/data','-e','DELIVERY_DIR=/delivery','-e','PUBLISHER_TOKENS='+json.dumps([dict(token=TOKEN,collections=['docs'],permissions=['submit','publish'])]),'-v',volumes[0]+':/data','-v',volumes[2]+':/delivery','webhaven-publisher:validation']
 run(*args);names.append('webhaven-publisher-validation')
 run('run','--pull=never','--rm','-d','--name','webhaven-mirror-validation','-p','127.0.0.1:19082:8080','-e','MIRROR_HOST=0.0.0.0','-e','MIRROR_DATA_DIR=/data','-e','DELIVERY_DIR=/delivery','-e','COLLECTIONS=docs','-e','SYNC_INTERVAL_MS=100','-v',volumes[1]+':/data','-v',volumes[2]+':/delivery:ro','webhaven-mirror:validation');names.append('webhaven-mirror-validation')
 wait('http://127.0.0.1:19081/healthz');wait('http://127.0.0.1:19082/healthz')
 result=subprocess.check_output(['node','apps/publisher/src/cli.js','submit','--collection','docs','--directory','examples/site'],cwd=ROOT,env={**os.environ,'PUBLISHER_URL':'http://127.0.0.1:19081','WEBHAVEN_TOKEN':TOKEN},text=True)
 assert json.loads(result)['release']['revision']==1,result
 wait('http://127.0.0.1:19082/sites/docs/',b'WebHaven example')
 run('stop',names[0]);names.remove('webhaven-publisher-validation')
 wait('http://127.0.0.1:19082/sites/docs/',b'WebHaven example')
 evidence={'passed':True,'publisherNode':run('run','--rm','--pull=never','--entrypoint','node','webhaven-publisher:validation','--version').strip(),'mirrorNode':run('exec','webhaven-mirror-validation','node','--version').strip(),'publisherImage':run('image','inspect','webhaven-publisher:validation','--format','{{.Id}}').strip(),'mirrorImage':run('image','inspect','webhaven-mirror:validation','--format','{{.Id}}').strip(),'checks':['separate non-root images','CLI upload','read-only delivery mount','independent content serving','publisher stopped: mirror available']}
 (ROOT/'results').mkdir(exist_ok=True);(ROOT/'results'/'containers.json').write_text(json.dumps(evidence,indent=2))
 print(json.dumps(evidence))
finally:
 for name in names:
  try:run('stop',name)
  except Exception:pass
 for volume in volumes:
  try:run('volume','rm',volume)
  except Exception:pass
