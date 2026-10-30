import sys, json, zipfile, xml.etree.ElementTree as E, re
sys.stdout.reconfigure(encoding='utf-8')
from pathlib import Path
file, target, ext = sys.argv[1:]
out=Path(target);out.mkdir(parents=True,exist_ok=True)
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
pages=[]; images=[]
with zipfile.ZipFile(file) as z:
    items=z.infolist()
    if len(items)>4000 or sum(i.file_size for i in items)>128*1024*1024: raise ValueError('文档解压后过大，请拆分文件')
    if ext=='docx':
        root=E.fromstring(z.read('word/document.xml'))
        paragraphs=[''.join(t.text or '' for t in p.findall('.//w:t',ns)) for p in root.findall('.//w:p',ns)]
        text='\n'.join(p for p in paragraphs if p)
        pages=[{'title':'正文提要 '+str(i//4500+1),'text':text[i:i+4500]} for i in range(0,len(text),4500)]
    else:
        slides=sorted([n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)],key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
        for i,n in enumerate(slides[:300]):
            root=E.fromstring(z.read(n));pages.append({'title':'第 '+str(i+1)+' 页文字','text':'\n'.join(t.text or '' for t in root.findall('.//a:t',ns))[:12000]})
    for item in items:
        suffix=Path(item.filename).suffix.lower()
        if '/media/' in item.filename and suffix in ['.png','.jpg','.jpeg','.webp'] and len(images)<100:
            if item.file_size>20*1024*1024:continue
            name='media-'+str(len(images))+suffix
            (out/name).write_bytes(z.read(item));images.append(name)
if len(pages)>300:raise ValueError('文档过长，请拆分后上传')
print(json.dumps({'pages':pages,'images':images,'note':'文字提要与文档图片；完整排版请查看原文件。'},ensure_ascii=False))
